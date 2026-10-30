import { pool, withTransaction } from '../db.js';
import fs from 'node:fs';
import { getApps, initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getMessaging as getFirebaseMessaging } from 'firebase-admin/messaging';

let firebaseConfigured = false;
try {
  if (!getApps().length) {
    const serviceAccountText = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (serviceAccountText) {
      const serviceAccount = JSON.parse(serviceAccountText);
      initializeApp({ credential: cert(serviceAccount) });
      firebaseConfigured = true;
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      initializeApp({ credential: applicationDefault() });
      firebaseConfigured = true;
    }
  } else firebaseConfigured = true;
} catch (error) {
  firebaseConfigured = false;
  console.error(JSON.stringify({ level: 'error', message: 'No se pudo inicializar el servicio de notificaciones. Revisa la configuración del servidor.', errorName: error?.name }));
}

let tickInProgress = false;

async function publishDueAnnouncements() {
  await withTransaction(async (client) => {
    // A scheduled item that expired before publication is expired without being sent.
    await client.query(`UPDATE announcements SET status='EXPIRED',updated_at=now() WHERE status='SCHEDULED' AND expires_at IS NOT NULL AND expires_at <= now()`);
    const due = await client.query(
      `SELECT id,business_id,send_push_notification FROM announcements
       WHERE status='SCHEDULED' AND publish_at <= now() AND (expires_at IS NULL OR expires_at > now())
       ORDER BY publish_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`,
    );
    for (const announcement of due.rows) {
      const updated = await client.query(
        `UPDATE announcements SET status='PUBLISHED',published_at=now(),updated_at=now() WHERE id=$1 AND status='SCHEDULED' RETURNING id`,
        [announcement.id],
      );
      if (!updated.rowCount) continue;
      if (announcement.send_push_notification) {
        await client.query(
          `INSERT INTO push_outbox (business_id,announcement_id,device_id)
           SELECT a.business_id,a.id,pd.id
           FROM announcements a JOIN push_devices pd ON pd.business_id=a.business_id AND pd.active=TRUE
           LEFT JOIN users u ON u.id=pd.user_id
           WHERE a.id=$1 AND (pd.user_id IS NULL OR (u.role='CUSTOMER' AND u.active=TRUE))
           ON CONFLICT (announcement_id,device_id) DO NOTHING`,
          [announcement.id],
        );
        await client.query('UPDATE announcements SET push_enqueued_at=now() WHERE id=$1', [announcement.id]);
      }
      await client.query(
        `INSERT INTO audit_logs (business_id,action,entity_type,entity_id,metadata)
         VALUES ($1,'ANNOUNCEMENT_PUBLISHED','announcement',$2,$3::jsonb)`,
        [announcement.business_id, announcement.id, JSON.stringify({ scheduled: true, pushRequested: announcement.send_push_notification })],
      );
    }
    const expiredPublished = await client.query(`UPDATE announcements SET status='EXPIRED',updated_at=now() WHERE status='PUBLISHED' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id`);
    if (expiredPublished.rowCount) {
      await client.query(`UPDATE push_outbox SET status='DEAD',last_error='Aviso vencido',updated_at=now() WHERE announcement_id = ANY($1::uuid[]) AND status IN ('PENDING','SENDING')`, [expiredPublished.rows.map((row) => row.id)]);
    }
  });
}

async function claimOutboxRow() {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT o.id,o.business_id,o.announcement_id,o.device_id,o.attempts,a.title,a.message,pd.token
       FROM push_outbox o JOIN announcements a ON a.id=o.announcement_id
       JOIN push_devices pd ON pd.id=o.device_id
       WHERE ((o.status='PENDING' AND o.next_attempt_at <= now()) OR (o.status='SENDING' AND o.locked_until < now()))
         AND a.status='PUBLISHED' AND pd.active=TRUE
       ORDER BY o.created_at ASC LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    await client.query(
      `UPDATE push_outbox SET status='SENDING',attempts=attempts+1,locked_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1`, [row.id],
    );
    row.attempts = Number(row.attempts) + 1;
    return row;
  });
}

async function dispatchOutboxRow() {
  if (!firebaseConfigured) return false;
  const row = await claimOutboxRow();
  if (!row) return false;
  try {
    await getFirebaseMessaging().send({
      token: row.token,
      notification: { title: row.title, body: row.message },
      data: { announcementId: row.announcement_id, businessId: row.business_id, type: 'ANNOUNCEMENT' },
      android: { priority: 'high', notification: { channelId: 'cafeteria_announcements', sound: 'default' } },
    });
    await pool.query(`UPDATE push_outbox SET status='SENT',sent_at=now(),locked_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND status='SENDING'`, [row.id]);
  } catch (error) {
    const code = String(error?.code || 'push-error');
    const invalidToken = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code);
    if (invalidToken) {
      await pool.query('UPDATE push_devices SET active=FALSE,updated_at=now() WHERE id=$1', [row.device_id]);
    }
    const maxAttempts = 12;
    const dead = invalidToken || row.attempts >= maxAttempts;
    const retrySeconds = Math.min(3600, 15 * (2 ** Math.min(row.attempts - 1, 8)));
    await pool.query(
      `UPDATE push_outbox SET status=$2,next_attempt_at=now()+($3::int * interval '1 second'),locked_until=NULL,last_error=$4,updated_at=now() WHERE id=$1 AND status='SENDING'`,
      [row.id, dead ? 'DEAD' : 'PENDING', String(retrySeconds), code.slice(0, 120)],
    );
    console.error(JSON.stringify({ level: 'warn', message: 'No se pudo entregar una notificación push.', outboxId: row.id, code, attempt: row.attempts }));
  }
  return true;
}

export async function schedulerTick() {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    await publishDueAnnouncements();
    if (firebaseConfigured) {
      for (let i = 0; i < 30; i += 1) {
        if (!(await dispatchOutboxRow())) break;
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Falló un ciclo del planificador.', errorCode: error?.code, errorName: error?.name }));
  } finally { tickInProgress = false; }
}

export function startScheduler() {
  const interval = Math.max(1000, Number(process.env.SCHEDULER_INTERVAL_MS || 5000));
  const timer = setInterval(() => { void schedulerTick(); }, interval);
  timer.unref();
  void schedulerTick();
  console.log(JSON.stringify({ level: 'info', message: 'Planificador de avisos iniciado.', intervalMs: interval, pushConfigured: firebaseConfigured }));
  return () => clearInterval(timer);
}

export function isPushConfigured() { return firebaseConfigured; }

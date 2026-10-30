import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { optionalAuth, requireAuth, requireRoles } from '../middleware/auth.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { parseIsoOffset, safeString, assertUuid } from '../lib/security.js';
import { resolvePublicBusiness } from '../lib/business.js';
import { insertAudit } from '../lib/business.js';

const router = Router();
function announcementDto(row) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    publishAt: row.publish_at_original || new Date(row.publish_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    status: row.status,
    imageUrl: row.image_path && process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/uploads/${encodeURIComponent(row.image_path)}` : null,
  };
}

router.get('/', optionalAuth, async (req, res) => {
  const includeScheduled = String(req.query.includeScheduled || 'false').toLowerCase() === 'true';
  if (includeScheduled && (!req.auth || req.auth.role !== 'OWNER')) throw new HttpError(403, 'FORBIDDEN', 'Solo la dueña puede consultar avisos programados.');
  const business = req.auth ? { id: req.auth.businessId } : await resolvePublicBusiness(req);
  let result;
  if (includeScheduled) {
    result = await pool.query(
      `SELECT * FROM announcements WHERE business_id=$1 AND status IN ('SCHEDULED','PUBLISHED','CANCELLED','EXPIRED') ORDER BY publish_at DESC LIMIT 300`, [business.id],
    );
  } else {
    result = await pool.query(
      `SELECT * FROM announcements WHERE business_id=$1 AND status='PUBLISHED' AND publish_at <= now() AND (expires_at IS NULL OR expires_at > now()) ORDER BY publish_at DESC LIMIT 100`, [business.id],
    );
  }
  res.json({ data: result.rows.map(announcementDto), message: 'Avisos cargados.' });
});

router.post('/', requireAuth, requireRoles('OWNER'), async (req, res) => {
  const title = safeString(req.body?.title, 'title', { min: 1, max: 140, allowEmpty: false });
  const message = safeString(req.body?.message, 'message', { min: 1, max: 2000, allowEmpty: false });
  const publishAtOriginal = safeString(req.body?.publishAt, 'publishAt', { min: 20, max: 40, allowEmpty: false });
  const publishAt = parseIsoOffset(publishAtOriginal, 'publishAt');
  let expiresAt = null;
  if (req.body?.expiresAt != null && String(req.body.expiresAt).trim() !== '') expiresAt = parseIsoOffset(String(req.body.expiresAt), 'expiresAt');
  if (expiresAt && expiresAt <= publishAt) throw new HttpError(422, 'INVALID_EXPIRATION', 'El vencimiento debe ser posterior a la publicación.');
  const sendPush = req.body?.sendPushNotification == null ? true : req.body.sendPushNotification;
  if (typeof sendPush !== 'boolean') throw new HttpError(422, 'INVALID_FIELD', 'sendPushNotification debe ser verdadero o falso.');
  const row = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO announcements (business_id,title,message,publish_at,publish_at_original,expires_at,status,send_push_notification,author_id)
       VALUES ($1,$2,$3,$4,$5,$6,'SCHEDULED',$7,$8) RETURNING *`,
      [req.auth.businessId, title, message, publishAt, publishAtOriginal, expiresAt, sendPush, req.auth.userId],
    );
    await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'ANNOUNCEMENT_CREATED', entityType: 'announcement', entityId: inserted.rows[0].id, metadata: { title, publishAt: publishAtOriginal, expiresAt: expiresAt?.toISOString() || null, sendPushNotification: sendPush } });
    return inserted.rows[0];
  });
  res.status(201).json({ data: announcementDto(row), message: 'Aviso programado.' });
});

router.patch('/:id/cancel', requireAuth, requireRoles('OWNER'), async (req, res) => {
  assertUuid(req.params.id, 'aviso');
  const updated = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE announcements SET status='CANCELLED',updated_at=now() WHERE id=$1 AND business_id=$2 AND status IN ('SCHEDULED','PUBLISHED') RETURNING *`,
      [req.params.id, req.auth.businessId],
    );
    if (!result.rowCount) throw notFound('No se encontró un aviso que pueda cancelarse.');
    await client.query(`UPDATE push_outbox SET status='DEAD',updated_at=now(),last_error='Aviso cancelado' WHERE announcement_id=$1 AND status IN ('PENDING','SENDING')`, [req.params.id]);
    await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'ANNOUNCEMENT_CANCELLED', entityType: 'announcement', entityId: req.params.id, metadata: { title: result.rows[0].title } });
    return result.rows[0];
  });
  res.json({ data: true, message: 'Aviso cancelado.' });
});

export default router;

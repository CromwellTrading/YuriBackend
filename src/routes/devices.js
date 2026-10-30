import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { HttpError, conflict } from '../lib/errors.js';
import { safeString } from '../lib/security.js';
import { resolvePublicBusiness } from '../lib/business.js';

const router = Router();

router.post('/push-token', optionalAuth, async (req, res) => {
  const token = safeString(req.body?.token, 'token', { min: 40, max: 4096, allowEmpty: false });
  const deviceId = safeString(req.body?.deviceId, 'deviceId', { min: 1, max: 200, allowEmpty: false });
  const platform = safeString(req.body?.platform || 'ANDROID', 'platform', { min: 1, max: 20, allowEmpty: false });
  if (platform !== 'ANDROID') throw new HttpError(422, 'INVALID_PLATFORM', 'La plataforma del dispositivo no es válida.');
  if (req.auth && !['OWNER', 'WORKER', 'CUSTOMER'].includes(req.auth.role)) throw new HttpError(403, 'FORBIDDEN', 'Esta cuenta no puede registrar notificaciones.');
  const business = req.auth ? { id: req.auth.businessId } : await resolvePublicBusiness(req);
  const userId = req.auth?.userId || null;

  await withTransaction(async (client) => {
    const existingToken = await client.query('SELECT id,business_id,user_id,device_id FROM push_devices WHERE token=$1 FOR UPDATE', [token]);
    if (existingToken.rowCount && existingToken.rows[0].business_id !== business.id) {
      throw conflict('TOKEN_BOUND_TO_OTHER_BUSINESS', 'Este teléfono ya tiene un registro de notificaciones asociado a otra cafetería.');
    }
    const existingDevice = await client.query('SELECT id,business_id,user_id,token FROM push_devices WHERE business_id=$1 AND device_id=$2 FOR UPDATE', [business.id, deviceId]);
    if (!req.auth && ((existingToken.rowCount && existingToken.rows[0].user_id != null) || (existingDevice.rowCount && existingDevice.rows[0].user_id != null))) {
      throw conflict('DEVICE_REQUIRES_AUTH', 'Inicia sesión en la cuenta que tiene asociado este dispositivo para actualizar sus notificaciones.');
    }
    // FCM tokens rotate. Keep only the latest token for this physical device and business.
    await client.query('DELETE FROM push_devices WHERE business_id=$1 AND (device_id=$2 OR token=$3)', [business.id, deviceId, token]);
    await client.query(
      `INSERT INTO push_devices (business_id,user_id,token,device_id,platform,active,last_seen_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,TRUE,now(),now())`,
      [business.id, userId, token, deviceId, platform],
    );
  });
  res.json({ data: true, message: 'Dispositivo registrado para notificaciones.' });
});

router.post('/push-token/revoke', optionalAuth, async (req, res) => {
  const deviceId = safeString(req.body?.deviceId, 'deviceId', { min: 1, max: 200, allowEmpty: false });
  const business = req.auth ? { id: req.auth.businessId } : await resolvePublicBusiness(req);
  await pool.query(
    `UPDATE push_devices SET active=FALSE,updated_at=now() WHERE business_id=$1 AND device_id=$2 AND (($3::uuid IS NULL AND user_id IS NULL) OR ($3::uuid IS NOT NULL AND user_id=$3))`,
    [business.id, deviceId, req.auth?.userId || null],
  );
  res.json({ data: true, message: 'Notificaciones desactivadas para este dispositivo.' });
});

export default router;

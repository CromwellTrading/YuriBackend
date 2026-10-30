import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { safeString, normalizeIdentifier, assertUuid } from '../lib/security.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { insertAudit } from '../lib/business.js';

const router = Router();
function memberDto(row) {
  return { id: row.id, displayName: row.display_name, identifier: row.identifier, role: row.role, active: Boolean(row.active) };
}

router.get('/', requireAuth, requireRoles('OWNER'), async (req, res) => {
  const result = await pool.query(
    `SELECT id,display_name,identifier,role,active FROM users WHERE business_id=$1 AND role='WORKER' ORDER BY active DESC,display_name ASC`,
    [req.auth.businessId],
  );
  res.json({ data: result.rows.map(memberDto), message: 'Equipo cargado.' });
});

router.post('/', requireAuth, requireRoles('OWNER'), async (req, res) => {
  const displayName = safeString(req.body?.displayName, 'displayName', { min: 1, max: 100, allowEmpty: false });
  const identifier = safeString(req.body?.identifier, 'identifier', { min: 3, max: 180, allowEmpty: false });
  const password = req.body?.temporaryPassword;
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(422, 'WEAK_PASSWORD', 'La contraseña inicial debe tener al menos 8 caracteres.');
  }
  if (req.body?.role != null && req.body.role !== 'WORKER') throw new HttpError(422, 'INVALID_ROLE', 'Desde esta pantalla solo se pueden crear cuentas de trabajadoras.');
  const identifierNorm = normalizeIdentifier(identifier);
  const passwordHash = await bcrypt.hash(password, 12);
  const created = await withTransaction(async (client) => {
    let result;
    try {
      result = await client.query(
        `INSERT INTO users (business_id,display_name,identifier,identifier_norm,password_hash,role)
         VALUES ($1,$2,$3,$4,$5,'WORKER') RETURNING id,display_name,identifier,role,active`,
        [req.auth.businessId, displayName, identifier, identifierNorm, passwordHash],
      );
    } catch (error) {
      if (error.code === '23505') throw conflict('IDENTIFIER_IN_USE', 'Ese usuario ya existe en esta cafetería.');
      throw error;
    }
    await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'WORKER_CREATED', entityType: 'user', entityId: result.rows[0].id, metadata: { identifier, displayName } });
    return result.rows[0];
  });
  res.status(201).json({ data: memberDto(created), message: 'Trabajadora creada.' });
});

router.patch('/:id/status', requireAuth, requireRoles('OWNER'), async (req, res) => {
  assertUuid(req.params.id, 'trabajadora');
  if (typeof req.body?.active !== 'boolean') throw new HttpError(422, 'INVALID_STATUS', 'Indica si la cuenta debe estar activa.');
  const updated = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE users SET active=$3,updated_at=now() WHERE id=$1 AND business_id=$2 AND role='WORKER' RETURNING id,display_name,identifier,role,active`,
      [req.params.id, req.auth.businessId, req.body.active],
    );
    if (!result.rowCount) throw notFound('No se encontró la trabajadora.');
    if (!req.body.active) await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [req.params.id]);
    await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: req.body.active ? 'WORKER_ACTIVATED' : 'WORKER_DEACTIVATED', entityType: 'user', entityId: req.params.id, metadata: { active: req.body.active } });
    return result.rows[0];
  });
  res.json({ data: memberDto(updated), message: req.body.active ? 'Cuenta activada.' : 'Cuenta desactivada y sesiones cerradas.' });
});

export default router;

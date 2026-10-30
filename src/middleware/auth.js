import { pool } from '../db.js';
import { hashToken } from '../lib/security.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export async function optionalAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return next();
    const token = header.slice(7).trim();
    if (!token || token.length > 256) return next();
    const result = await pool.query(
      `SELECT s.id AS session_id, u.id AS user_id, u.business_id, u.display_name, u.identifier,
              u.role, u.active AS user_active, b.name AS business_name, b.slug AS business_slug,
              b.time_zone AS business_time_zone, b.active AS business_active
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN businesses b ON b.id = u.business_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    if (result.rowCount !== 1) return next();
    const row = result.rows[0];
    if (!row.user_active || !row.business_active) return next();
    req.auth = {
      sessionId: row.session_id,
      userId: row.user_id,
      businessId: row.business_id,
      displayName: row.display_name,
      identifier: row.identifier,
      role: row.role,
      businessName: row.business_name,
      businessSlug: row.business_slug,
      businessTimeZone: row.business_time_zone,
      tokenHash: hashToken(token),
      accessToken: token,
    };
    // Last-use is informational; it must not block the request if it races with revocation.
    pool.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [row.session_id]).catch(() => {});
    next();
  } catch (error) { next(error); }
}

export function requireAuth(req, _res, next) {
  if (!req.auth) return next(unauthorized());
  next();
}

export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden());
    next();
  };
}

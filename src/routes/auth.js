import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';
import { createAccessToken, hashToken, normalizeIdentifier, safeString, validateTimeZone } from '../lib/security.js';
import { unauthorized, conflict, forbidden, HttpError } from '../lib/errors.js';
import { resolvePublicBusiness } from '../lib/business.js';
import { requireAuth } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

const router = Router();
const loginLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  limit: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { data: null, message: 'Demasiados intentos. Espera un momento antes de volver a intentarlo.', code: 'LOGIN_RATE_LIMITED' },
});
const customerRegistrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.CUSTOMER_REGISTER_RATE_LIMIT_MAX || 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { data: null, message: 'Se alcanzó el límite temporal de registros desde esta conexión. Inténtalo más tarde.', code: 'CUSTOMER_REGISTER_RATE_LIMITED' },
});

function authDto(user, accessToken) {
  return {
    accessToken,
    userId: user.id,
    displayName: user.display_name,
    role: user.role,
    businessId: user.business_id,
    businessTimeZone: user.time_zone || 'America/Havana',
  };
}

async function issueSession(user, req) {
  const token = createAccessToken();
  const days = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
  const tokenHash = hashToken(token);
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1,$2,now() + ($3::int * interval '1 day'),$4,$5)`,
    [user.id, tokenHash, days, String(req.get('user-agent') || '').slice(0, 300) || null, req.ip || null],
  );
  return token;
}

router.post('/login', loginLimiter, async (req, res) => {
  // Staff and owner accounts continue using their existing nick/identifier login.
  // Customers created by the public app use /customer-login with their visible name.
  const identifier = safeString(req.body?.identifier, 'identifier', { min: 3, max: 180, allowEmpty: false });
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 200) throw unauthorized('El usuario o la contraseña no son correctos.');
  const normalized = normalizeIdentifier(identifier);
  const configuredSlug = String(process.env.PUBLIC_BUSINESS_SLUG || '').trim().toLowerCase();
  const requestedSlug = String(req.get('x-business-slug') || '').trim().toLowerCase();
  if (configuredSlug && requestedSlug && configuredSlug !== requestedSlug) throw conflict('BUSINESS_SELECTION_REQUIRED', 'Esta instalación no corresponde a la cafetería solicitada.');
  const slug = configuredSlug || requestedSlug;
  let result;
  if (slug) {
    result = await pool.query(
      `SELECT u.*, b.time_zone, b.active AS business_active FROM users u JOIN businesses b ON b.id=u.business_id
       WHERE u.identifier_norm=$1 AND b.slug=$2 AND u.active=TRUE AND b.active=TRUE LIMIT 1`, [normalized, slug],
    );
  } else {
    result = await pool.query(
      `SELECT u.*, b.time_zone, b.active AS business_active FROM users u JOIN businesses b ON b.id=u.business_id
       WHERE u.identifier_norm=$1 AND u.active=TRUE AND b.active=TRUE ORDER BY u.created_at LIMIT 2`, [normalized],
    );
    if (result.rowCount > 1) throw conflict('BUSINESS_SELECTION_REQUIRED', 'Indica qué cafetería corresponde a esta cuenta.');
  }
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw unauthorized('El usuario o la contraseña no son correctos.');
  if (!validateTimeZone(user.time_zone)) throw new HttpError(500, 'BUSINESS_TIME_ZONE_INVALID', 'La configuración horaria del negocio necesita revisión.');
  const token = await issueSession(user, req);
  res.json({ data: authDto(user, token), message: 'Sesión iniciada.' });
});

router.post('/register-customer', customerRegistrationLimiter, async (req, res) => {
  const business = await resolvePublicBusiness(req);
  const displayName = safeString(req.body?.displayName, 'displayName', { min: 1, max: 100, allowEmpty: false });
  const identifier = safeString(req.body?.identifier, 'identifier', { min: 3, max: 180, allowEmpty: false });
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    throw new HttpError(422, 'WEAK_PASSWORD', 'La contraseña debe tener al menos 10 caracteres.');
  }
  const identifierNorm = normalizeIdentifier(identifier);
  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try {
    const inserted = await pool.query(
      `INSERT INTO users (business_id, display_name, identifier, identifier_norm, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,'CUSTOMER')
       RETURNING id, business_id, display_name, identifier, role`,
      [business.id, displayName, identifier, identifierNorm, passwordHash],
    );
    user = { ...inserted.rows[0], time_zone: business.time_zone };
  } catch (error) {
    if (error.code === '23505') throw conflict('IDENTIFIER_IN_USE', 'Ese usuario ya está registrado en esta cafetería.');
    throw error;
  }
  const accessToken = await issueSession(user, req);
  res.status(201).json({ data: authDto(user, accessToken), message: 'Cuenta de cliente creada.' });
});

// Customers use their visible name and password. The database identifier is an opaque unique
// value, so customers can share names without collisions with other customers or staff.
router.post('/customer-login', loginLimiter, async (req, res) => {
  const business = await resolvePublicBusiness(req);
  const displayName = safeString(req.body?.displayName, 'displayName', { min: 1, max: 100, allowEmpty: false });
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
    throw unauthorized('El nombre o la contraseña no son correctos.');
  }
  const candidates = await pool.query(
    `SELECT u.*, b.time_zone FROM users u JOIN businesses b ON b.id=u.business_id
     WHERE u.business_id=$1 AND lower(trim(u.display_name))=lower(trim($2))
       AND u.role='CUSTOMER' AND u.active=TRUE AND b.active=TRUE
     ORDER BY u.created_at DESC LIMIT 25`,
    [business.id, displayName],
  );
  let user = null;
  for (const candidate of candidates.rows) {
    if (await bcrypt.compare(password, candidate.password_hash)) { user = candidate; break; }
  }
  if (!user) throw unauthorized('El nombre o la contraseña no son correctos.');
  const accessToken = await issueSession(user, req);
  res.json({ data: authDto(user, accessToken), message: 'Sesión de cliente iniciada.' });
});

router.post('/logout', requireAuth, async (req, res) => {
  await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [req.auth.sessionId]);
  res.json({ data: true, message: 'Sesión cerrada.' });
});

router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.business_id, u.display_name, u.role, b.time_zone
     FROM users u JOIN businesses b ON b.id=u.business_id
     WHERE u.id=$1 AND u.active=TRUE AND b.active=TRUE`, [req.auth.userId],
  );
  if (!result.rowCount) throw unauthorized();
  res.json({ data: authDto(result.rows[0], req.auth.accessToken) , message: 'Sesión válida.' });
});

export default router;

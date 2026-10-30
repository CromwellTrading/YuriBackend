import crypto from 'node:crypto';
import { HttpError } from './errors.js';

export function createAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function assertUuid(value, field = 'id') {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new HttpError(422, 'INVALID_ID', `El identificador de ${field} no es válido.`);
  }
  return text;
}

export function normalizeIdentifier(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}
export function assertSafeInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(422, 'INVALID_FIELD', `El campo ${field} no tiene un valor válido.`);
  }
  return value;
}
export function parseIsoOffset(value, field = 'fecha') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new HttpError(422, 'INVALID_TIMESTAMP', `El campo ${field} debe ser una fecha ISO-8601 con zona horaria.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(422, 'INVALID_TIMESTAMP', `El campo ${field} no es una fecha válida.`);
  }
  return date;
}
export function validateTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length > 80) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date()); return true; }
  catch { return false; }
}
export function safeString(value, field, { min = 0, max = 2000, allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw new HttpError(422, 'INVALID_FIELD', `El campo ${field} debe ser texto.`);
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length < Math.max(1, min)) || trimmed.length < min || trimmed.length > max) {
    throw new HttpError(422, 'INVALID_FIELD', `El campo ${field} debe tener entre ${min} y ${max} caracteres.`);
  }
  return trimmed;
}

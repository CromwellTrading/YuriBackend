import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessToken, hashToken, normalizeIdentifier, parseIsoOffset, validateTimeZone } from '../src/lib/security.js';
import { HttpError } from '../src/lib/errors.js';

test('tokens de sesión son aleatorios y solo su hash debe almacenarse', () => {
  const a = createAccessToken();
  const b = createAccessToken();
  assert.equal(a.length > 32, true);
  assert.notEqual(a, b);
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
});

test('normalización de identificadores evita diferencias de mayúsculas y espacios', () => {
  assert.equal(normalizeIdentifier('  Dueña@Ejemplo.com '), 'dueña@ejemplo.com');
});

test('fechas con offset se aceptan y fechas ambiguas se rechazan', () => {
  assert.doesNotThrow(() => parseIsoOffset('2026-10-29T09:30:00-04:00'));
  assert.throws(() => parseIsoOffset('2026-10-29 09:30:00'), (error) => error instanceof HttpError && error.code === 'INVALID_TIMESTAMP');
});

test('validación de zona horaria IANA', () => {
  assert.equal(validateTimeZone('America/Havana'), true);
  assert.equal(validateTimeZone('cualquier-ciudad'), false);
});

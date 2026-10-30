import { pool } from '../db.js';
import { conflict, notFound } from './errors.js';

export async function resolvePublicBusiness(req, queryable = pool) {
  const configuredSlug = String(process.env.PUBLIC_BUSINESS_SLUG || '').trim().toLowerCase();
  const requestedSlug = String(req.get('x-business-slug') || '').trim().toLowerCase();
  const slug = configuredSlug || requestedSlug;
  if (configuredSlug && requestedSlug && requestedSlug !== configuredSlug) {
    throw conflict('BUSINESS_SELECTION_REQUIRED', 'Esta instalación no corresponde al negocio solicitado.');
  }
  if (slug) {
    const result = await queryable.query('SELECT id, name, slug, time_zone, active FROM businesses WHERE slug=$1 AND active=TRUE', [slug]);
    if (!result.rowCount) throw notFound('No se encontró la cafetería solicitada.');
    return result.rows[0];
  }
  const result = await queryable.query('SELECT id, name, slug, time_zone, active FROM businesses WHERE active=TRUE ORDER BY created_at ASC LIMIT 2');
  if (!result.rowCount) throw notFound('Todavía no hay una cafetería configurada.');
  if (result.rowCount > 1) throw conflict('BUSINESS_SELECTION_REQUIRED', 'Este servidor tiene varias cafeterías. Configura PUBLIC_BUSINESS_SLUG o envía el encabezado X-Business-Slug.');
  return result.rows[0];
}

export function businessForRequest(req, publicBusiness) {
  return req.auth?.businessId || publicBusiness?.id || null;
}

export async function insertAudit(client, { businessId, actorId = null, action, entityType, entityId = null, metadata = {} }) {
  await client.query(
    `INSERT INTO audit_logs (business_id, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [businessId, actorId, action, entityType, entityId, JSON.stringify(metadata)],
  );
}

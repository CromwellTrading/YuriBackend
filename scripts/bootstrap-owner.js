import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../src/db.js';
import { normalizeIdentifier, validateTimeZone } from '../src/lib/security.js';

const name = String(process.env.BOOTSTRAP_BUSINESS_NAME || '').trim();
const ownerName = String(process.env.BOOTSTRAP_OWNER_NAME || '').trim();
const identifier = String(process.env.BOOTSTRAP_OWNER_IDENTIFIER || '').trim();
const password = String(process.env.BOOTSTRAP_OWNER_PASSWORD || '');
const timezone = String(process.env.BUSINESS_TIME_ZONE || 'America/Havana').trim();
const slug = String(process.env.BOOTSTRAP_BUSINESS_SLUG || name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).toLowerCase();

function abort(message) { console.error(message); process.exitCode = 1; }
try {
  if (name.length < 2 || name.length > 120) throw new Error('Define BOOTSTRAP_BUSINESS_NAME (2–120 caracteres).');
  if (ownerName.length < 1 || ownerName.length > 100) throw new Error('Define BOOTSTRAP_OWNER_NAME.');
  if (identifier.length < 3 || identifier.length > 180) throw new Error('Define BOOTSTRAP_OWNER_IDENTIFIER (al menos 3 caracteres).');
  if (password.length < 12 || password.length > 200) throw new Error('BOOTSTRAP_OWNER_PASSWORD debe tener al menos 12 caracteres.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('BOOTSTRAP_BUSINESS_SLUG solo puede contener minúsculas, números y guiones.');
  if (!validateTimeZone(timezone)) throw new Error('BUSINESS_TIME_ZONE debe ser una zona horaria IANA válida, por ejemplo America/Havana.');

  const passwordHash = await bcrypt.hash(password, 12);
  const outcome = await withTransaction(async (client) => {
    const existingBusiness = await client.query('SELECT id FROM businesses WHERE slug=$1 FOR UPDATE', [slug]);
    let businessId;
    if (existingBusiness.rowCount) {
      businessId = existingBusiness.rows[0].id;
      const owners = await client.query("SELECT count(*)::int AS count FROM users WHERE business_id=$1 AND role='OWNER'", [businessId]);
      if (owners.rows[0].count > 0) throw new Error('Esta cafetería ya tiene una dueña. No se modificó ninguna contraseña ni usuario.');
    } else {
      const created = await client.query('INSERT INTO businesses (name,slug,time_zone) VALUES ($1,$2,$3) RETURNING id', [name, slug, timezone]);
      businessId = created.rows[0].id;
    }
    const user = await client.query(
      `INSERT INTO users (business_id,display_name,identifier,identifier_norm,password_hash,role)
       VALUES ($1,$2,$3,$4,$5,'OWNER') RETURNING id,identifier,display_name`,
      [businessId, ownerName, identifier, normalizeIdentifier(identifier), passwordHash],
    );
    return { businessId, user: user.rows[0] };
  });
  console.log(JSON.stringify({ message: 'Dueña inicial creada.', businessId: outcome.businessId, businessSlug: slug, ownerId: outcome.user.id, ownerIdentifier: outcome.user.identifier, note: 'La contraseña no se muestra ni se guarda en texto plano.' }, null, 2));
} catch (error) {
  abort(error.message);
} finally {
  await pool.end();
}

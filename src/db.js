import pg from 'pg';

const { Pool, types } = pg;
// The API only accepts safe-integer stock and monetary amounts.
types.setTypeParser(20, (value) => Number(value));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Falta DATABASE_URL. Configura la base de datos antes de iniciar el servidor.');
}

const sslEnabled = process.env.DATABASE_SSL === 'true';
export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: sslEnabled ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  application_name: 'cafeteria-backend',
});

pool.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', message: 'Error inesperado en conexión PostgreSQL', code: error.code }));
});

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

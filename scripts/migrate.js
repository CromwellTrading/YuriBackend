import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');
const client = await pool.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const filenames = (await fs.readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const filename of filenames) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
    if (applied.rowCount) {
      console.log(`Ya aplicada: ${filename}`);
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    console.log(`Aplicando: ${filename}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('Migraciones completadas.');
} catch (error) {
  console.error(`Error aplicando migraciones: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

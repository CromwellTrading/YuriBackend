import 'dotenv/config';
import app from './app.js';
import { pool } from './db.js';
import { startScheduler } from './services/scheduler.js';

const port = Math.max(1, Number(process.env.PORT || 3000));

try {
  const schema = await pool.query("SELECT to_regclass('public.businesses') AS businesses, to_regclass('public.products') AS products, to_regclass('public.sales') AS sales");
  if (!schema.rows[0].businesses || !schema.rows[0].products || !schema.rows[0].sales) {
    throw new Error('Las migraciones de la base de datos no están aplicadas. Ejecuta npm run migrate.');
  }
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', message: 'Backend de cafetería iniciado.', port, environment: process.env.NODE_ENV || 'development' }));
  });
  const stopScheduler = startScheduler();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', message: 'Cerrando servicio.', signal }));
    stopScheduler();
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
} catch (error) {
  console.error(JSON.stringify({ level: 'fatal', message: 'No se pudo iniciar el backend. Verifica DATABASE_URL, la conexión y que las migraciones estén aplicadas.', errorCode: error?.code, errorName: error?.name }));
  await pool.end().catch(() => {});
  process.exit(1);
}

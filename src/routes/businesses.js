import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();
router.get('/', async (_req, res) => {
  const result = await pool.query('SELECT id,name,slug,time_zone AS "timeZone" FROM businesses WHERE active=TRUE ORDER BY name ASC LIMIT 100');
  res.json({ data: result.rows, message: 'Cafeterías disponibles.' });
});
export default router;

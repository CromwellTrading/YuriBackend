import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { parseIsoOffset } from '../lib/security.js';
import { HttpError } from '../lib/errors.js';

const router = Router();

router.get('/', requireAuth, requireRoles('OWNER'), async (req, res) => {
  const businessResult = await pool.query('SELECT time_zone FROM businesses WHERE id=$1 AND active=TRUE', [req.auth.businessId]);
  if (!businessResult.rowCount) throw new HttpError(404, 'BUSINESS_NOT_FOUND', 'No se encontró la cafetería.');
  const zone = businessResult.rows[0].time_zone;
  let from = req.query.from ? parseIsoOffset(String(req.query.from), 'from') : null;
  let to = req.query.to ? parseIsoOffset(String(req.query.to), 'to') : null;
  if (from && to && from >= to) throw new HttpError(422, 'INVALID_DATE_RANGE', 'La fecha inicial debe ser anterior a la fecha final.');
  const salesResult = await pool.query(
    `WITH bounds AS (
       SELECT COALESCE($2::timestamptz, date_trunc('day', now() AT TIME ZONE $4) AT TIME ZONE $4) AS start_at,
              COALESCE($3::timestamptz, (date_trunc('day', now() AT TIME ZONE $4) + interval '1 day') AT TIME ZONE $4) AS end_at
     )
     SELECT COALESCE(SUM(s.total_cup) FILTER (WHERE s.payment_method='CASH_CUP' AND s.status='ACCEPTED'),0)::bigint AS cash_cup,
            COALESCE(SUM(s.total_cup) FILTER (WHERE s.payment_method='TRANSFER_CUP' AND s.status='ACCEPTED'),0)::bigint AS transfer_cup,
            COUNT(*) FILTER (WHERE s.status='ACCEPTED')::int AS sale_count
     FROM bounds x LEFT JOIN sales s ON s.business_id=$1 AND s.sold_at >= x.start_at AND s.sold_at < x.end_at`,
    [req.auth.businessId, from, to, zone],
  );
  const stockResult = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE NOT (p.sale_mode='SUBUNIT' AND p.subunits_per_unit IS NULL AND p.stock_units=0) AND CASE WHEN p.subunits_per_unit IS NOT NULL AND p.sale_mode IN ('SUBUNIT','BOTH') THEN (p.stock_units*p.subunits_per_unit + COALESCE(p.stock_subunits,0)) <= p.minimum_stock*p.subunits_per_unit ELSE p.stock_units <= p.minimum_stock END)::int AS low_stock_count,
      COALESCE(bool_and(
        CASE WHEN p.sale_mode='SUBUNIT' AND p.subunits_per_unit IS NULL AND p.stock_units=0 THEN TRUE
        WHEN p.sale_mode IN ('SUBUNIT','BOTH') THEN
          (p.subunits_per_unit IS NOT NULL AND p.stock_subunits IS NOT NULL AND p.subunit_price_cup IS NOT NULL AND
           (p.sale_mode='SUBUNIT' OR p.unit_price_cup IS NOT NULL))
        ELSE p.unit_price_cup IS NOT NULL END
      ), TRUE) AS exact_cash,
      COALESCE(bool_and(
        CASE WHEN p.sale_mode='SUBUNIT' AND p.subunits_per_unit IS NULL AND p.stock_units=0 THEN TRUE
        WHEN p.sale_mode IN ('SUBUNIT','BOTH') THEN
          (p.subunits_per_unit IS NOT NULL AND p.stock_subunits IS NOT NULL AND p.subunit_price_transfer IS NOT NULL AND
           (p.sale_mode='SUBUNIT' OR p.unit_price_transfer IS NOT NULL))
        ELSE p.unit_price_transfer IS NOT NULL END
      ), TRUE) AS exact_transfer,
      COALESCE(SUM(CASE WHEN p.sale_mode='SUBUNIT' AND p.subunits_per_unit IS NULL AND p.stock_units=0 THEN 0
                        WHEN p.sale_mode='UNIT' THEN p.stock_units*p.unit_price_cup
                        WHEN p.sale_mode='SUBUNIT' THEN (p.stock_units*p.subunits_per_unit + p.stock_subunits)*p.subunit_price_cup
                        ELSE p.stock_units*p.unit_price_cup + p.stock_subunits*p.subunit_price_cup END),0)::bigint AS value_cash,
      COALESCE(SUM(CASE WHEN p.sale_mode='SUBUNIT' AND p.subunits_per_unit IS NULL AND p.stock_units=0 THEN 0
                        WHEN p.sale_mode='UNIT' THEN p.stock_units*p.unit_price_transfer
                        WHEN p.sale_mode='SUBUNIT' THEN (p.stock_units*p.subunits_per_unit + p.stock_subunits)*p.subunit_price_transfer
                        ELSE p.stock_units*p.unit_price_transfer + p.stock_subunits*p.subunit_price_transfer END),0)::bigint AS value_transfer
     FROM products p WHERE p.business_id=$1 AND p.active=TRUE`, [req.auth.businessId],
  );
  const stock = stockResult.rows[0];
  // With unknown yield, it is not possible to value the remaining subunits inside containers exactly.
  const unknownYield = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM products p WHERE p.business_id=$1 AND p.active=TRUE AND p.sale_mode IN ('SUBUNIT','BOTH') AND p.subunits_per_unit IS NULL AND NOT (p.sale_mode='SUBUNIT' AND p.stock_units=0)) AS has_unknown_yield`,
    [req.auth.businessId],
  );
  res.json({ data: {
    cashCup: Number(salesResult.rows[0].cash_cup),
    transferCup: Number(salesResult.rows[0].transfer_cup),
    saleCount: Number(salesResult.rows[0].sale_count),
    lowStockCount: Number(stock.low_stock_count),
    totalInventoryValueCash: stock.exact_cash && !unknownYield.rows[0].has_unknown_yield ? Number(stock.value_cash) : null,
    totalInventoryValueTransfer: stock.exact_transfer && !unknownYield.rows[0].has_unknown_yield ? Number(stock.value_transfer) : null,
  }, message: 'Estadísticas cargadas.' });
});

export default router;

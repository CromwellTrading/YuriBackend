import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { safeString, assertSafeInteger, assertUuid } from '../lib/security.js';
import { calculateAfterAdjustment } from '../lib/stock.js';
import { insertAudit } from '../lib/business.js';
import { productDto } from './product-shared.js';

const router = Router();

router.post('/adjustments', requireAuth, requireRoles('OWNER'), async (req, res) => {
  const productId = assertUuid(req.body?.productId, 'producto');
  const unitDelta = assertSafeInteger(Number(req.body?.unitDelta), 'unitDelta', { min: -9_000_000_000_000, max: 9_000_000_000_000 });
  let subunitDelta = req.body?.subunitDelta;
  if (subunitDelta !== null && subunitDelta !== undefined) {
    subunitDelta = assertSafeInteger(Number(subunitDelta), 'subunitDelta', { min: -9_000_000_000_000, max: 9_000_000_000_000 });
  } else subunitDelta = null;
  const reason = safeString(req.body?.reason, 'reason', { min: 3, max: 500, allowEmpty: false });
  if (unitDelta === 0 && (subunitDelta == null || subunitDelta === 0)) throw new HttpError(422, 'EMPTY_ADJUSTMENT', 'El ajuste debe modificar alguna cantidad.');
  const row = await withTransaction(async (client) => {
    const found = await client.query('SELECT * FROM products WHERE id=$1 AND business_id=$2 AND active=TRUE FOR UPDATE', [productId, req.auth.businessId]);
    if (!found.rowCount) throw notFound('No se encontró el producto activo.');
    const product = found.rows[0];
    const next = calculateAfterAdjustment(product, unitDelta, subunitDelta);
    const updated = await client.query(
      `UPDATE products SET stock_units=$3,stock_subunits=$4,updated_at=now(),updated_by=$5 WHERE id=$1 AND business_id=$2 RETURNING *`,
      [product.id, req.auth.businessId, next.units, next.subunits, req.auth.userId],
    );
    await client.query(
      `INSERT INTO inventory_movements (business_id,product_id,movement_type,unit_delta,subunit_delta,previous_units,previous_subunits,new_units,new_subunits,actor_id,reason)
       VALUES ($1,$2,'ADJUSTMENT',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.auth.businessId, product.id, unitDelta, subunitDelta, product.stock_units, product.stock_subunits, next.units, next.subunits, req.auth.userId, reason],
    );
    await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'INVENTORY_ADJUSTED', entityType: 'product', entityId: product.id, metadata: { unitDelta, subunitDelta, previousUnits: product.stock_units, previousSubunits: product.stock_subunits, newUnits: next.units, newSubunits: next.subunits, reason } });
    return updated.rows[0];
  });
  res.json({ data: productDto(row, req), message: 'Existencias actualizadas.' });
});

export default router;

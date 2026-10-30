import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertSafeInteger, parseIsoOffset, safeString, validateTimeZone, assertUuid } from '../lib/security.js';
import { calculateAfterSale, calculateInventoryMovementDelta } from '../lib/stock.js';
import { insertAudit } from '../lib/business.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_METHODS = new Set(['CASH_CUP', 'TRANSFER_CUP']);
const MAX_MONEY = 9_000_000_000_000;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function requestHash(body) { return crypto.createHash('sha256').update(stableStringify(body)).digest('hex'); }
function saleAccepted(row) {
  return { saleId: row.id, clientSaleId: row.client_sale_id, status: row.status, soldAt: row.sold_at_original };
}
function timestampContext(payload) {
  const soldAtDate = parseIsoOffset(payload.soldAt, 'soldAt');
  const zone = safeString(payload.deviceTimeZoneId, 'deviceTimeZoneId', { min: 1, max: 80, allowEmpty: false });
  if (!validateTimeZone(zone)) throw new HttpError(422, 'INVALID_TIME_ZONE', 'La zona horaria del dispositivo no es válida.');
  const offset = assertSafeInteger(payload.deviceOffsetMinutes, 'deviceOffsetMinutes', { min: -840, max: 840 });
  return { soldAtDate, soldAtOriginal: payload.soldAt.trim(), zone, offset };
}

router.post('/', requireAuth, requireRoles('OWNER', 'WORKER'), async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('INVALID_SALE', 'Faltan los datos de la venta.');
  const headerKey = String(req.get('Idempotency-Key') || '').trim();
  if (!UUID_RE.test(headerKey) || !UUID_RE.test(String(payload.clientSaleId || '')) || headerKey.toLowerCase() !== String(payload.clientSaleId).toLowerCase()) {
    throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'La clave de idempotencia debe coincidir con el identificador de la venta.');
  }
  if (String(payload.workerId || '') !== req.auth.userId) throw forbidden('La venta debe pertenecer a la cuenta que inició sesión.');
  if (payload.currency !== 'CUP') throw new HttpError(422, 'INVALID_CURRENCY', 'La moneda de esta cafetería debe ser CUP.');
  if (!PAYMENT_METHODS.has(payload.paymentMethod)) throw new HttpError(422, 'INVALID_PAYMENT_METHOD', 'El método de pago no es válido.');
  const { soldAtDate, soldAtOriginal, zone, offset } = timestampContext(payload);
  const totalSent = assertSafeInteger(payload.totalCUP, 'totalCUP', { min: 1, max: MAX_MONEY });
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) throw new HttpError(422, 'INVALID_ITEMS', 'La venta debe contener entre 1 y 100 artículos.');
  const idSet = new Set();
  const normalizedItems = payload.items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new HttpError(422, 'INVALID_ITEM', `El artículo ${index + 1} no es válido.`);
    const productId = String(item.productId || '');
    if (!UUID_RE.test(productId)) throw new HttpError(422, 'INVALID_PRODUCT_ID', `El artículo ${index + 1} no tiene un producto válido.`);
    if (idSet.has(productId)) throw new HttpError(422, 'DUPLICATE_PRODUCT_ITEM', 'Agrupa en una sola línea las cantidades del mismo producto.');
    idSet.add(productId);
    const unitQuantity = assertSafeInteger(item.unitQuantity, `items[${index}].unitQuantity`, { min: 0, max: 1_000_000_000 });
    const subunitQuantity = assertSafeInteger(item.subunitQuantity, `items[${index}].subunitQuantity`, { min: 0, max: 1_000_000_000 });
    if (unitQuantity === 0 && subunitQuantity === 0) throw new HttpError(422, 'EMPTY_ITEM', 'Cada artículo debe incluir una cantidad vendida.');
    const priceVersionSnapshot = safeString(item.priceVersionSnapshot, `items[${index}].priceVersionSnapshot`, { min: 1, max: 100, allowEmpty: false });
    const unitPriceAppliedCUP = assertSafeInteger(item.unitPriceAppliedCUP, `items[${index}].unitPriceAppliedCUP`, { min: 0, max: MAX_MONEY });
    const subunitPriceAppliedCUP = item.subunitPriceAppliedCUP == null ? null : assertSafeInteger(item.subunitPriceAppliedCUP, `items[${index}].subunitPriceAppliedCUP`, { min: 0, max: MAX_MONEY });
    const itemTotalSent = assertSafeInteger(item.totalCUP, `items[${index}].totalCUP`, { min: 1, max: MAX_MONEY });
    const ratio = item.subunitsPerUnitSnapshot == null ? null : assertSafeInteger(item.subunitsPerUnitSnapshot, `items[${index}].subunitsPerUnitSnapshot`, { min: 1, max: 1_000_000 });
    const productNameSnapshot = safeString(item.productName, `items[${index}].productName`, { min: 1, max: 160, allowEmpty: false });
    const unitNameSnapshot = safeString(item.unitName, `items[${index}].unitName`, { min: 1, max: 40, allowEmpty: false });
    const subunitNameSnapshot = item.subunitName == null || String(item.subunitName).trim() === ''
      ? null
      : safeString(item.subunitName, `items[${index}].subunitName`, { min: 1, max: 40, allowEmpty: false });
    return { productId, unitQuantity, subunitQuantity, priceVersionSnapshot, unitPriceAppliedCUP, subunitPriceAppliedCUP, itemTotalSent, ratio, productNameSnapshot, unitNameSnapshot, subunitNameSnapshot };
  });

  const hash = requestHash(payload);
  const result = await withTransaction(async (client) => {
    // Serialize concurrent requests with the same idempotency key even before the unique index fires.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [req.auth.businessId, headerKey.toLowerCase()]);
    const duplicate = await client.query('SELECT * FROM sales WHERE business_id=$1 AND client_sale_id=$2', [req.auth.businessId, headerKey]);
    if (duplicate.rowCount) {
      if (duplicate.rows[0].request_hash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'El identificador de esta venta ya fue usado con datos diferentes.');
      return { duplicate: true, sale: duplicate.rows[0] };
    }

    const userResult = await client.query('SELECT id,display_name,role,active FROM users WHERE id=$1 AND business_id=$2', [req.auth.userId, req.auth.businessId]);
    if (!userResult.rowCount || !userResult.rows[0].active || !['OWNER', 'WORKER'].includes(userResult.rows[0].role)) throw forbidden('Esta cuenta ya no puede registrar ventas.');
    const worker = userResult.rows[0];

    const lockedProducts = new Map();
    for (const item of [...normalizedItems].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const productResult = await client.query('SELECT * FROM products WHERE id=$1 AND business_id=$2 AND active=TRUE FOR UPDATE', [item.productId, req.auth.businessId]);
      if (!productResult.rowCount) throw notFound('Uno de los productos de la venta ya no está disponible.');
      lockedProducts.set(item.productId, productResult.rows[0]);
    }

    let recomputedTotal = 0;
    const confirmedItems = [];
    for (const item of normalizedItems) {
      const product = lockedProducts.get(item.productId);
      if (String(product.price_version) !== item.priceVersionSnapshot) throw conflict('PRICE_CHANGED', `El precio o formato de «${product.name}» cambió. Actualiza el catálogo antes de sincronizar esta venta.`);
      if ((product.subunits_per_unit == null ? null : Number(product.subunits_per_unit)) !== item.ratio) throw conflict('SALE_FORMAT_CHANGED', `El formato de «${product.name}» cambió. La venta necesita revisión.`);

      let unitPrice = 0;
      let subunitPrice = null;
      if (item.unitQuantity > 0) {
        if (!['UNIT', 'BOTH'].includes(product.sale_mode)) throw new HttpError(422, 'UNIT_SALE_NOT_ALLOWED', `«${product.name}» no se vende por unidades completas.`);
        unitPrice = payload.paymentMethod === 'CASH_CUP' ? product.unit_price_cup : product.unit_price_transfer;
        if (unitPrice == null) throw new HttpError(422, 'PAYMENT_METHOD_UNAVAILABLE', `«${product.name}» no tiene precio por unidad para ese método de pago.`);
        if (Number(unitPrice) !== item.unitPriceAppliedCUP) throw conflict('PRICE_SNAPSHOT_MISMATCH', `El precio aplicado a «${product.name}» no coincide con el catálogo vigente.`);
      }
      if (item.subunitQuantity > 0) {
        if (!['SUBUNIT', 'BOTH'].includes(product.sale_mode)) throw new HttpError(422, 'SUBUNIT_SALE_NOT_ALLOWED', `«${product.name}» no se vende por subunidades.`);
        subunitPrice = payload.paymentMethod === 'CASH_CUP' ? product.subunit_price_cup : product.subunit_price_transfer;
        if (subunitPrice == null) throw new HttpError(422, 'PAYMENT_METHOD_UNAVAILABLE', `«${product.name}» no tiene precio por subunidad para ese método de pago.`);
        if (item.subunitPriceAppliedCUP == null || Number(subunitPrice) !== item.subunitPriceAppliedCUP) throw conflict('PRICE_SNAPSHOT_MISMATCH', `El precio por subunidad de «${product.name}» no coincide con el catálogo vigente.`);
      }
      const itemTotal = item.unitQuantity * Number(unitPrice) + item.subunitQuantity * Number(subunitPrice ?? 0);
      if (!Number.isSafeInteger(itemTotal) || itemTotal < 1 || itemTotal > MAX_MONEY) throw new HttpError(422, 'INVALID_TOTAL', `El importe de «${product.name}» no es válido.`);
      if (itemTotal !== item.itemTotalSent) throw new HttpError(422, 'ITEM_TOTAL_MISMATCH', `El importe de «${product.name}» no coincide con las cantidades y los precios.`);
      recomputedTotal += itemTotal;
      if (!Number.isSafeInteger(recomputedTotal) || recomputedTotal > MAX_MONEY) throw new HttpError(422, 'TOTAL_TOO_LARGE', 'El total de la venta supera el límite permitido.');
      const nextStock = calculateAfterSale(product, item.unitQuantity, item.subunitQuantity);
      confirmedItems.push({ ...item, product, unitPrice: Number(unitPrice), subunitPrice: subunitPrice == null ? null : Number(subunitPrice), itemTotal, nextStock });
    }
    if (recomputedTotal !== totalSent) throw new HttpError(422, 'TOTAL_MISMATCH', 'El total de la venta no coincide con los artículos.');

    const saleResult = await client.query(
      `INSERT INTO sales (business_id,client_sale_id,request_hash,worker_id,worker_name_snapshot,sold_at,sold_at_original,device_time_zone_id,device_offset_minutes,payment_method,currency,total_cup,app_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CUP',$11,$12) RETURNING *`,
      [req.auth.businessId, headerKey, hash, worker.id, worker.display_name, soldAtDate, soldAtOriginal, zone, offset, payload.paymentMethod, recomputedTotal, String(payload.appVersion || '1.0.0').slice(0, 40)],
    );
    const sale = saleResult.rows[0];
    const summaryParts = [];
    for (const item of confirmedItems) {
      await client.query(
        `INSERT INTO sale_items (business_id,sale_id,product_id,product_name_snapshot,unit_name_snapshot,subunit_name_snapshot,unit_quantity,subunit_quantity,subunits_per_unit_snapshot,price_version_snapshot,unit_price_applied_cup,subunit_price_applied_cup,total_cup)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [req.auth.businessId, sale.id, item.product.id, item.productNameSnapshot, item.unitNameSnapshot, item.subunitNameSnapshot, item.unitQuantity, item.subunitQuantity,
          item.ratio, item.priceVersionSnapshot, item.unitPrice, item.subunitPrice, item.itemTotal],
      );
      const prevUnits = Number(item.product.stock_units);
      const prevSubunits = item.product.stock_subunits == null ? null : Number(item.product.stock_subunits);
      await client.query(
        `UPDATE products SET stock_units=$3,stock_subunits=$4,updated_at=now() WHERE id=$1 AND business_id=$2`,
        [item.product.id, req.auth.businessId, item.nextStock.units, item.nextStock.subunits],
      );
      // Movement deltas describe the actual normalized inventory change, not the raw
      // quantities sold. For known equivalences this may borrow/carry between units
      // and subunits; for unknown yields the subunit delta remains NULL.
      const movementDelta = calculateInventoryMovementDelta(
        { units: prevUnits, subunits: prevSubunits },
        item.nextStock,
      );
      await client.query(
        `INSERT INTO inventory_movements (business_id,product_id,movement_type,unit_delta,subunit_delta,previous_units,previous_subunits,new_units,new_subunits,sale_id,actor_id,reason)
         VALUES ($1,$2,'SALE',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.auth.businessId, item.product.id, movementDelta.unitDelta, movementDelta.subunitDelta, prevUnits, prevSubunits, item.nextStock.units, item.nextStock.subunits, sale.id, worker.id, 'Venta registrada'],
      );
      const desc = [];
      if (item.unitQuantity > 0) desc.push(`${item.unitQuantity} ${item.unitNameSnapshot}`);
      if (item.subunitQuantity > 0) desc.push(`${item.subunitQuantity} ${item.subunitNameSnapshot || 'subunidades'}`);
      summaryParts.push(`${item.productNameSnapshot}: ${desc.join(' + ')}`);
    }
    await insertAudit(client, { businessId: req.auth.businessId, actorId: worker.id, action: 'SALE_ACCEPTED', entityType: 'sale', entityId: sale.id, metadata: { clientSaleId: sale.client_sale_id, paymentMethod: sale.payment_method, totalCUP: recomputedTotal, itemCount: confirmedItems.length, soldAt: soldAtOriginal, deviceTimeZoneId: zone, deviceOffsetMinutes: offset, summary: summaryParts.join('; ') } });
    return { duplicate: false, sale };
  });
  res.status(result.duplicate ? 200 : 201).json({ data: saleAccepted(result.sale), message: result.duplicate ? 'Esta venta ya estaba sincronizada.' : 'Venta sincronizada.' });
});

router.get('/', requireAuth, requireRoles('OWNER', 'WORKER'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit || 100), 10) || 100));
  const conditions = ['s.business_id=$1'];
  const params = [req.auth.businessId];
  if (req.auth.role === 'WORKER') { params.push(req.auth.userId); conditions.push(`s.worker_id=$${params.length}`); }
  else if (req.query.workerId) {
    assertUuid(String(req.query.workerId), 'trabajadora');
    params.push(String(req.query.workerId)); conditions.push(`s.worker_id=$${params.length}`);
  }
  let fromDate = null;
  if (req.query.from) {
    fromDate = parseIsoOffset(String(req.query.from), 'from'); params.push(fromDate); conditions.push(`s.sold_at >= $${params.length}`);
  }
  if (req.query.to) {
    const to = parseIsoOffset(String(req.query.to), 'to');
    if (fromDate && fromDate >= to) throw new HttpError(422, 'INVALID_DATE_RANGE', 'La fecha inicial debe ser anterior a la fecha final.');
    params.push(to); conditions.push(`s.sold_at <= $${params.length}`);
  }
  params.push(limit);
  const result = await pool.query(
    `SELECT s.id,s.client_sale_id,s.sold_at_original AS sold_at,s.worker_id,s.worker_name_snapshot AS worker_name,s.payment_method,s.total_cup,s.status,
      string_agg(si.product_name_snapshot || ' (' || trim(concat_ws(' ', NULLIF(si.unit_quantity,0)::text || ' ' || si.unit_name_snapshot, NULLIF(si.subunit_quantity,0)::text || ' ' || COALESCE(si.subunit_name_snapshot,'subunidades'))) || ')', '; ' ORDER BY si.created_at) AS summary
     FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id AND si.business_id=s.business_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY s.id ORDER BY s.sold_at DESC,s.id DESC LIMIT $${params.length}`,
    params,
  );
  res.json({ data: result.rows.map((row) => ({ id: row.id, clientSaleId: row.client_sale_id, soldAt: row.sold_at, workerId: row.worker_id, workerName: row.worker_name, summary: row.summary || '', paymentMethod: row.payment_method, totalCUP: Number(row.total_cup), status: row.status })), message: 'Historial cargado.' });
});

export default router;

import { Router } from 'express';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { pool, withTransaction } from '../db.js';
import { optionalAuth, requireAuth, requireRoles } from '../middleware/auth.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { safeString, assertSafeInteger, assertUuid } from '../lib/security.js';
import { validateProductPricing } from '../lib/stock.js';
import { resolvePublicBusiness } from '../lib/business.js';
import { insertAudit } from '../lib/business.js';
import { storeProductImage, removeProductImage } from '../services/image-storage.js';
import { productDto } from './product-shared.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024), files: 1, fields: 20 } });
const allowedImageTypes = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'],
]);
const sortColumns = { name: 'p.name', updatedAt: 'p.updated_at', unitPriceCup: 'p.unit_price_cup', stockUnits: 'p.stock_units' };

function parseProductInput(raw, { creating = false } = {}) {
  let input = raw;
  if (typeof raw === 'string') {
    try { input = JSON.parse(raw); } catch { throw badRequest('INVALID_PRODUCT_JSON', 'Los datos del producto no tienen un formato válido.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('INVALID_PRODUCT', 'Faltan los datos del producto.');
  const saleMode = safeString(input.saleMode, 'saleMode', { min: 1, max: 10, allowEmpty: false });
  const name = safeString(input.name, 'name', { min: 1, max: 160, allowEmpty: false });
  const description = safeString(input.description ?? '', 'description', { max: 2000 });
  const categoryName = safeString(input.categoryName, 'categoryName', { min: 1, max: 100, allowEmpty: false });
  const unitName = safeString(input.unitName ?? 'unidad', 'unitName', { min: 1, max: 40, allowEmpty: false });
  const subunitName = input.subunitName == null || String(input.subunitName).trim() === '' ? null : safeString(input.subunitName, 'subunitName', { min: 1, max: 40, allowEmpty: false });
  const optionalPrice = (value, field) => value == null || value === '' ? null : assertSafeInteger(Number(value), field, { min: 1, max: 9_000_000_000_000 });
  const unitPriceCup = optionalPrice(input.unitPriceCup, 'unitPriceCup');
  const unitPriceTransfer = optionalPrice(input.unitPriceTransfer, 'unitPriceTransfer');
  const subunitPriceCup = optionalPrice(input.subunitPriceCup, 'subunitPriceCup');
  const subunitPriceTransfer = optionalPrice(input.subunitPriceTransfer, 'subunitPriceTransfer');
  const ratio = input.subunitsPerUnit == null || input.subunitsPerUnit === '' ? null : assertSafeInteger(Number(input.subunitsPerUnit), 'subunitsPerUnit', { min: 1, max: 1_000_000 });
  const minimumStock = input.minimumStock == null ? 0 : assertSafeInteger(Number(input.minimumStock), 'minimumStock', { min: 0, max: 9_000_000_000_000 });
  let stockUnits = 0;
  let stockSubunits = null;
  if (creating) {
    stockUnits = assertSafeInteger(Number(input.stockUnits ?? 0), 'stockUnits', { min: 0, max: 9_000_000_000_000 });
    if (ratio != null) {
      stockSubunits = assertSafeInteger(Number(input.stockSubunits ?? 0), 'stockSubunits', { min: 0, max: 9_000_000_000_000 });
      stockUnits += Math.floor(stockSubunits / ratio);
      stockSubunits %= ratio;
    } else if (input.stockSubunits != null && Number(input.stockSubunits) !== 0) {
      throw new HttpError(422, 'UNKNOWN_SUBUNIT_EQUIVALENCE', 'No se puede indicar un saldo exacto de subunidades si no se conoce la equivalencia.');
    }
  }
  const publicVisible = input.publicVisible == null ? true : input.publicVisible;
  if (typeof publicVisible !== 'boolean') throw new HttpError(422, 'INVALID_FIELD', 'El campo publicVisible debe ser verdadero o falso.');
  const pricing = { saleMode, unitPriceCup, unitPriceTransfer, subunitPriceCup, subunitPriceTransfer, subunitsPerUnit: ratio, stockSubunits, isCreate: creating };
  validateProductPricing(pricing);
  if (saleMode !== 'UNIT' && !subunitName) throw new HttpError(422, 'SUBUNIT_NAME_REQUIRED', 'Indica el nombre de la subunidad que se vende.');
  if (saleMode === 'UNIT' && ratio != null) throw new HttpError(422, 'INVALID_SUBUNIT_RATIO', 'Un producto vendido solo por unidades no necesita equivalencia de subunidades.');
  return { name, description, categoryName, unitName, subunitName, saleMode, subunitsPerUnit: ratio, unitPriceCup, unitPriceTransfer, subunitPriceCup, subunitPriceTransfer, minimumStock, publicVisible, stockUnits, stockSubunits };
}

async function saveImage(file) {
  if (!file) return null;
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !allowedImageTypes.has(detected.mime)) {
    throw new HttpError(422, 'UNSUPPORTED_IMAGE', 'Usa una imagen JPG, PNG o WebP válida.');
  }
  return storeProductImage(file.buffer, detected.mime);
}

router.get('/', optionalAuth, async (req, res) => {
  const visibility = String(req.query.visibility || (req.auth?.role === 'OWNER' || req.auth?.role === 'WORKER' ? 'all' : 'public'));
  if (!['public', 'all'].includes(visibility)) throw badRequest('INVALID_VISIBILITY', 'El filtro de visibilidad no es válido.');
  if (visibility === 'all' && !req.auth) throw new HttpError(401, 'UNAUTHORIZED', 'Inicia sesión para consultar el inventario.');
  if (visibility === 'all' && !['OWNER', 'WORKER'].includes(req.auth.role)) throw forbidden('Los clientes solo pueden consultar el catálogo público.');
  if (visibility === 'public' && req.auth && ['OWNER', 'WORKER'].includes(req.auth.role)) {
    // Owners/workers may explicitly inspect the public storefront, but still only their business.
  }
  let business;
  if (req.auth) business = { id: req.auth.businessId };
  else business = await resolvePublicBusiness(req);
  const category = req.query.category == null ? null : safeString(String(req.query.category), 'category', { max: 100 });
  const sort = String(req.query.sort || 'name');
  const direction = String(req.query.direction || 'asc').toLowerCase();
  if (!sortColumns[sort] || !['asc', 'desc'].includes(direction)) throw badRequest('INVALID_SORT', 'El criterio de orden no es válido.');
  if (visibility === 'public' && sort === 'stockUnits') throw badRequest('INVALID_SORT', 'El catálogo público no puede ordenar por existencias internas.');
  const conditions = ['p.business_id=$1', 'p.active=TRUE'];
  const params = [business.id];
  if (visibility === 'public') conditions.push('p.public_visible=TRUE');
  if (category) { params.push(category); conditions.push(`p.category_name=$${params.length}`); }
  const query = `SELECT p.* FROM products p WHERE ${conditions.join(' AND ')} ORDER BY ${sortColumns[sort]} ${direction.toUpperCase()}, p.id ASC LIMIT 2000`;
  const result = await pool.query(query, params);
  res.json({ data: result.rows.map((row) => productDto(row, req, visibility === 'public')), message: 'Catálogo cargado.' });
});

router.post('/', requireAuth, requireRoles('OWNER'), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'product', maxCount: 1 }]), async (req, res) => {
  const input = parseProductInput(req.body?.product, { creating: true });
  const imagePath = await saveImage(req.files?.image?.[0]);
  try {
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO products (business_id,name,description,category_name,image_path,unit_name,subunit_name,sale_mode,subunits_per_unit,
          unit_price_cup,unit_price_transfer,subunit_price_cup,subunit_price_transfer,stock_units,stock_subunits,minimum_stock,public_visible,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING *`,
        [req.auth.businessId, input.name, input.description, input.categoryName, imagePath, input.unitName, input.subunitName, input.saleMode,
          input.subunitsPerUnit, input.unitPriceCup, input.unitPriceTransfer, input.subunitPriceCup, input.subunitPriceTransfer,
          input.stockUnits, input.stockSubunits, input.minimumStock, input.publicVisible, req.auth.userId],
      );
      const row = result.rows[0];
      if (input.stockUnits > 0 || (input.stockSubunits ?? 0) > 0) {
        await client.query(
          `INSERT INTO inventory_movements (business_id,product_id,movement_type,unit_delta,subunit_delta,previous_units,previous_subunits,new_units,new_subunits,actor_id,reason)
           VALUES ($1,$2,'INITIAL',$3,$4,0,$5,$3,$4,$6,'Existencias iniciales')`,
          [req.auth.businessId, row.id, input.stockUnits, input.stockSubunits, input.subunitsPerUnit == null ? null : 0, req.auth.userId],
        );
      }
      await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'PRODUCT_CREATED', entityType: 'product', entityId: row.id, metadata: { name: row.name, stockUnits: input.stockUnits } });
      return row;
    });
    res.status(201).json({ data: productDto(created, req), message: 'Producto creado.' });
  } catch (error) {
    if (imagePath) await removeProductImage(imagePath).catch(() => {});
    throw error;
  }
});

router.put('/:id', requireAuth, requireRoles('OWNER'), (req, _res, next) => { try { assertUuid(req.params.id, 'producto'); next(); } catch (error) { next(error); } }, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'product', maxCount: 1 }]), async (req, res) => {
  const input = parseProductInput(req.body?.product, { creating: false });
  const newImagePath = await saveImage(req.files?.image?.[0]);
  try {
    const updated = await withTransaction(async (client) => {
      const beforeResult = await client.query('SELECT * FROM products WHERE id=$1 AND business_id=$2 FOR UPDATE', [req.params.id, req.auth.businessId]);
      if (!beforeResult.rowCount) throw notFound('No se encontró el producto.');
      const old = beforeResult.rows[0];
      if (old.subunits_per_unit !== input.subunitsPerUnit && (Number(old.stock_units) > 0 || Number(old.stock_subunits || 0) > 0)) {
        throw new HttpError(409, 'SUBUNIT_EQUIVALENCE_REQUIRES_EMPTY_STOCK', 'No se puede cambiar la equivalencia mientras haya existencias. Ajusta el inventario hasta cero y vuelve a guardar el producto.');
      }
      if (old.subunits_per_unit != null && input.subunitsPerUnit == null && Number(old.stock_subunits || 0) > 0) {
        throw new HttpError(409, 'SUBUNIT_STOCK_REQUIRES_REVIEW', 'No se puede quitar la equivalencia mientras existan subunidades sueltas. Ajusta primero el inventario.');
      }
      const priceChanged = old.sale_mode !== input.saleMode || old.subunits_per_unit !== input.subunitsPerUnit ||
        old.unit_price_cup !== input.unitPriceCup || old.unit_price_transfer !== input.unitPriceTransfer ||
        old.subunit_price_cup !== input.subunitPriceCup || old.subunit_price_transfer !== input.subunitPriceTransfer;
      const imagePath = newImagePath || old.image_path;
      const result = await client.query(
        `UPDATE products SET name=$3,description=$4,category_name=$5,image_path=$6,unit_name=$7,subunit_name=$8,sale_mode=$9,
         subunits_per_unit=$10,stock_subunits=CASE WHEN $10 IS NULL THEN NULL WHEN stock_subunits IS NULL THEN 0 ELSE stock_subunits END,
         unit_price_cup=$11,unit_price_transfer=$12,subunit_price_cup=$13,subunit_price_transfer=$14,
         minimum_stock=$15,public_visible=$16,price_version=CASE WHEN $17 THEN gen_random_uuid() ELSE price_version END,
         updated_by=$18,updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING *`,
        [old.id, req.auth.businessId, input.name, input.description, input.categoryName, imagePath, input.unitName, input.subunitName,
          input.saleMode, input.subunitsPerUnit, input.unitPriceCup, input.unitPriceTransfer, input.subunitPriceCup, input.subunitPriceTransfer,
          input.minimumStock, input.publicVisible, priceChanged, req.auth.userId],
      );
      await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'PRODUCT_UPDATED', entityType: 'product', entityId: old.id, metadata: { priceChanged, oldName: old.name, newName: input.name } });
      return { row: result.rows[0], oldImage: newImagePath && old.image_path !== newImagePath ? old.image_path : null };
    });
    if (updated.oldImage) await removeProductImage(updated.oldImage).catch(() => {});
    res.json({ data: productDto(updated.row, req), message: 'Producto actualizado.' });
  } catch (error) {
    if (newImagePath) await removeProductImage(newImagePath).catch(() => {});
    throw error;
  }
});

router.delete('/:id', requireAuth, requireRoles('OWNER'), async (req, res) => {
  assertUuid(req.params.id, 'producto');
  const result = await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE products SET active=FALSE,public_visible=FALSE,updated_at=now(),updated_by=$3
       WHERE id=$1 AND business_id=$2 AND active=TRUE RETURNING id,name`, [req.params.id, req.auth.businessId, req.auth.userId],
    );
    if (!updated.rowCount) throw notFound('No se encontró el producto activo.');
    await insertAudit(client, { businessId: req.auth.businessId, actorId: req.auth.userId, action: 'PRODUCT_DEACTIVATED', entityType: 'product', entityId: updated.rows[0].id, metadata: { name: updated.rows[0].name } });
    return updated.rows[0];
  });
  res.json({ data: true, message: 'Producto desactivado.' });
});


export default router;

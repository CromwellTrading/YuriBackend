import { publicImageUrl } from '../services/image-storage.js';

export function productDto(row, req, publicView = false) {
  const available = Number(row.stock_units) > 0 || (row.stock_subunits != null && Number(row.stock_subunits) > 0);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    categoryName: row.category_name,
    imageUrl: publicImageUrl(row.image_path, req),
    unitName: row.unit_name,
    subunitName: row.subunit_name,
    saleMode: row.sale_mode,
    subunitsPerUnit: row.subunits_per_unit,
    unitPriceCup: row.unit_price_cup,
    unitPriceTransfer: row.unit_price_transfer,
    subunitPriceCup: row.subunit_price_cup,
    subunitPriceTransfer: row.subunit_price_transfer,
    stockUnits: publicView ? (available ? 1 : 0) : Number(row.stock_units),
    stockSubunits: publicView ? null : (row.stock_subunits == null ? null : Number(row.stock_subunits)),
    minimumStock: publicView ? 0 : Number(row.minimum_stock),
    publicVisible: Boolean(row.public_visible),
    updatedAt: new Date(row.updated_at).toISOString(),
    priceVersion: row.price_version,
    ...(publicView ? { available } : {}),
  };
}

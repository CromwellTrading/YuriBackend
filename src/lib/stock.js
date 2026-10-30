import { HttpError } from './errors.js';

export function calculateAfterSale(product, unitQuantity, subunitQuantity) {
  const units = Number(unitQuantity);
  const subunits = Number(subunitQuantity);
  if (!Number.isSafeInteger(units) || !Number.isSafeInteger(subunits) || units < 0 || subunits < 0 || (units === 0 && subunits === 0)) {
    throw new HttpError(422, 'INVALID_QUANTITY', 'Las cantidades de la venta no son válidas.');
  }
  const ratio = product.subunits_per_unit == null ? null : Number(product.subunits_per_unit);

  if (ratio != null) {
    if (!Number.isSafeInteger(ratio) || ratio <= 0 || product.stock_subunits == null) {
      throw new HttpError(409, 'INVALID_STOCK_CONFIGURATION', 'La equivalencia o las existencias de este producto necesitan revisión.');
    }
    const current = Number(product.stock_units) * ratio + Number(product.stock_subunits);
    const requested = units * ratio + subunits;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(requested) || requested > current) {
      throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Las existencias no alcanzan para completar esta venta.');
    }
    const remaining = current - requested;
    return { units: Math.floor(remaining / ratio), subunits: remaining % ratio };
  }

  // If the yield of a container is unknown (e.g. scoops per ice-cream tub),
  // unit sales consume containers; portion sales are tracked financially but cannot
  // truthfully deduct an unknown number of portions from container stock.
  const currentUnits = Number(product.stock_units);
  if (units > currentUnits) {
    throw new HttpError(409, 'INSUFFICIENT_STOCK', 'No hay suficientes unidades completas disponibles.');
  }
  if (subunits > 0 && currentUnits - units <= 0) {
    throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Debe quedar al menos un recipiente disponible para registrar subunidades sin equivalencia conocida.');
  }
  return { units: currentUnits - units, subunits: null };
}

export function calculateInventoryMovementDelta(previous, next) {
  const previousUnits = Number(previous.units);
  const nextUnits = Number(next.units);
  if (!Number.isSafeInteger(previousUnits) || !Number.isSafeInteger(nextUnits)) {
    throw new HttpError(422, 'INVALID_STOCK', 'Las existencias del movimiento no son válidas.');
  }
  const unitDelta = nextUnits - previousUnits;
  if (previous.subunits == null || next.subunits == null) {
    return { unitDelta, subunitDelta: null };
  }
  const previousSubunits = Number(previous.subunits);
  const nextSubunits = Number(next.subunits);
  if (!Number.isSafeInteger(previousSubunits) || !Number.isSafeInteger(nextSubunits)) {
    throw new HttpError(422, 'INVALID_STOCK', 'Las subunidades del movimiento no son válidas.');
  }
  return { unitDelta, subunitDelta: nextSubunits - previousSubunits };
}

export function calculateAfterAdjustment(product, unitDelta, subunitDelta) {
  if (!Number.isSafeInteger(unitDelta) || !Number.isSafeInteger(subunitDelta ?? 0)) {
    throw new HttpError(422, 'INVALID_QUANTITY', 'El ajuste de existencias no es válido.');
  }
  const ratio = product.subunits_per_unit == null ? null : Number(product.subunits_per_unit);
  if (ratio != null) {
    if (product.stock_subunits == null) {
      throw new HttpError(409, 'INVALID_STOCK_CONFIGURATION', 'Las existencias de subunidades necesitan revisión.');
    }
    const deltaSubunits = subunitDelta ?? 0;
    const total = Number(product.stock_units) * ratio + Number(product.stock_subunits) + unitDelta * ratio + deltaSubunits;
    if (!Number.isSafeInteger(total) || total < 0) throw new HttpError(409, 'NEGATIVE_STOCK', 'El ajuste no puede dejar existencias negativas.');
    return { units: Math.floor(total / ratio), subunits: total % ratio };
  }
  if (subunitDelta != null && subunitDelta !== 0) {
    throw new HttpError(422, 'UNKNOWN_SUBUNIT_EQUIVALENCE', 'No se puede ajustar una cantidad exacta de subunidades si no se conoce la equivalencia.');
  }
  const next = Number(product.stock_units) + unitDelta;
  if (!Number.isSafeInteger(next) || next < 0) throw new HttpError(409, 'NEGATIVE_STOCK', 'El ajuste no puede dejar existencias negativas.');
  return { units: next, subunits: null };
}

export function validateProductPricing(input) {
  const mode = input.saleMode;
  if (!['UNIT', 'SUBUNIT', 'BOTH'].includes(mode)) throw new HttpError(422, 'INVALID_SALE_MODE', 'El formato de venta no es válido.');
  if (mode !== 'SUBUNIT' && (!Number.isSafeInteger(input.unitPriceCup) || input.unitPriceCup < 1)) {
    throw new HttpError(422, 'UNIT_PRICE_REQUIRED', 'El precio en CUP por unidad es obligatorio.');
  }
  if (mode !== 'UNIT' && (!Number.isSafeInteger(input.subunitPriceCup) || input.subunitPriceCup < 1)) {
    throw new HttpError(422, 'SUBUNIT_PRICE_REQUIRED', 'El precio en CUP por subunidad es obligatorio.');
  }
  if (input.subunitsPerUnit != null && (!Number.isSafeInteger(input.subunitsPerUnit) || input.subunitsPerUnit < 1 || input.subunitsPerUnit > 1_000_000)) {
    throw new HttpError(422, 'INVALID_SUBUNIT_RATIO', 'La equivalencia de subunidades no es válida.');
  }
  if (input.subunitsPerUnit != null && input.stockSubunits == null && input.isCreate === true) {
    throw new HttpError(422, 'SUBUNIT_STOCK_REQUIRED', 'Indica las subunidades disponibles cuando la equivalencia es conocida.');
  }
}

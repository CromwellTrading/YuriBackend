import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAfterSale, calculateAfterAdjustment, calculateInventoryMovementDelta, validateProductPricing } from '../src/lib/stock.js';
import { HttpError } from '../src/lib/errors.js';

function product(overrides = {}) {
  return { stock_units: 10, stock_subunits: 0, subunits_per_unit: 20, sale_mode: 'BOTH', ...overrides };
}

test('venta de 5 cajas y 30 cigarros sueltos normaliza el saldo a 3 cajas y 10 cigarros', () => {
  assert.deepEqual(calculateAfterSale(product(), 5, 30), { units: 3, subunits: 10 });
});

test('21 subunidades consumen una unidad completa y una subunidad del inventario conocido', () => {
  assert.deepEqual(calculateAfterSale(product(), 0, 21), { units: 8, subunits: 19 });
});

test('el movimiento refleja la diferencia normalizada del inventario tras vender unidades y subunidades', () => {
  assert.deepEqual(
    calculateInventoryMovementDelta({ units: 10, subunits: 0 }, { units: 3, subunits: 10 }),
    { unitDelta: -7, subunitDelta: 10 },
  );
});

test('los movimientos con rendimiento desconocido no inventan deltas de subunidades', () => {
  assert.deepEqual(
    calculateInventoryMovementDelta({ units: 2, subunits: null }, { units: 2, subunits: null }),
    { unitDelta: 0, subunitDelta: null },
  );
});

test('venta exacta de todo el inventario queda en cero', () => {
  assert.deepEqual(calculateAfterSale(product(), 10, 0), { units: 0, subunits: 0 });
});

test('rechaza vender más subunidades que las disponibles', () => {
  assert.throws(() => calculateAfterSale(product({ stock_units: 1, stock_subunits: 0 }), 0, 21), (error) => error instanceof HttpError && error.code === 'INSUFFICIENT_STOCK');
});

test('producto con equivalencia desconocida registra porciones sin inventar rendimiento', () => {
  assert.deepEqual(calculateAfterSale(product({ stock_units: 2, stock_subunits: null, subunits_per_unit: null }), 0, 50), { units: 2, subunits: null });
});


test('producto vendido solamente por vasos permite registrar porciones sin stock de recipientes', () => {
  assert.deepEqual(
    calculateAfterSale(product({ stock_units: 0, stock_subunits: null, subunits_per_unit: null, sale_mode: 'SUBUNIT' }), 0, 12),
    { units: 0, subunits: null },
  );
});

test('producto vendido solo por porciones con un recipiente registrado conserva ese recipiente sin inventar rendimiento', () => {
  assert.deepEqual(
    calculateAfterSale(product({ stock_units: 1, stock_subunits: null, subunits_per_unit: null, sale_mode: 'SUBUNIT' }), 0, 12),
    { units: 1, subunits: null },
  );
});

test('producto sin rendimiento conocido exige que quede un recipiente si se venden porciones', () => {
  assert.throws(() => calculateAfterSale(product({ stock_units: 1, stock_subunits: null, subunits_per_unit: null }), 1, 1), (error) => error instanceof HttpError && error.code === 'INSUFFICIENT_STOCK');
});

test('ajuste de 20 subunidades las convierte en una caja', () => {
  assert.deepEqual(calculateAfterAdjustment(product({ stock_units: 1, stock_subunits: 10 }), 0, 20), { units: 2, subunits: 10 });
});

test('ajuste que dejaría existencias negativas se rechaza', () => {
  assert.throws(() => calculateAfterAdjustment(product({ stock_units: 0, stock_subunits: 5 }), 0, -6), (error) => error instanceof HttpError && error.code === 'NEGATIVE_STOCK');
});

test('validación de precios exige precio CUP para los formatos habilitados', () => {
  assert.throws(() => validateProductPricing({ saleMode: 'BOTH', unitPriceCup: 20, subunitPriceCup: null, subunitsPerUnit: 20, stockSubunits: 0, isCreate: true }), (error) => error instanceof HttpError && error.code === 'SUBUNIT_PRICE_REQUIRED');
});

test('validación de precios permite omitir transferencia', () => {
  assert.doesNotThrow(() => validateProductPricing({ saleMode: 'UNIT', unitPriceCup: 20, unitPriceTransfer: null, subunitPriceCup: null, subunitPriceTransfer: null, subunitsPerUnit: null, stockSubunits: null, isCreate: true }));
});

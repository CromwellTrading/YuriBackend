# Backend YuriCoofe 1.3.0

- `GET /api/v1/dashboard` incluye `productSales`: cantidades por artículo, unidad y subunidad, junto al importe total y desglose por efectivo/transferencia.
- `GET /api/v1/dashboard` incluye `workerSales`: operaciones e importes por trabajadora, con cantidades totales de unidad y subunidad.
- Las agregaciones consideran únicamente ventas `ACCEPTED` dentro del intervalo solicitado y usan `sold_at` junto con el huso horario de la cafetería para los valores por defecto.
- Las estadísticas provienen de `sale_items`, no de `products.stock_*`; por tanto cuentan ventas por porciones con stock sin seguimiento.
- No se requiere migración SQL.

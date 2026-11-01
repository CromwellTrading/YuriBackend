# API Contract v1 — Cafetería

Este documento es el contrato operativo implementado por este backend y consumido por `CafeteriaApp`. Prefijo: `/api/v1/`. JSON UTF-8, excepto creación/edición de productos, que usa multipart con un campo `product` de tipo JSON y un campo `image` opcional. Todas las respuestas tienen envoltura `{ data, message, code? }`.

## Roles y separación de datos

- `OWNER`: administración total de su cafetería, equipo, precios, avisos, existencias, estadísticas e historial completo.
- `WORKER`: consultar el inventario detallado de su negocio, registrar ventas y consultar solo sus propias ventas. No puede administrar productos ni modificar stock manualmente.
- `CUSTOMER`: consultar únicamente el catálogo público del negocio. Puede registrar un token push; no puede consultar existencias exactas, ventas ni estadísticas.

Toda tabla de negocio lleva `business_id`; la API deriva el negocio de la sesión autenticada. Las peticiones anónimas usan `PUBLIC_BUSINESS_SLUG`, un único negocio activo o el selector `X-Business-Slug`. No se acepta un `businessId` enviado por el cliente como prueba de autorización.

## Autenticación

### POST `/api/v1/auth/login`

Request: `{"identifier":"nombre-o-usuario","password":"..."}`. Es el acceso único para todos los perfiles. `OWNER` y `WORKER` se validan por el identificador creado por la dueña; si no coincide, busca `CUSTOMER` por nombre visible y contraseña dentro del negocio público configurado. Devuelve el rol real guardado en la base de datos; el cliente no puede elegirlo. Devuelve `accessToken`, `userId`, `displayName`, `role`, `businessId` y `businessTimeZone`. El token es opaco, aleatorio y caduca en `SESSION_DAYS` (por defecto 30 días). Solo su hash se almacena en PostgreSQL.

### GET `/api/v1/auth/me`, POST `/api/v1/auth/logout`

`me` devuelve los datos de la sesión. `logout` revoca la sesión actual. Desactivar una trabajadora bloquea nuevos logins y revoca sus sesiones vigentes.

### POST `/api/v1/auth/register-customer` (público)

Crea una cuenta `CUSTOMER` en el negocio público resuelto. Request: `displayName`, `identifier` (identificador interno `customer-` + UUID generado por la app), `password` (mínimo 10 caracteres). El identificador interno no se muestra al cliente; el nombre visible puede repetirse. El registro tiene un límite de frecuencia dedicado.

### POST `/api/v1/auth/customer-login` (público)

Request legado para versiones anteriores: `displayName`, `password`. Las versiones nuevas usan `/auth/login` para todos los perfiles. La app Android exige iniciar sesión antes de abrir el catálogo, aunque el endpoint de consulta pública del catálogo continúe aceptando solicitudes sin token.

## Productos

### GET `/api/v1/products`

Filtros: `visibility=public|all`, `category`, `sort=name|updatedAt|unitPriceCup|stockUnits`, `direction=asc|desc`. Sin sesión, la visibilidad siempre debe ser `public`; `all` requiere dueña o trabajadora. El catálogo público entrega `available` y no revela cantidades exactas. Se rechaza ordenar por stock en la vista pública para no inferir existencias.

Cada elemento entrega `id`, `name`, `description`, `categoryName`, `imageUrl`, `unitName`, `subunitName`, `saleMode`, `subunitsPerUnit`, `unitPriceCup`, `unitPriceTransfer`, `subunitPriceCup`, `subunitPriceTransfer`, `stockUnits`, `stockSubunits`, `minimumStock`, `publicVisible`, `updatedAt`, `priceVersion`. Para clientes `stockUnits` solo indica disponibilidad (`1`/`0`), `stockSubunits=null` y `minimumStock=0`.

`UNIT` requiere `unitPriceCup`; `SUBUNIT` requiere `subunitPriceCup`; `BOTH` requiere ambos. Los precios de transferencia son opcionales por cada formato. `priceVersion` cambia cuando varía un precio o formato que afecte a la venta, pero no con cambios de stock. Una equivalencia conocida mantiene el stock como unidades completas y subunidades sueltas normalizadas. Sin equivalencia conocida, `stockSubunits` es `null`. Para productos `SUBUNIT` sin equivalencia y `stockUnits=0`, la disponibilidad pública se considera activa como venta por porciones no inventariadas (por ejemplo, café o chocolate por vaso): se registra cantidad e importe sin descontar recipientes inexistentes. Si se registran recipientes (`stockUnits>0`) y se desconoce el rendimiento, la venta por porciones conserva el número de recipientes y la dueña debe ajustar manualmente el stock cuando se vacíe; el sistema no inventa cuántas porciones quedan.

### POST `/api/v1/products`, PUT `/api/v1/products/:id`, DELETE `/api/v1/products/:id`

Crear/editar usan multipart: `product` como JSON y `image` como fichero opcional JPG/PNG/WebP de máximo 5 MiB (ajustable con `MAX_IMAGE_BYTES`). Crear permite stock inicial. Editar conserva el stock actual; para cambiar existencias se usa ajuste de inventario. Si se modifica la equivalencia, el inventario debe estar en cero para no reinterpretar cantidades anteriores. `DELETE` desactiva lógicamente y conserva las ventas.

Las imágenes se guardan en Supabase Storage si están configurados `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`; en otro caso se guardan en `UPLOAD_DIR`.

## Ajustes de inventario

### POST `/api/v1/inventory/adjustments`

Solo dueña. Request: `{"productId":"UUID","unitDelta":5,"subunitDelta":0,"reason":"Reposición"}`. La operación usa bloqueo de fila y transacción, no permite saldo negativo, actualiza el inventario y crea movimiento y auditoría. Para productos de rendimiento desconocido, no se permite declarar un delta de subunidades distinto de cero.

## Ventas offline e idempotencia

### POST `/api/v1/sales`

Requiere `Authorization: Bearer ...` y `Idempotency-Key` idéntico a `clientSaleId`. El cuerpo sigue el ejemplo del contrato Android. `workerId` debe coincidir con el usuario autenticado. La API no confía en `workerName`, los precios, el total, ni las existencias enviados por el cliente; vuelve a consultar el catálogo y el usuario en el servidor.

La operación, en una sola transacción:

1. Bloquea el identificador de idempotencia y comprueba si ya fue aceptado.
2. Si ya existe con el mismo hash del cuerpo, devuelve la venta original; no modifica stock ni caja otra vez. Si se reutiliza con datos diferentes, devuelve `409 IDEMPOTENCY_KEY_REUSED`.
3. Bloquea las filas de productos en orden estable y valida existencia, formato, versión y método de pago.
4. Recalcula importes con los precios del servidor y compara cada subtotal y el total.
5. Inserta venta y detalles; actualiza stock, crea movimientos y escribe auditoría antes de confirmar la transacción.

`PRICE_CHANGED`, `SALE_FORMAT_CHANGED`, `INSUFFICIENT_STOCK`, `PRICE_SNAPSHOT_MISMATCH` y otros conflictos no producen mutaciones parciales. La app debe conservar la venta local y marcarla para revisión ante `409`/`422`; los fallos temporales pueden reintentarse con el mismo ID y el mismo cuerpo.

` sold_at_original` conserva el timestamp de evento con su offset; `sold_at` permite buscar por instante temporal y `received_at` registra recepción del servidor. La zona horaria del dispositivo se conserva como contexto. La hora de la venta reportada por un dispositivo offline no se puede verificar criptográficamente contra su reloj.

Para una equivalencia conocida, el stock se convierte a saldo base y se normaliza; vender 21 subunidades consume el equivalente de 1 unidad y 1 subunidad. El importe, sin embargo, se calcula según la forma de venta realmente registrada (21 subunidades al precio de subunidad), no sustituyendo silenciosamente ese precio por el precio de una unidad completa. Sin rendimiento conocido, las porciones generan importe pero no convierten inventario de forma ficticia.

### GET `/api/v1/sales`

Filtros opcionales `from`, `to`, `workerId`, `limit` (máximo 500). Dueña ve su equipo; trabajadora solo sus propias ventas. Cada venta incluye `id`, `clientSaleId`, `soldAt`, `workerId`, `workerName`, `summary`, `paymentMethod`, `totalCUP` y `status`.

## Panel y estadísticas

### GET `/api/v1/dashboard?from=...&to=...`

Solo dueña. Sin intervalo, usa el día actual de `businesses.time_zone`. Entrega:

- `cashCup`: suma aceptada con efectivo.
- `transferCup`: suma aceptada marcada como transferencia (no es confirmación bancaria).
- `saleCount`: operaciones aceptadas.
- `lowStockCount`: productos activos bajo el mínimo configurado.
- `totalInventoryValueCash` y `totalInventoryValueTransfer`: valoración por precios de venta; `null` si falta un precio, una equivalencia o un rendimiento que impida una cifra exacta.

## Avisos

### GET `/api/v1/announcements?includeScheduled=false`

Público y clientes: solo avisos publicados y no vencidos. `includeScheduled=true` es exclusivo de la dueña e incluye estados programados/publicados/cancelados/vencidos.

### POST `/api/v1/announcements`

Request: `title`, `message`, `publishAt` ISO-8601 con offset, `expiresAt` opcional y `sendPushNotification` booleano. Crea un aviso `SCHEDULED`; un proceso del servidor lo publica a la hora indicada, aunque la app de la dueña esté cerrada. Debe ejecutarse en una instancia que permanezca encendida para cumplir la programación a su hora. Varias instancias coordinan el trabajo mediante bloqueos de PostgreSQL.

### PATCH `/api/v1/announcements/:id/cancel`

Solo dueña; cancela avisos programados o publicados y detiene los envíos que todavía estén pendientes en la cola.

## Equipo

- `GET /api/v1/team`: lista trabajadoras de la cafetería.
- `POST /api/v1/team`: crea `WORKER` con `displayName`, `identifier`, `temporaryPassword` (mínimo 8 caracteres para coincidir con la validación de la app). No permite elegir `OWNER` ni `CUSTOMER`.
- `PATCH /api/v1/team/:id/status`: body `{"active":true|false}`. Desactivar revoca sesiones y conserva el historial.

Las contraseñas se hash con bcrypt; nunca aparecen en las respuestas.

## Push

- `POST /api/v1/devices/push-token`: `{"token":"...","deviceId":"...","platform":"ANDROID"}`. Admite visitantes sin sesión para clientes y asocia cuentas autenticadas al negocio de la sesión. Los tokens de cuentas de dueña/trabajadora no reciben avisos públicos.
- `POST /api/v1/devices/push-token/revoke` (extra): `{"deviceId":"..."}` desactiva el registro de notificaciones del dispositivo.

El planificador crea una fila de outbox por aviso y dispositivo, reintenta errores temporales y desactiva tokens inválidos. Si falta Firebase, la cola se mantiene pendiente en vez de indicar falsamente que se entregó. FCM es de tipo al menos una vez; una caída justo después de la aceptación puede provocar duplicados ocasionales.

## Directorio multi-negocio (extra)

### GET `/api/v1/businesses`

Devuelve lista pública de negocios activos para una app multi-cafetería. En una instalación dedicada configura `PUBLIC_BUSINESS_SLUG` para resolver las peticiones públicas sin selector.

## Códigos comunes

- `401 UNAUTHORIZED`: sesión ausente, inválida o vencida.
- `403 FORBIDDEN`: rol o permiso insuficiente.
- `404 NOT_FOUND`: recurso no encontrado dentro del negocio autenticado.
- `409`: conflicto de inventario, versión, clave idempotente o negocio.
- `422`: solicitud o cantidades no válidas.
- `429 RATE_LIMITED` / `LOGIN_RATE_LIMITED` / `CUSTOMER_REGISTER_RATE_LIMITED`: límite temporal de solicitudes.
- `5xx`: error temporal; la venta local debe conservarse y puede reintentarse con idéntico cuerpo.


## Estadísticas extendidas (`GET /api/v1/dashboard`)

Disponible solo para `OWNER`. Acepta `from` y `to` ISO-8601 con offset; `from` se incluye y `to` se excluye. Además de `cashCup`, `transferCup`, `saleCount`, inventario, devuelve:

- `productSales[]`: `productId`, `productName`, `unitName`, `subunitName`, `unitQuantity`, `subunitQuantity`, `totalCup`, `cashCup`, `transferCup`. Las cantidades se suman desde las líneas `sale_items` de ventas aceptadas y no dependen del stock configurado.
- `workerSales[]`: `workerId`, `workerName`, `saleCount`, `cashCup`, `transferCup`, `totalCup`, `unitQuantity`, `subunitQuantity`. Los importes se agregan desde `sales` y las cantidades desde `sale_items`, sin multiplicar importes por el número de artículos de cada venta.

Las ventas `REVERSED` no se incluyen. El servidor aplica el intervalo a `sales.sold_at`, que conserva la hora original de la venta.

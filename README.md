# Backend de Cafetería — API v1

Servidor REST para la app Android de la cafetería. Está diseñado para que la aplicación pueda registrar ventas con o sin conexión y sincronizarlas después sin cambiar su identificador ni la hora original.

## Incluye

- Autenticación con contraseñas hash y sesiones Bearer revocables.
- Registro público de clientes y un único inicio de sesión para dueña, trabajadoras y clientes. El backend resuelve el rol real y nunca permite al cliente elegirlo.
- Roles `OWNER`, `WORKER` y `CUSTOMER`, con permisos aplicados en el servidor.
- Separación de datos por cafetería (`business_id`) en todas las consultas y escrituras.
- Catálogo público con disponibilidad sin revelar cantidades exactas de inventario; inventario detallado solo para dueña/trabajadoras autenticadas.
- Productos con precios CUP separados para efectivo y transferencia; el precio de transferencia puede omitirse por formato de venta.
- Imágenes verificadas por contenido JPG/PNG/WebP, límite de tamaño y almacenamiento local o en Supabase Storage.
- Ventas transaccionales: inventario, detalle, historial, movimientos y auditoría se guardan juntos.
- Idempotencia por `clientSaleId` + `Idempotency-Key`; también se compara la huella del cuerpo para rechazar si un identificador se reutiliza con datos distintos.
- Validación del precio/versión vigente; las ventas incompatibles se rechazan con `409` para que la app conserve la fila local en `NEEDS_REVIEW`.
- Estadísticas en la zona horaria de la cafetería, separando efectivo de transferencias declaradas.
- Equipo de trabajadoras, desactivación de cuentas y revocación de sesiones.
- Avisos programados con cola duradera de notificaciones push mediante Firebase Cloud Messaging.
- Pruebas unitarias de conversión de existencias, validación de importes, tokens y fechas.

No se insertan productos, usuarios, contraseñas ni ventas de demostración. La primera cuenta administrativa se crea expresamente mediante el comando de inicialización.

## Requisitos

- Node.js 24 LTS recomendado (se admite Node 22 o superior dentro de la gama indicada en `package.json`).
- PostgreSQL 14 o posterior. Puede ser una base PostgreSQL administrada, incluida la de Supabase.
- Para notificaciones: proyecto Firebase y credencial de servicio del lado del servidor.
- Para imágenes persistentes: Supabase Storage o un volumen persistente montado en `UPLOAD_DIR`.

## Instalación local

1. Copia `.env.example` a `.env` y configura `DATABASE_URL` con una base de datos propia. No reutilices una base con tablas de otro proyecto sin revisar el esquema.
2. Instala dependencias:

   ```bash
   npm install
   ```

3. Aplica el esquema SQL:

   ```bash
   npm run migrate
   ```

4. Rellena las variables `BOOTSTRAP_*` para crear la cafetería y su primera dueña, y ejecuta:

   ```bash
   npm run bootstrap-owner
   ```

   El comando exige una contraseña inicial de al menos 12 caracteres. Solo muestra el identificador creado; nunca imprime la contraseña. Si ya existe una dueña, no restablece ni reemplaza credenciales.

5. Inicia el servidor:

   ```bash
   npm start
   ```

   La API escucha en `PORT` (3000 por defecto). `GET /health` comprueba el proceso y `GET /health/ready` comprueba que las migraciones principales estén disponibles.

### Configuración mínima de ejemplo

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...tu-conexion-real...
DATABASE_SSL=true
PUBLIC_BASE_URL=https://...tu-host-real...
PUBLIC_BUSINESS_SLUG=...slug-configurado-al-crear-la-cafeteria...
BUSINESS_TIME_ZONE=America/Havana
```

El bloque anterior describe nombres y formatos; no es una conexión operativa ni incluye credenciales.

## Despliegue en Render

1. Crea un servicio web Node.js y configura el repositorio/carpeta `CafeteriaBackend`.
2. Usa `npm install` como comando de compilación y `npm start` como comando de inicio.
3. Configura en el panel las variables reales: `DATABASE_URL`, `DATABASE_SSL`, `PUBLIC_BASE_URL`, `PUBLIC_BUSINESS_SLUG`, `UPLOAD_DIR`, y las variables de almacenamiento y Firebase que vayas a usar. Nunca subas `.env` al repositorio.
4. Ejecuta `npm run migrate` como comando de predespliegue o una sola vez en una terminal del servicio. No inicies producción antes de aplicar las migraciones.
5. Si usas almacenamiento local para imágenes, monta un disco persistente en la ruta configurada en `UPLOAD_DIR`. El sistema de archivos efímero de un servicio web puede perder imágenes en un redeploy. La alternativa recomendada es Supabase Storage.
6. Para que un aviso programado salga a su hora incluso si no hay visitas, el servidor debe permanecer encendido. No uses un servicio que se duerma o se suspenda por inactividad para la instancia que ejecuta el planificador; los avisos vencidos se recuperan al reiniciar, pero no pueden enviarse mientras el proceso está apagado.
7. Comprueba `/health/ready`, prueba el login de dueña y registra primero productos reales antes de conectar la app.

### Conexión a Supabase

- `DATABASE_URL`: utiliza la cadena PostgreSQL del proyecto y confirma que la conectividad/SSL coincida con `DATABASE_SSL`.
- `SUPABASE_URL`: URL del proyecto.
- `SUPABASE_SERVICE_ROLE_KEY`: clave de servicio protegida, solo en el backend. **Nunca la metas en la app Android ni la publiques.**
- `SUPABASE_STORAGE_BUCKET`: bucket que debes crear para las imágenes de la cafetería. Como las fotos del catálogo son públicas, configura lectura pública en ese bucket; las escrituras las realiza exclusivamente el backend con su clave de servicio.
- Cuando estén configuradas `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`, el backend sube y borra imágenes en ese bucket. Si ambas faltan, usa `UPLOAD_DIR` local.

### Notificaciones Firebase

Configura **una** de estas opciones en el servidor:

- `FIREBASE_SERVICE_ACCOUNT_JSON`: JSON completo de la cuenta de servicio en una variable secreta, o
- `GOOGLE_APPLICATION_CREDENTIALS`: ruta a un fichero de cuenta de servicio montado de forma segura.

En la app Android deben configurarse sus propias propiedades Firebase (`FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_PROJECT_ID`, `FIREBASE_SENDER_ID`) al compilar y el usuario debe permitir las notificaciones. El backend no necesita ni debe recibir la API key del cliente Android. Los tokens se registran de forma individual por dispositivo. Las publicaciones quedan guardadas aunque Firebase no esté configurado; la entrega push permanece pendiente hasta configurarlo.

## Cola offline y coherencia de las ventas

La app escribe la venta en Room con `clientSaleId`, `soldAt`, datos de la trabajadora, cantidades, método de pago y precios capturados. El backend conserva `sold_at_original` además del instante temporal y `received_at`, la hora del servidor. Así el historial puede mostrar cuándo ocurrió la venta y cuándo llegó al servidor.

La petición debe repetir el mismo `Idempotency-Key` y el mismo cuerpo. La base de datos impide dos ventas con el mismo ID dentro de la cafetería. Si la petición llegó al servidor pero la respuesta se perdió, el reintento devuelve el resultado original, sin volver a descontar existencias.

Los importes nunca se aceptan como autoridad del dispositivo: se recalculan con precios y formatos del servidor. Si se cambió el precio mientras el dispositivo estaba offline, o el stock compartido ya no alcanza, el servidor devuelve un conflicto sin aplicar cambios parciales. La app conserva la venta local para revisión.

Cuando existe equivalencia —por ejemplo, una caja son 20 cigarros— la existencia se convierte a un saldo canónico y se normaliza al mostrar el inventario. Una venta de 21 cigarros sueltos se cobra con el precio por cigarro; el stock restante queda normalizado como unidades completas más subunidades. **No** se cambia el precio por haber normalizado el inventario. Cuando no se conoce el rendimiento —por ejemplo, bolas por recipiente de helado— se registra el ingreso por porciones sin inventar una equivalencia; el valor total del inventario se informa como `null` cuando no pueda calcularse exactamente.

El backend confía en `workerId` solo si coincide con el usuario autenticado, y guarda el nombre de trabajadora de la base de datos. `workerName`, el precio, el total y el stock enviados por el dispositivo nunca autorizan una venta.

## API principal

Todas las respuestas usan `{ "data": ..., "message": "...", "code": "..." }`. Importes en CUP son enteros. Las rutas protegidas usan `Authorization: Bearer <accessToken>`.

| Método | Ruta | Permiso | Función |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | Público | Acceso único por usuario/contraseña; devuelve el rol real |
| `GET` | `/api/v1/auth/me` | Sesión | Datos de la sesión |
| `POST` | `/api/v1/auth/logout` | Sesión | Revocar sesión |
| `POST` | `/api/v1/auth/register-customer` | Público | Registro de clientes (límite por IP) |
| `POST` | `/api/v1/auth/customer-login` | Público | Acceso legado de clientes para versiones Android anteriores |
| `GET` | `/api/v1/businesses` | Público | Directorio para instalación multi-negocio |
| `GET` | `/api/v1/products` | Público o sesión | Catálogo público / inventario de equipo |
| `POST` | `/api/v1/products` | Dueña | Crear producto e inventario inicial |
| `PUT` | `/api/v1/products/:id` | Dueña | Editar producto sin alterar stock |
| `DELETE` | `/api/v1/products/:id` | Dueña | Desactivar producto conservando historial |
| `POST` | `/api/v1/inventory/adjustments` | Dueña | Reponer/corregir existencias con auditoría |
| `POST` | `/api/v1/sales` | Dueña/trabajadora | Confirmar venta idempotente y descontar stock |
| `GET` | `/api/v1/sales` | Dueña/trabajadora | Historial: dueña ve el equipo; trabajadora solo sus ventas |
| `GET` | `/api/v1/dashboard` | Dueña | Estadísticas y valoración de existencias |
| `GET` | `/api/v1/announcements` | Público/sesión | Avisos publicados o agenda de la dueña |
| `POST` | `/api/v1/announcements` | Dueña | Crear aviso programado |
| `PATCH` | `/api/v1/announcements/:id/cancel` | Dueña | Cancelar aviso |
| `GET` | `/api/v1/team` | Dueña | Listar trabajadoras |
| `POST` | `/api/v1/team` | Dueña | Crear cuenta `WORKER` (nunca una dueña) |
| `PATCH` | `/api/v1/team/:id/status` | Dueña | Activar/desactivar cuenta y revocar sesiones |
| `POST` | `/api/v1/devices/push-token` | Público/sesión | Registrar token FCM |
| `POST` | `/api/v1/devices/push-token/revoke` | Público/sesión | Desactivar token del dispositivo |

Para un servidor con una sola cafetería, configura `PUBLIC_BUSINESS_SLUG`. Si hay varias cafeterías en una misma instancia, el catálogo y los registros anónimos pueden usar el encabezado `X-Business-Slug`; las sesiones autenticadas quedan atadas a su negocio. Nunca se acepta un `businessId` arbitrario del teléfono para ampliar permisos.

Detalles de los esquemas y ejemplos: [`API_CONTRACT_V1.md`](API_CONTRACT_V1.md).

## Pruebas y verificación

```bash
npm test
npm run check
```

Las pruebas unitarias no requieren PostgreSQL. Para verificar la API de punta a punta hay que aplicarla contra una base de datos PostgreSQL de pruebas, crear una dueña con el comando bootstrap y comprobar login, permisos, ventas repetidas, stock insuficiente, ajustes y programación de avisos. No apuntes pruebas de integración a datos de clientes.

## Estado de validación

Consulta [`VALIDATION.md`](VALIDATION.md) para distinguir las pruebas unitarias ejecutadas de las verificaciones de integración todavía pendientes.

## Seguridad y límites conocidos

- Los tokens de sesión se generan al azar; en la base de datos solo se almacena su hash SHA-256. Las contraseñas se guardan con bcrypt y nunca se devuelven por API.
- Las claves de base de datos, almacenamiento y Firebase son solo del servidor.
- Los errores públicos no incluyen consultas SQL ni trazas.
- La hora `soldAt` preserva lo reportado por el dispositivo; `received_at` aporta un punto de auditoría del servidor. Un dispositivo con el reloj manipulado no puede demostrar por sí solo la hora física exacta de una venta offline.
- El servicio registra transferencias declaradas; no comprueba automáticamente una transacción bancaria.
- El envío push es de tipo al menos una vez: las filas se reintentan y se deduplican en cola, pero una caída de red justo después de que FCM acepte el mensaje puede causar una notificación repetida.
- Se debe configurar respaldo automático de PostgreSQL y probar su restauración antes de usar con dinero real.

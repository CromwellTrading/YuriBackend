# Estado de validación — Backend Cafetería

## Verificado en este entorno

- Sintaxis de los 26 archivos JavaScript del proyecto: correcta.
- Importaciones relativas entre archivos locales: todas resuelven a archivos existentes.
- Pruebas unitarias: **16 aprobadas, 0 fallidas** (`npm test`).
- Reglas probadas: tokens de sesión, normalización de usuarios, fechas con zona horaria, validación de zona IANA, conversión de unidades/subunidades, rechazo de stock negativo o insuficiente, ajustes y precios opcionales por transferencia.
- No se encontraron claves privadas ni claves de servicio incrustadas en los archivos de código revisados.

## Pendiente de verificación de integración

Este entorno no tiene PostgreSQL/`psql` ni Docker disponibles. La instalación de dependencias de npm no pudo completarse por falta de acceso utilizable al registro desde el entorno. Por eso **no se ha iniciado el servidor contra una base de datos real ni se ha aplicado la migración a una instancia PostgreSQL**. Tampoco se pudo enviar una notificación real a Firebase Cloud Messaging.

Antes de usarlo con ventas reales, hay que ejecutar en una base de pruebas nueva:

1. `npm install`
2. `npm run migrate`
3. Definir variables `BOOTSTRAP_*` y ejecutar `npm run bootstrap-owner`.
4. `npm run check`
5. Iniciar con `npm start`, comprobar `/health/ready`, login, permisos, creación de productos, ventas duplicadas con la misma clave, falta de stock, trabajo offline/reintento, ajustes, programación de avisos y push con Firebase.

No apuntes las pruebas a datos reales. Configura copias de seguridad y verifica una restauración antes de producción.

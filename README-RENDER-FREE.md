# Configuración de CafeteriaBackend sin Render Shell (plan gratuito)

Este kit resuelve dos tareas que no requieren ejecutar comandos en Render:

1. Crear las tablas y registrar la migración desde Supabase SQL Editor.
2. Crear la primera cuenta OWNER desde Supabase SQL Editor.
3. Opcionalmente, añadir un GitHub Actions Workflow que haga una petición HTTP entrante a `/health` cada cinco minutos.

## A. Aplicar las tablas

1. Abre Supabase Dashboard -> proyecto de la cafetería -> SQL Editor.
2. Pulsa New query.
3. Abre `supabase-sql/01_apply_schema.sql`, copia todo su contenido y pégalo en el editor.
4. Pulsa Run una sola vez.
5. Comprueba que la consulta final indica las tablas `businesses`, `products` y `sales`, y que `schema_migrations` contiene `001_initial.sql`.

El archivo es la migración original `001_initial.sql` del backend. Al final inserta su nombre en `schema_migrations`, para que el comando de migraciones no intente reaplicarla más tarde.

## B. Crear la primera dueña

1. Abre `supabase-sql/02_create_first_owner.sql`.
2. Cambia los valores dentro de la sección `DECLARE`:
   - `v_business_name`: nombre visible de la cafetería.
   - `v_business_slug`: identificador único, minúsculas/números/guiones, sin espacios. Debe coincidir con `PUBLIC_BUSINESS_SLUG` en Render.
   - `v_owner_name`: nombre de la dueña.
   - `v_owner_identifier`: Nick de inicio de sesión (mínimo 3 caracteres).
   - `v_owner_password`: contraseña de mínimo 12 caracteres y máximo 72 bytes UTF-8.
   - `v_time_zone`: `America/Havana`.
3. Ejecuta el SQL una sola vez en Supabase SQL Editor.
4. Verifica con la consulta comentada al final. No muestra ni consulta la contraseña.
5. No publiques ni subas a GitHub una copia del script que contenga la contraseña.

El hash se genera dentro de PostgreSQL con `pgcrypto` usando bcrypt. El script se detiene si ya existe una cuenta OWNER para ese negocio; no cambia contraseñas ni reemplaza usuarios existentes.

## C. Añadir Keep Alive por GitHub Actions (opcional)

1. En el repositorio de GitHub crea la ruta `.github/workflows/` en la raíz del repositorio.
2. Sube `render-keepalive.yml` dentro de esa ruta.
3. En GitHub: Settings -> Secrets and variables -> Actions -> Variables -> New repository variable.
4. Crea `RENDER_SERVICE_URL` con la URL base de Render, por ejemplo `https://mi-cafeteria.onrender.com` (sin `/health` y sin barra final).
5. Abre Actions y ejecuta manualmente `Render Free Keep Alive` una vez para verificarlo.

El Workflow consulta `/health`, que no necesita contraseña y no consulta PostgreSQL; así evita añadir una consulta de base de datos en cada ping. Se programa cada cinco minutos y reintenta hasta cinco veces para tolerar el arranque en frío.

### Límites importantes

- Un `setInterval` dentro del propio backend NO evita que Render Free se duerma: cuando Render apaga el proceso, el temporizador deja de existir.
- GitHub Actions sí envía tráfico entrante desde fuera y puede mantener activo el servicio mientras las ejecuciones se produzcan a tiempo. No es garantía de disponibilidad: GitHub puede retrasar tareas programadas y Render puede reiniciar o suspender servicios gratuitos.
- Render Free suspende el servicio tras 15 minutos sin tráfico entrante y asigna 750 horas gratuitas por workspace al mes. Un keep-alive activo todo el mes consume aproximadamente todas las horas de un servicio continuo, compartidas con otros servicios gratuitos del mismo workspace.
- Render indica expresamente que las instancias gratuitas son para pruebas/hobby y no para aplicaciones en producción. Para ventas reales, avisos puntuales y operaciones de caja, se recomienda una instancia que no se duerma.
- El planificador de avisos del backend solo funciona mientras el proceso esté encendido. El Workflow ayuda a mantenerlo activo; no sustituye una cola fiable ni un plan de hosting permanente.

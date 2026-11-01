# Backend YuriCoofe 1.2.0

- `POST /api/v1/auth/login` acepta el flujo unificado de autenticación.
- `OWNER` y `WORKER` se validan por el identificador interno creado por la dueña.
- `CUSTOMER` se identifica por nombre visible y contraseña dentro del negocio público configurado.
- El backend emite el rol guardado en la base de datos; la solicitud nunca puede seleccionar ni elevar el rol.
- Se conserva `POST /api/v1/auth/customer-login` para compatibilidad con clientes Android anteriores.
- No se requiere migración de base de datos.

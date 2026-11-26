# Especificación — App Alumnos Xarxatec Activa

## 1. Visión

Xarxatec Activa es una formación que capacita a perfiles de diversa índole en
tecnologías para facilitarles el acceso al mercado laboral IT. Esta aplicación
web permite a las **empresas** consultar con facilidad los **perfiles de alumnos
que terminaron con éxito** la formación, ver sus proyectos y contactarlos.

La plataforma **solo contiene alumnos que finalizaron con éxito** la formación;
no se almacenan datos de alumnos que no la completaron.

## 2. Actores y roles

| Rol | Descripción | Alta |
| --- | --- | --- |
| `ADMIN` | Gestor de la asociación. Gestiona ediciones, alumnos y empresas. | Operación aparte (staff). |
| `SOCIO` | Empresa que consulta perfiles. | Creada por invitación del admin. |
| `ALUMNO` | Alumno que finalizó la formación. | Creado por el admin al marcarlo como finalizado. |

**No hay registro público.** Todas las cuentas se crean por invitación.

## 3. Autenticación y seguridad

> Enforcement de privacidad: al usar autenticación propia (no Supabase Auth),
> las RLS de Supabase no se activan solas. La frontera de seguridad es el
> **backend (Hono)**, que autoriza con el `Actor {id, rol}` de la sesión.
> Opcionalmente se puede añadir RLS como segunda barrera más adelante.

### Contraseñas
- Hash **Argon2id** con parámetros `m=19456, t=2, p=1`.
- Longitud entre **12 y 256** caracteres; fuera de rango → error de datos no válidos.

### Sesiones (en servidor, NO JWT)
- Token opaco = **32 bytes** aleatorios criptográficos (`randomBytes`) en base64url.
  Prohibido uuid/relojes/PRNG no seguros como secreto.
- En la tabla `sessions` se guarda **solo el SHA-256 (hex)** del token, nunca el token en claro.
- Duración **30 días**. Renovación deslizante: si al resolver la sesión quedan
  menos de **15 días**, se extiende la caducidad a 30 días y se repone la cookie.
- Resolver sesión devuelve `null` (y borra la fila) si: no existe, está caducada,
  o el usuario ya no existe. Devuelve además un `Actor {id, rol}` para autorizar.

### Cookie
- Nombre `sesion`. Flags obligatorios: `HttpOnly`, `SameSite=Lax`, `Path=/`.
  `Secure` solo en producción.
- Usar `Expires` (fecha absoluta), **no** `Max-Age`.
- El token viaja **solo en la cookie**: nunca en body, URL ni almacenamiento del navegador.

### Endpoints (`/api/*`)
- `POST /api/auth/register` — **restringido a ADMIN** (crea cuentas por invitación; no hay registro público).
- `POST /api/auth/login` (público): crea sesión nueva **siempre** e invalida la sesión previa que trajera la cookie.
- `POST /api/auth/logout` (requiere sesión): borra la sesión en BD (idempotente) y limpia la cookie.
- `GET /api/me`: devuelve el usuario actual (proyección pública, sin hash) a partir de la cookie.

### Anti-enumeración
- Email ya registrado → `409` con mensaje genérico "No se ha podido completar el registro".
- Login: mismo error (mensaje + estado) y **mismo coste temporal** tanto si el
  email no existe como si la contraseña es incorrecta (verificar contra un
  `HASH_SEÑUELO` cuando el email no existe para igualar tiempos).

### Verificación de email
- Las cuentas creadas por invitación nacen con `emailVerified=false`.
- Se envía un email con enlace de verificación (token de un solo uso, caducidad limitada), vía proveedor de email (p. ej. Resend).
- Hasta verificar, el acceso real queda bloqueado.

### Auditoría
- Cada mutación escribe en `Audit_log` desde la capa de aplicación
  (`idUsuario, tabla, idRegistro, operación, datosAnteriores, datosNuevos, timestamp`).
- **Nunca** auditar el hash de la contraseña.

## 4. Funcionalidades por fases

### Fase 1 — Núcleo
**Administrador**
- Gestión de **ediciones** (crear, cerrar).
- Alta de **alumnos finalizados** y asociación a su edición.
- Alta de **empresas por invitación** y marcado de empresas **socias**.
- Dashboard con métricas (alumnos activos/inactivos, % inserción, perfiles más vistos).

**Alumno**
- Acceso solo tras ser marcado como finalizado por el admin.
- Ficha con datos estructurados y filtrables: stack/tecnologías (+nivel),
  idiomas, ubicación, disponibilidad de traslado, modalidad
  (remoto/presencial/híbrido), estado laboral (buscando/trabajando), CV,
  LinkedIn, GitHub, foto, bio.
- **Control granular de privacidad** por campo + estado **activo/inactivo** que
  el propio alumno gestiona (inactivo = sus datos siguen en el sistema pero no
  los ven las empresas). Un administrador también puede inactivar a un alumno.
- **Consentimiento explícito** al publicar y **derecho al olvido** (borrado de datos).
- Registrar **proyectos** vinculados a su perfil (URL válida: repo/web), con
  **miniatura subida manualmente** (1ª iteración; auto-generación aparcada).

### Fase 2 — Escaparate y empresas
- **Escaparate público** de proyectos con miniatura (respetando visibilidad).
- Vista de **ediciones** → *cards* de los alumnos que terminaron (ocultando a los no visibles).
- **Empresa:** búsqueda y **filtrado estructurado** de alumnos (tecnología,
  edición, disponibilidad, estado...).
- **Bookmarks** de perfiles de interés.
- **Contacto vía email** (según consentimiento del alumno).
- Sección de **alumnos que trabajan en empresas socias**.

### Fase 3 — Automatizaciones (Sistema)
- Al marcar alumno como finalizado → **email de invitación** a rellenar ficha.
- Ciclo de **recordatorios** si no rellena: refuerzo a los **14, 21 y 25 días**;
  si a los **30 días** no ha rellenado → **inactivo**. Al rellenar → se detienen.
- **Recordatorio anual** a alumnos activos para revisar datos.

### Fase 4 — Chatbot (futuro)
- Recibe una **oferta de trabajo** y devuelve los **perfiles reales** que mejor
  encajan, con enlace a su *card*.
- **Guardarraíles:** no revela alumnos ocultos y solo responde dentro del
  alcance (filtrar candidatos); ante preguntas fuera de tema responde,
  educadamente, que no está permitido.

## 5. Modelo de datos (borrador)

> Detalle completo (con tipos, claves y diagrama) en
> [`modelo-entidad-relacion.md`](./modelo-entidad-relacion.md). Convención:
> tablas en singular con primera mayúscula (`snake_case`), campos en minúscula
> `snake_case`, y tablas puente N:M con las dos tablas ordenadas alfabéticamente
> + sufijo `_rel`.

- **User**: id, email (único sobre `lower(email)`), password_hash, rol, email_verified, created_at
- **Session**: id, user_id, token_sha256 (hex), expires_at, created_at
- **Email_verification_token**: id, user_id, token_sha256, expires_at, used_at, created_at
- **Edition**: id, nombre, anio, fecha_inicio, fecha_fin, estado
- **Student**: id, user_id, edition_id, nombre, foto_url, bio, ubicacion,
  disponibilidad_traslado (bool), modalidad, estado_laboral, cv_url, linkedin,
  github, current_company_id (nullable), consent_at, estado (activo/inactivo),
  privacy (json por campo), filled_at, created_at
- **Skill** + **Skill_student_rel** (N:M, con nivel)
- **Language** + **Language_student_rel** (N:M, con nivel)
- **Project**: id, student_id, titulo, descripcion, url, thumbnail_url, created_at
- **Company**: id, nombre, es_socia (bool), contacto, created_by
- **Company_user_rel**: company_id, user_id
- **Company_student_rel** (bookmarks): company_id, student_id, created_at
- **Reminder_state**: student_id, invited_at, recordatorios_enviados, filled_at, estado
- **Audit_log**: id, id_usuario, tabla, id_registro, operacion, datos_anteriores, datos_nuevos, timestamp

## 6. Privacidad / RGPD
- Consentimiento explícito obligatorio antes de publicar datos.
- Control granular por campo + estado **activo/inactivo** del perfil (lo cambia
  el alumno o un administrador).
- **Derecho al olvido:** el alumno puede ejercerlo; supone el **borrado** de sus
  datos del sistema (no es un estado).
- Un alumno **inactivo** **nunca** aparece en escaparate, ediciones, búsqueda ni
  respuestas del chatbot; solo los **activos** son consultables por empresas.

## 7. Stack técnico
- **Frontend:** VanillaJS + TypeScript.
- **Backend:** Node.js + Hono (TypeScript).
- **BD:** Supabase (Postgres). Supabase Auth **no** se usa (auth propia).
- **Storage:** Supabase Storage (fotos, CVs, miniaturas).
- **Email:** proveedor transaccional (p. ej. Resend) para verificación y recordatorios.
- **Scheduler:** pg_cron / scheduled functions para recordatorios.

### Arquitectura
La aplicación sigue el patrón **Modelo-Vista-Controlador (MVC)**:
- **Modelo:** entidades de dominio y acceso a datos (Supabase/Postgres); encapsula
  las reglas de negocio y las consultas. La capa de aplicación aplica aquí el
  enforcement de privacidad y la escritura en `Audit_log`.
- **Vista:** interfaz de usuario en VanillaJS + TypeScript (escaparate, fichas,
  paneles); solo presentación, sin lógica de negocio.
- **Controlador:** rutas/handlers de Hono bajo `/api/*`; reciben la petición,
  autorizan con el `Actor {id, rol}` de la sesión, orquestan el modelo y
  devuelven la respuesta a la vista.

## 8. Decisiones y pendientes
- [Decidido] Miniaturas subidas manualmente en la 1ª iteración.
- [Decidido] Sin registro público; cuentas por invitación.
- [Decidido] Roles ADMIN / SOCIO / ALUMNO con verificación de email.
- [Pendiente] Proveedor de email concreto.
- [Pendiente] Detalle del dashboard de métricas.
- [Futuro] Chatbot con modelo local y auto-generación de miniaturas.

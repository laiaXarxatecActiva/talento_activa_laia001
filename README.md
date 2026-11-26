# App Alumnos Xarxatec Activa — API

Backend (Node.js + Hono + TypeScript) de la plataforma donde las empresas
consultan los perfiles de los alumnos que finalizaron con éxito Xarxatec Activa.
Especificación en [`docs/`](docs/); reglas del proyecto en [`CLAUDE.md`](CLAUDE.md).

**Estado:** Fase 1 (Núcleo) del backend completada — ver
[`docs/plan-desarrollo.md`](docs/plan-desarrollo.md). Aún no hay frontend.

## Puesta en marcha

1. Crea un proyecto en [Supabase](https://supabase.com) y ejecuta
   [`docs/seed.sql`](docs/seed.sql) en el **SQL Editor**.
2. `cp .env.example .env` y rellena al menos `DATABASE_URL` (botón *Connect* →
   *Transaction pooler*, puerto 6543).
3. Instala y comprueba:

   ```bash
   npm install
   npm test            # tests contra tu Supabase (todo se deshace al acabar)
   npm run typecheck
   ```

4. Crea el primer administrador (pide la contraseña sin mostrarla):

   ```bash
   npm run create-admin -- admin@tu-dominio.com
   ```

5. Arranca: `npm run dev` (recarga al guardar) o `npm start`.
   Escucha en `http://localhost:3000` (cámbialo con `PORT`).

Opcional:
- **Emails** (`RESEND_API_KEY`, `EMAIL_FROM`): sin clave, los emails de
  invitación se escriben en la consola del servidor con el enlace.
- **Miniaturas** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET`): crea un bucket **público** en Storage. Sin
  configurar, la subida responde `503`.

## Flujo de invitación

1. El ADMIN da de alta a un alumno (`POST /api/admin/students`), una empresa
   (`POST /api/admin/companies`); `POST /api/auth/register` es equivalente
   (SOCIO con `company_id`, ALUMNO con `edition_id` + `nombre`).
2. El invitado recibe un email con `APP_URL/verificar?token=…` (7 días, un uso).
3. El frontend envía `POST /api/auth/verify {token, password}`: fija la
   contraseña y verifica el email. Ya puede hacer login.

## API

Todas las rutas van bajo `/api`, aceptan y devuelven JSON. La sesión viaja
**solo** en la cookie `sesion` (HttpOnly). Errores: `{"error": "mensaje"}` con
400 (datos no válidos), 401 (sin sesión / credenciales), 403 (rol o email sin
verificar), 404, 409 (conflicto), 413 (JSON > 64 KB), 429 (demasiados intentos de
login/verificación), 502 (email), 503 (storage).

### Autenticación

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| POST | `/auth/login` | público | `{email, password}` → cookie + `{user}` |
| POST | `/auth/logout` | cualquiera | Borra la sesión, limpia la cookie (204) |
| GET | `/me` | con sesión | Usuario actual |
| POST | `/auth/register` | ADMIN | SOCIO: `{email, rol, company_id}` · ALUMNO: `{email, rol, edition_id, nombre}` + invitación |
| POST | `/auth/verify` | público | `{token, password}` |

### Administración (solo ADMIN)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/admin/users/:id/invitation` | Reenvía la invitación (invalida la anterior) |
| GET / POST | `/admin/editions` | Lista / crea `{nombre, anio, fecha_inicio?, fecha_fin?}` |
| POST | `/admin/editions/:id/close` | Cierra la edición |
| GET | `/admin/students?edition_id=` | Lista alumnos (incluye inactivos) |
| POST | `/admin/students` | `{email, nombre, edition_id}` → alumno + invitación |
| PATCH | `/admin/students/:id/estado` | `{estado: activo\|inactivo}` |
| DELETE | `/admin/students/:id` | Derecho al olvido |
| GET / POST | `/admin/companies` | Lista / crea `{nombre, email, contacto?, es_socia?}` |
| PATCH | `/admin/companies/:id` | `{es_socia}` |
| POST | `/admin/companies/:id/users` | `{email}` → otro usuario SOCIO |
| POST | `/admin/skills`, `/admin/languages` | `{nombre}` → amplía el catálogo |

### Alumno (ALUMNO con ficha)

| Método | Ruta | Descripción |
|---|---|---|
| GET / PATCH | `/students/me` | Ficha propia; PATCH parcial (campos, `privacy`, `consent`) |
| PATCH | `/students/me/estado` | `{estado}` (activar exige consentimiento) |
| DELETE | `/students/me` | Derecho al olvido |
| GET / POST | `/students/me/projects` | Lista / crea `{titulo, url, descripcion?}` |
| PATCH / DELETE | `/students/me/projects/:id` | Edita / borra |
| PUT | `/students/me/projects/:id/thumbnail` | Imagen PNG/JPEG/WebP ≤ 2 MB en el cuerpo |
| PUT | `/students/me/skills` | `{skills: [{skill_id, nivel}]}` |
| PUT | `/students/me/languages` | `{languages: [{language_id, nivel}]}` |

### Consulta

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| GET | `/students/:id` | con sesión | ADMIN: completa · ALUMNO: solo la suya · SOCIO: solo activos con consentimiento y solo campos visibles |
| GET | `/skills`, `/languages` | con sesión | Catálogos |

**Privacidad:** por defecto (opt-in), una empresa solo ve nombre, edición,
skills, idiomas y proyectos; el resto de campos (`email`, `bio`, `ubicacion`,
`cv_url`, `linkedin`, `github`, …) solo si el alumno marca
`privacy.<campo> = true`.

## Desarrollo

- **TDD estricto y tests bloqueados:** ver `CLAUDE.md`.
  `node scripts/check-locked-tests.mjs status` lista los bloqueados.
- Estructura MVC: `src/model` (dominio, BD, auditoría, privacidad),
  `src/controller` (rutas Hono, middleware), `src/view` (frontend, pendiente).
- Los tests de integración usan tu BD real dentro de una transacción que se
  deshace siempre; los ficheros corren en serie (ver `vitest.config.ts`).

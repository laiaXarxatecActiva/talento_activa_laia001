# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

App web para que las empresas consulten los perfiles de alumnos que **terminaron
con éxito** la formación Xarxatec Activa (reconversión de perfiles a IT), vean sus
proyectos y los contacten. La plataforma **solo almacena alumnos que finalizaron
con éxito**; nunca datos de quienes no completaron la formación.

## Estado del repo

En **fase de diseño**: todavía no hay código de aplicación ni tooling de build.
La fuente de verdad vive en `docs/` y `seed.sql`. Lee esos documentos antes de
implementar — definen decisiones ya cerradas con el cliente, no suposiciones.

- `docs/casos-de-uso.md` — casos de uso originales (actor / objetivo / excepciones).
- `docs/especificacion.md` — especificación funcional, roles, seguridad, fases y modelo.
- `docs/modelo-entidad-relacion.md` — diagrama ER (Mermaid) y convenciones de BD.
- `seed.sql` — DDL completo + seed de referencia para Postgres/Supabase.

## Stack previsto

- **Frontend:** VanillaJS + TypeScript.
- **Backend:** Node.js + Hono (TypeScript), API bajo `/api/*`.
- **BD:** Supabase (Postgres). **Supabase Auth NO se usa** — la autenticación es propia.
- **Storage:** Supabase Storage (fotos, CVs, miniaturas).
- **Email:** proveedor transaccional (p. ej. Resend) para verificación y recordatorios.

## Metodología: TDD + tests bloqueados (regla estricta)

- **Se programa con TDD:** primero el test (rojo), luego el código mínimo para
  pasarlo (verde), luego refactor. No escribas producción sin un test que la pida.
- **Un test de una funcionalidad ya acabada NO se modifica ni se borra** en tareas
  posteriores. Si crees que es imprescindible cambiarlo, **pídele el OK explícito
  al responsable antes de tocarlo**; sin ese OK, adapta el código, no el test.
- Al dar una funcionalidad por **acabada**, **bloquea** sus tests:
  `node scripts/check-locked-tests.mjs lock <rutas...>` (congela su SHA-256 en
  `tests.lock.json`).
- `scripts/check-locked-tests.mjs check` falla si un test bloqueado cambió o
  desapareció. Está cableado como **hook de Claude Code** (`PostToolUse` sobre
  `Edit|Write|MultiEdit` en `.claude/settings.json`): si modificas un test
  bloqueado, el hook falla con exit 2 y te devuelve el error para que lo
  **reviertas** en el acto. También puedes ejecutar `check` a mano.
- Modificar un test bloqueado (solo con OK): `unlock <ruta>` → editar →
  `lock <ruta>` (o `lock --force <ruta>` para re-congelar uno ya modificado).
- Comandos: `check` (por defecto) · `lock [rutas]` · `unlock <rutas>` · `status`.

## Arquitectura (MVC)

- **Modelo:** dominio + acceso a datos (Supabase/Postgres). Aquí se aplican las
  reglas de negocio, el **enforcement de privacidad** y la escritura en `Audit_log`.
- **Vista:** UI en VanillaJS + TS. Solo presentación.
- **Controlador:** handlers de Hono en `/api/*`. Reciben la petición, **autorizan
  con el `Actor {id, rol}`** de la sesión, orquestan el modelo y responden.

**La frontera de seguridad es el backend, no la BD.** Como la auth es propia (no
Supabase Auth), las RLS de Supabase no se activan por JWT. En `seed.sql` las
tablas tienen RLS habilitado **sin políticas** (bloquea el API anon/authenticated
de Supabase); el acceso real va por el backend con `service_role`/conexión
directa, que omite RLS. Toda regla de visibilidad se comprueba en la capa de
aplicación.

## Invariantes de seguridad (no negociables)

Estas reglas vienen del cliente. Respétalas al pie de la letra:

- **Contraseñas:** hash **Argon2id** con `m=19456, t=2, p=1`. Longitud 12–256; fuera
  de rango → error de datos no válidos.
- **Sesiones (servidor, NO JWT):** token opaco = 32 bytes de `randomBytes` en
  base64url (prohibido uuid/relojes/PRNG no seguros como secreto). En la tabla
  `Session` se guarda **solo el SHA-256 (hex)** del token, nunca en claro. Duración
  30 días con **renovación deslizante**: si quedan <15 días al resolver, se extiende
  a 30 y se repone la cookie. Resolver devuelve `null` (y borra la fila) si no
  existe, caducó o el usuario ya no existe; además devuelve `Actor {id, rol}`.
- **Cookie:** nombre `sesion`; flags `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure`
  solo en producción. Usar `Expires` (fecha absoluta), **no** `Max-Age`. El token
  viaja **solo en la cookie** — nunca en body, URL ni almacenamiento del navegador.
- **Anti-enumeración:** email ya registrado → `409` genérico "No se ha podido
  completar el registro". En login, mismo error (mensaje + estado) y **mismo coste
  temporal** exista o no el email (verificar contra un `HASH_SEÑUELO` cuando el
  email no existe, para igualar tiempos).
- **Auditoría:** cada mutación escribe en `Audit_log` desde la capa de aplicación
  (`id_usuario, tabla, id_registro, operacion, datos_anteriores, datos_nuevos,
  timestamp`). **Nunca** auditar el hash de la contraseña ni el token en claro.

## Acceso y roles

- Roles: `ADMIN`, `SOCIO` (empresa), `ALUMNO`.
- **No hay registro público.** Todas las cuentas se crean **por invitación del
  admin**; `POST /api/auth/register` queda restringido a ADMIN. El staff se da de
  alta aparte.
- Cuentas nacen con `email_verified=false`; verificación por email (token de un
  solo uso) antes de dar acceso real.
- Endpoints base: `POST /api/auth/login` (crea sesión nueva siempre e invalida la
  previa de la cookie), `POST /api/auth/logout` (borra sesión, idempotente, limpia
  cookie), `GET /api/me` (usuario actual, proyección pública sin hash).

## Estados del alumno y privacidad

- `Student.estado`: **activo** (consultable por empresas) / **inactivo** (datos en
  el sistema pero ocultos a empresas). Lo cambia el propio alumno o un admin.
- **Derecho al olvido:** no es un estado, es un **borrado** en cascada de los datos
  del alumno (proyectos, skills, idiomas, bookmarks, `Reminder_state`).
- `Student.privacy` (jsonb) controla la visibilidad **por campo**.
- Un alumno **inactivo** nunca aparece en escaparate, ediciones, búsqueda ni
  respuestas del futuro chatbot. Solo los **activos** son consultables.

## Convenciones de base de datos

- **Tablas:** singular, primera letra en mayúscula, `snake_case`. Esto obliga a
  **entrecomillar identificadores** en SQL (`"User"`, `"Skill_student_rel"`): sin
  comillas Postgres los pasa a minúscula y, además, `User`/`Language` son
  reservadas.
- **Columnas:** minúscula `snake_case` (sin comillas).
- **Tablas puente N:M:** las dos tablas ordenadas **alfabéticamente** + sufijo
  `_rel` (ej. `Skill` + `Student` → `Skill_student_rel`).
- PKs `uuid` con `gen_random_uuid()`; email único sobre `lower(email)`.

## Fases del producto

1. **Núcleo:** auth, admin (ediciones/alumnos/empresas), ficha de alumno, proyectos.
2. **Escaparate y empresas:** catálogo público, cards por edición, búsqueda/filtro
   estructurado, bookmarks, contacto por email, alumnos en empresas socias.
3. **Automatizaciones:** email de invitación al finalizar; recordatorios a los
   14/21/25 días y marcado **inactivo** a los 30 si no rellena; recordatorio anual.
4. **Futuro:** chatbot (modelo local) que recibe una oferta y devuelve perfiles
   reales que encajan, con guardarraíles; auto-generación de miniaturas.

## Notas de implementación pendientes

- Miniaturas de proyecto: **subida manual** en la 1ª iteración (auto-generación
  diferida a futuro).
- `seed.sql` es idempotente (`create ... if not exists`, `on conflict do nothing`)
  y se ejecuta en el SQL Editor de Supabase. El usuario ADMIN inicial y su hash
  Argon2id están comentados: generar el hash desde el backend, no incrustar hashes
  de ejemplo.

# Plan de desarrollo — App Alumnos Xarxatec Activa

Documento que gobierna el trabajo **autónomo** del agente Desarrollador y del
agente Revisor. El Desarrollador trabaja sobre la rama `develop`.

## Protocolo del Desarrollador (cada ejecución, 06:00–22:00 cada hora)

En cada conexión, de forma autónoma:

1. **Sincroniza:** sitúate en `develop` y haz `git pull` (si no existe en remoto,
   créala desde `master`).
2. **Prioriza el trabajo de esta ejecución, en este orden:**
   1. **Cambios propuestos por el Revisor** aún abiertos: lee el informe abierto
      más reciente en `docs/revisiones/` (los marcados `ESTADO: ABIERTO`) y
      resuelve sus hallazgos **bloqueantes** primero.
   2. Si no hay hallazgos abiertos, coge la **siguiente tarea pendiente** (primera
      `[ ]` sin terminar) del Backlog de abajo, respetando el orden.
3. **Desarrolla con TDD:** rojo → verde → refactor. Nada de código de producción
   sin un test que lo pida (ver `CLAUDE.md`).
4. **Alcance por ejecución:** avanza en incrementos pequeños y dejables. Si una
   tarea no cabe en una hora, haz un commit con progreso coherente y tests en
   verde; continúa en la siguiente conexión.
5. **Al terminar una tarea o sub-tarea:**
   - Ejecuta toda la suite de tests y `node scripts/check-locked-tests.mjs check`.
   - **Bloquea** los tests de lo acabado:
     `node scripts/check-locked-tests.mjs lock <rutas...>`.
   - Marca la tarea como `[x]` en este documento.
   - Si resolviste hallazgos de un informe de revisión y no quedan abiertos en él,
     cambia su cabecera a `ESTADO: RESUELTO`.
6. **Commit y push a `develop`** (ver convención). No hagas merge a `master`.
7. **Nunca** modifiques un test bloqueado. Si crees que es imprescindible, **no lo
   toques**: déjalo anotado en el commit/resumen y en el informe de revisión para
   que un humano dé el OK.

### Definición de "hecho" (Definition of Done)

- Tests que cubren el comportamiento, escritos antes del código, en verde.
- `check-locked-tests` en verde y tests de la tarea **bloqueados**.
- Cumple los invariantes de seguridad y la arquitectura MVC de `CLAUDE.md`.
- Commit(s) en `develop` con mensaje según convención.

### Convención de commits

`tipo(ámbito): descripción` — tipos: `feat`, `fix`, `test`, `refactor`, `chore`,
`docs`. Ejemplos: `feat(auth): login con anti-enumeración`,
`test(session): expiración y renovación deslizante`.

## Protocolo del Revisor (una vez al día, 00:00)

1. Sitúate en `develop` y haz `git pull`.
2. Revisa **todo el código generado ese día** (commits de `develop` con fecha de
   hoy: `git log --since=midnight`).
3. Audita según `revisor.md` (seguridad, TDD y tests bloqueados, corrección, MVC,
   convenciones, simplicidad). Ejecuta tests y `check-locked-tests`.
4. **Escribe el informe** en `docs/revisiones/AAAA-MM-DD.md` con esta cabecera:

   ```
   # Revisión AAAA-MM-DD
   ESTADO: ABIERTO            # ABIERTO mientras haya hallazgos sin resolver
   VEREDICTO: CAMBIOS NECESARIOS | APROBADO
   ```

   Debajo, los hallazgos ordenados por severidad, cada uno con: fichero:línea,
   qué está mal, por qué, y la corrección sugerida (describir, no aplicar).
5. El Revisor **no modifica código**; solo deja el informe para el Desarrollador.

---

## Backlog de tareas (Fase 1 — Núcleo)

> Orden por dependencias. El Desarrollador coge la primera `[ ]` no terminada.

### Bootstrap
- [x] **T00 · Andamiaje del proyecto:** `package.json` (TS), runner de tests
  (vitest), `tsconfig`, estructura de carpetas MVC (`src/model`, `src/controller`,
  `src/view`, `tests/`), scripts `test`/`build`. Primer test trivial en verde.
- [x] **T01 · Cliente de datos:** conexión a Supabase/Postgres desde el backend
  (service role / conexión directa). Test de conectividad/consulta básica.
- [x] **T02 · Capa de auditoría:** helper que escribe en `Audit_log` desde la capa
  de aplicación (nunca hash ni token). Test de inserción y de exclusiones.

### Autenticación
- [x] **T03 · Hashing de contraseñas:** Argon2id `m=19456,t=2,p=1`; validación de
  longitud 12–256 → error de datos no válidos. Tests de hash/verify y límites.
- [x] **T04 · Modelo User:** alta por invitación (rol, `email_verified=false`),
  email único sobre `lower(email)`. Tests.
- [x] **T05 · Sesiones:** token opaco 32 bytes base64url; guardar solo SHA-256;
  resolver sesión (null + borrado si no existe/caduca/usuario inexistente) y
  devolver `Actor {id, rol}`; renovación deslizante (<15 días → 30). Tests.
- [x] **T06 · Cookie de sesión:** helpers para `sesion` (`HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure` en prod, `Expires` absoluto). Tests.
- [x] **T07 · Login:** `POST /api/auth/login` crea sesión nueva e invalida la
  previa de la cookie; anti-enumeración con `HASH_SEÑUELO` (mismo error y mismo
  coste temporal). Tests incl. tiempos.
- [x] **T08 · Logout y /me:** `POST /api/auth/logout` (idempotente, limpia cookie)
  y `GET /api/me` (proyección pública sin hash). Tests.
- [x] **T09 · Middleware de autorización:** resuelve sesión y exige rol por ruta.
  Tests de acceso por rol.
- [ ] **T10 · Registro restringido:** `POST /api/auth/register` solo ADMIN (alta por
  invitación). Tests.
- [ ] **T11 · Verificación de email:** token de un solo uso con caducidad + envío;
  bloquear acceso hasta verificar. Tests.

### Administración
- [ ] **T12 · Ediciones:** CRUD de `Edition` (crear, cerrar). Tests.
- [ ] **T13 · Alta de alumnos finalizados:** crear `Student` (usuario ALUMNO) y
  asociar a una edición. Tests.
- [ ] **T14 · Alta de empresas:** crear `Company` por invitación y marcar `es_socia`.
  Tests.

### Alumno
- [ ] **T15 · Ficha de alumno:** modelo `Student` + endpoints de lectura/edición de
  su ficha; `privacy` por campo. Tests.
- [ ] **T16 · Estado activo/inactivo:** el alumno (y el admin) cambian `estado`;
  un `inactivo` no es consultable por empresas. Tests de enforcement.
- [ ] **T17 · Derecho al olvido:** borrado en cascada de datos del alumno. Tests.
- [ ] **T18 · Proyectos:** CRUD de `Project` vinculado al alumno; validar URL;
  miniatura por subida manual. Tests.
- [ ] **T19 · Skills e idiomas:** catálogo + asociación N:M con nivel
  (`Skill_student_rel`, `Language_student_rel`). Tests.

> Fases 2 (escaparate/empresas), 3 (automatizaciones/emails) y 4 (chatbot) se
> detallarán cuando la Fase 1 esté cerrada y revisada.

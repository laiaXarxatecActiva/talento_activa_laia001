import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LANGUAGES, replaceStudentItems, SKILLS } from '../model/catalog.js';
import { NotFoundError, InvalidDataError, StorageUnavailableError } from '../model/errors.js';
import {
  assertOwnProject,
  createOwnProject,
  deleteOwnProject,
  listOwnProjects,
  setProjectThumbnail,
  updateOwnProject,
} from '../model/project.js';
import { detectImageType, IMAGE_EXTENSIONS } from '../model/storage.js';
import {
  forgetStudent,
  getStudentFichaByUser,
  getStudentForViewer,
  setStudentEstado,
  updateOwnStudent,
} from '../model/student.js';
import { buildClearSessionCookie } from './cookie.js';
import { isUuid, readJson, removeFiles, type AppEnv, type Deps } from './http.js';
import { requireAuth } from './middleware.js';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** Rutas de alumnos: /api/students/*. */
export function studentRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  // --- Ficha propia (ALUMNO) -------------------------------------------------
  r.get('/me', requireAuth(deps, 'ALUMNO'), async (c) => {
    const userId = c.var.actor.id;
    const student = await deps.transaction((tx) => getStudentFichaByUser(tx, userId));
    if (!student) throw new NotFoundError();
    return c.json({ student }, 200);
  });

  r.patch('/me', requireAuth(deps, 'ALUMNO'), async (c) => {
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const userId = c.var.actor.id;
    const student = await deps.transaction((tx) => updateOwnStudent(tx, userId, body));
    return c.json({ student }, 200);
  });

  r.patch('/me/estado', requireAuth(deps, 'ALUMNO'), async (c) => {
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const userId = c.var.actor.id;
    const student = await deps.transaction(async (tx) => {
      const own = await getStudentFichaByUser(tx, userId);
      if (!own) throw new NotFoundError();
      return setStudentEstado(tx, userId, own.id, body.estado);
    });
    return c.json({ student }, 200);
  });

  // Derecho al olvido ejercido por el propio alumno.
  r.delete('/me', requireAuth(deps, 'ALUMNO'), async (c) => {
    const userId = c.var.actor.id;
    const thumbnails = await deps.transaction(async (tx) => {
      const own = await getStudentFichaByUser(tx, userId);
      if (!own) throw new NotFoundError();
      return forgetStudent(tx, null, own.id);
    });
    await removeFiles(deps.storage, thumbnails);
    c.header('Set-Cookie', buildClearSessionCookie());
    return c.body(null, 204);
  });

  // --- Proyectos propios (ALUMNO) ---------------------------------------------
  r.get('/me/projects', requireAuth(deps, 'ALUMNO'), async (c) => {
    const userId = c.var.actor.id;
    const projects = await deps.transaction((tx) => listOwnProjects(tx, userId));
    return c.json({ projects }, 200);
  });

  r.post('/me/projects', requireAuth(deps, 'ALUMNO'), async (c) => {
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const userId = c.var.actor.id;
    const project = await deps.transaction((tx) => createOwnProject(tx, userId, body));
    return c.json({ project }, 201);
  });

  r.patch('/me/projects/:pid', requireAuth(deps, 'ALUMNO'), async (c) => {
    const pid = c.req.param('pid');
    if (!isUuid(pid)) throw new NotFoundError();
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const userId = c.var.actor.id;
    const project = await deps.transaction((tx) => updateOwnProject(tx, userId, pid, body));
    return c.json({ project }, 200);
  });

  r.delete('/me/projects/:pid', requireAuth(deps, 'ALUMNO'), async (c) => {
    const pid = c.req.param('pid');
    if (!isUuid(pid)) throw new NotFoundError();
    const userId = c.var.actor.id;
    const thumbnail = await deps.transaction((tx) => deleteOwnProject(tx, userId, pid));
    await removeFiles(deps.storage, [thumbnail]);
    return c.body(null, 204);
  });

  // Miniatura: subida manual (PNG/JPEG/WebP, máx. 2 MB) a Storage.
  r.put(
    '/me/projects/:pid/thumbnail',
    requireAuth(deps, 'ALUMNO'),
    bodyLimit({ maxSize: MAX_THUMBNAIL_BYTES, onError: (c) => c.json({ error: 'Datos no válidos' }, 400) }),
    async (c) => {
      const pid = c.req.param('pid');
      if (!isUuid(pid)) throw new NotFoundError();
      const userId = c.var.actor.id;
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const type = detectImageType(bytes);
      if (!type || bytes.byteLength > MAX_THUMBNAIL_BYTES) throw new InvalidDataError();

      await deps.transaction((tx) => assertOwnProject(tx, userId, pid));
      if (!deps.storage) throw new StorageUnavailableError();
      const path = `thumbnails/${pid}-${randomBytes(8).toString('base64url')}.${IMAGE_EXTENSIONS[type]}`;
      const url = await deps.storage.upload(path, bytes, type);

      const { project, previous } = await deps.transaction((tx) => setProjectThumbnail(tx, userId, pid, url));
      await removeFiles(deps.storage, [previous]);
      return c.json({ project }, 200);
    },
  );

  // --- Skills e idiomas propios (sustituye el conjunto) -----------------------
  for (const cfg of [SKILLS, LANGUAGES]) {
    r.put(`/me/${cfg.listKey}`, requireAuth(deps, 'ALUMNO'), async (c) => {
      const body = await readJson(c);
      if (!body) throw new InvalidDataError();
      const userId = c.var.actor.id;
      const items = await deps.transaction((tx) => replaceStudentItems(tx, cfg, userId, body));
      return c.json({ [cfg.listKey]: items }, 200);
    });
  }

  // --- Ficha por id (según quién mira) ---------------------------------------
  r.get('/:id', requireAuth(deps), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const actor = c.var.actor;
    const student = await deps.transaction((tx) => getStudentForViewer(tx, actor, id));
    return c.json({ student }, 200);
  });

  return r;
}

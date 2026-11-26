import { Hono } from 'hono';
import { NotFoundError, InvalidDataError } from '../model/errors.js';
import { getStudentFichaByUser, getStudentForViewer, setStudentEstado, updateOwnStudent } from '../model/student.js';
import { isUuid, readJson, type AppEnv, type Deps } from './http.js';
import { requireAuth } from './middleware.js';

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

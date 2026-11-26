import { Hono } from 'hono';
import { addCatalogEntry, LANGUAGES, SKILLS } from '../model/catalog.js';
import { createCompany, inviteCompanyUser, listCompanies, setCompanySocia } from '../model/company.js';
import { closeEdition, createEdition, listEditions } from '../model/edition.js';
import { ConflictError, InvalidDataError, NotFoundError } from '../model/errors.js';
import { createStudentAccount, forgetStudent, listStudentsForAdmin, setStudentEstado } from '../model/student.js';
import { getPublicUser } from '../model/user.js';
import { isUuid, readJson, removeFiles, type AppEnv, type Deps } from './http.js';
import { sendInvitation } from './invitation.js';
import { requireAuth } from './middleware.js';

/** Rutas de administración: /api/admin/* (solo ADMIN). */
export function adminRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth(deps, 'ADMIN'));

  // Reenvía la invitación (enlace nuevo; el anterior deja de valer).
  r.post('/users/:id/invitation', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const actorId = c.var.actor.id;
    await deps.transaction(async (tx) => {
      const user = await getPublicUser(tx, id);
      if (!user) throw new NotFoundError();
      if (user.email_verified) throw new ConflictError('El usuario ya ha verificado su email');
      await sendInvitation(tx, deps, user, actorId);
    });
    return c.body(null, 204);
  });

  // --- Ediciones -----------------------------------------------------------
  r.get('/editions', async (c) => {
    const editions = await deps.transaction((tx) => listEditions(tx));
    return c.json({ editions }, 200);
  });

  r.post('/editions', async (c) => {
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const actorId = c.var.actor.id;
    const edition = await deps.transaction((tx) => createEdition(tx, actorId, body));
    return c.json({ edition }, 201);
  });

  r.post('/editions/:id/close', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const actorId = c.var.actor.id;
    const edition = await deps.transaction((tx) => closeEdition(tx, actorId, id));
    return c.json({ edition }, 200);
  });

  // --- Alumnos -------------------------------------------------------------
  r.get('/students', async (c) => {
    const editionId = c.req.query('edition_id');
    if (editionId !== undefined && !isUuid(editionId)) throw new InvalidDataError();
    const students = await deps.transaction((tx) => listStudentsForAdmin(tx, { editionId }));
    return c.json({ students }, 200);
  });

  // Alta de alumno finalizado + invitación (todo o nada).
  r.post('/students', async (c) => {
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const actorId = c.var.actor.id;
    const student = await deps.transaction(async (tx) => {
      const created = await createStudentAccount(tx, actorId, body);
      await sendInvitation(tx, deps, { id: created.user_id, email: created.email }, actorId);
      return created;
    });
    return c.json({ student }, 201);
  });

  r.patch('/students/:id/estado', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const actorId = c.var.actor.id;
    const student = await deps.transaction((tx) => setStudentEstado(tx, actorId, id, body.estado));
    return c.json({ student }, 200);
  });

  // Derecho al olvido ejecutado por un admin.
  r.delete('/students/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const actorId = c.var.actor.id;
    const thumbnails = await deps.transaction((tx) => forgetStudent(tx, actorId, id));
    await removeFiles(deps, thumbnails);
    return c.body(null, 204);
  });

  // --- Empresas ------------------------------------------------------------
  r.get('/companies', async (c) => {
    const companies = await deps.transaction((tx) => listCompanies(tx));
    return c.json({ companies }, 200);
  });

  // Alta de empresa + primer usuario SOCIO + invitación (todo o nada).
  r.post('/companies', async (c) => {
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const actorId = c.var.actor.id;
    const company = await deps.transaction(async (tx) => {
      const created = await createCompany(tx, actorId, body);
      await sendInvitation(tx, deps, created.user, actorId);
      return created.company;
    });
    return c.json({ company }, 201);
  });

  r.patch('/companies/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const actorId = c.var.actor.id;
    const company = await deps.transaction((tx) => setCompanySocia(tx, actorId, id, body.es_socia));
    return c.json({ company }, 200);
  });

  r.post('/companies/:id/users', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw new NotFoundError();
    const body = await readJson(c);
    if (!body) throw new InvalidDataError();
    const actorId = c.var.actor.id;
    const company = await deps.transaction(async (tx) => {
      const added = await inviteCompanyUser(tx, actorId, id, body.email);
      await sendInvitation(tx, deps, added.user, actorId);
      return added.company;
    });
    return c.json({ company }, 201);
  });

  // --- Catálogos -----------------------------------------------------------
  for (const [path, cfg, key] of [
    ['/skills', SKILLS, 'skill'],
    ['/languages', LANGUAGES, 'language'],
  ] as const) {
    r.post(path, async (c) => {
      const body = await readJson(c);
      if (!body) throw new InvalidDataError();
      const actorId = c.var.actor.id;
      const entry = await deps.transaction((tx) => addCatalogEntry(tx, cfg, actorId, body.nombre));
      return c.json({ [key]: entry }, 201);
    });
  }

  return r;
}

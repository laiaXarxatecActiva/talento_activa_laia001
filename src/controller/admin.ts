import { Hono } from 'hono';
import { ConflictError, NotFoundError } from '../model/errors.js';
import { getPublicUser } from '../model/user.js';
import { isUuid, type AppEnv, type Deps } from './http.js';
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

  return r;
}

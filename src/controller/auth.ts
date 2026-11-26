import { Hono } from 'hono';
import { login } from '../model/auth.js';
import { isValidPasswordLength } from '../model/password.js';
import { deleteSession } from '../model/session.js';
import { getPublicUser, inviteUser, type InvitableRol } from '../model/user.js';
import { consumeVerificationToken } from '../model/verification.js';
import { buildClearSessionCookie, buildSessionCookie, readSessionToken } from './cookie.js';
import { readJson, type AppEnv, type Deps } from './http.js';
import { sendInvitation } from './invitation.js';
import { requireAuth } from './middleware.js';

/** Rutas de autenticación: /api/auth/* y /api/me. */
export function authRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/auth/login', async (c) => {
    const body = await readJson(c);
    const email = body?.email;
    const password = body?.password;
    if (typeof email !== 'string' || typeof password !== 'string') return c.json({ error: 'Datos no válidos' }, 400);
    // Rechazo temprano: no abre transacción ni toca la BD (y no depende del email).
    if (!isValidPasswordLength(password)) return c.json({ error: 'Datos no válidos' }, 400);

    const previousToken = readSessionToken(c.req.header('Cookie'));
    const { user, token, expiresAt } = await deps.transaction((tx) => login(tx, email, password, previousToken));
    c.header('Set-Cookie', buildSessionCookie(token, expiresAt));
    return c.json({ user }, 200);
  });

  // Idempotente: con o sin sesión, responde 204 y limpia la cookie.
  r.post('/auth/logout', async (c) => {
    const token = readSessionToken(c.req.header('Cookie'));
    if (token) await deps.transaction((tx) => deleteSession(tx, token));
    c.header('Set-Cookie', buildClearSessionCookie());
    return c.body(null, 204);
  });

  // Alta por invitación: solo ADMIN. No crea ADMIN (el staff va aparte).
  r.post('/auth/register', requireAuth(deps, 'ADMIN'), async (c) => {
    const body = await readJson(c);
    const email = body?.email;
    const rol = body?.rol;
    if (typeof email !== 'string' || typeof rol !== 'string') return c.json({ error: 'Datos no válidos' }, 400);

    const actorId = c.var.actor.id;
    const user = await deps.transaction(async (tx) => {
      const created = await inviteUser(tx, actorId, { email, rol: rol as InvitableRol });
      await sendInvitation(tx, deps, created, actorId);
      return created;
    });
    return c.json({ user }, 201);
  });

  // Público: el invitado fija su contraseña con el token del email.
  r.post('/auth/verify', async (c) => {
    const body = await readJson(c);
    const token = body?.token;
    const password = body?.password;
    if (typeof token !== 'string' || typeof password !== 'string') return c.json({ error: 'Datos no válidos' }, 400);
    const user = await deps.transaction((tx) => consumeVerificationToken(tx, token, password));
    return c.json({ user }, 200);
  });

  r.get('/me', requireAuth(deps), async (c) => {
    const { id } = c.var.actor;
    const user = await deps.transaction((tx) => getPublicUser(tx, id));
    if (!user) return c.json({ error: 'No autenticado' }, 401);
    return c.json({ user }, 200);
  });

  return r;
}

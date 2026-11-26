import { createMiddleware } from 'hono/factory';
import { resolveSession } from '../model/session.js';
import type { Rol } from '../model/user.js';
import { buildClearSessionCookie, buildSessionCookie, readSessionToken } from './cookie.js';
import type { AppEnv, Deps } from './http.js';

/**
 * Exige sesión válida (y, si se indican, uno de los roles). Deja el
 * `Actor {id, rol}` en `c.var.actor` y repone la cookie si se renovó.
 *
 * - Sin sesión válida → 401 (y limpia la cookie si traía una).
 * - Email sin verificar → 403 (hasta verificar no hay acceso real).
 * - Rol no permitido → 403.
 */
export function requireAuth(deps: Pick<Deps, 'transaction'>, ...roles: Rol[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = readSessionToken(c.req.header('Cookie'));
    const resolved = token ? await deps.transaction((tx) => resolveSession(tx, token)) : null;

    if (!resolved) {
      if (token) c.header('Set-Cookie', buildClearSessionCookie());
      return c.json({ error: 'No autenticado' }, 401);
    }
    if (resolved.renewed && token) {
      c.header('Set-Cookie', buildSessionCookie(token, resolved.expiresAt));
    }
    if (!resolved.emailVerified) {
      return c.json({ error: 'Email no verificado' }, 403);
    }
    if (roles.length > 0 && !roles.includes(resolved.actor.rol)) {
      return c.json({ error: 'No autorizado' }, 403);
    }

    c.set('actor', resolved.actor);
    await next();
  });
}

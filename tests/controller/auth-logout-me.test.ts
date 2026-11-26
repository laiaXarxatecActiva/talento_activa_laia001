import { describe, it, expect } from 'vitest';
import { hasDb, withApp, appSinBd, loginAs, call } from '../helpers/db.js';
import { createSession, resolveSession } from '../../src/model/session.js';

const DAY = 24 * 60 * 60 * 1000;

describe('POST /api/auth/logout', () => {
  it('sin cookie → 204 y limpia la cookie (idempotente, sin BD)', async () => {
    const res = await call(appSinBd(), 'POST', '/api/auth/logout');
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/^sesion=; /);
    expect(setCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(setCookie).toContain('HttpOnly');
  });

  it.runIf(hasDb)('borra la sesión en BD y limpia la cookie', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie, token } = await loginAs(tx, 'ALUMNO');
      const res = await call(app, 'POST', '/api/auth/logout', { cookie });
      expect(res.status).toBe(204);
      expect(res.headers.get('Set-Cookie')).toMatch(/^sesion=; /);
      await expect(resolveSession(tx, token)).resolves.toBeNull();
    });
  });

  it.runIf(hasDb)('repetir el logout con la misma cookie sigue dando 204', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ALUMNO');
      expect((await call(app, 'POST', '/api/auth/logout', { cookie })).status).toBe(204);
      expect((await call(app, 'POST', '/api/auth/logout', { cookie })).status).toBe(204);
    });
  });

  it.runIf(hasDb)('el borrado se audita a nombre del dueño de la sesión', async () => {
    await withApp(async ({ app, tx }) => {
      const { user, cookie } = await loginAs(tx, 'SOCIO');
      await call(app, 'POST', '/api/auth/logout', { cookie });
      const rows = await tx`
        select id_usuario from "Audit_log" where tabla = 'Session' and operacion = 'DELETE'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id_usuario).toBe(user.id);
    });
  });
});

describe('GET /api/me', () => {
  it('sin cookie → 401', async () => {
    const res = await call(appSinBd(), 'GET', '/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No autenticado' });
  });

  it.runIf(hasDb)('cookie con sesión inexistente → 401 y limpia la cookie', async () => {
    await withApp(async ({ app }) => {
      const res = await call(app, 'GET', '/api/me', { cookie: `sesion=${'A'.repeat(43)}` });
      expect(res.status).toBe(401);
      expect(res.headers.get('Set-Cookie')).toMatch(/^sesion=; /);
    });
  });

  it.runIf(hasDb)('con sesión válida → 200 y el usuario público (sin hash)', async () => {
    await withApp(async ({ app, tx }) => {
      const { user, cookie } = await loginAs(tx, 'SOCIO');
      const res = await call(app, 'GET', '/api/me', { cookie });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        user: {
          id: user.id,
          email: user.email,
          rol: 'SOCIO',
          email_verified: true,
          created_at: user.created_at.toISOString(),
        },
      });
      expect(JSON.stringify(body)).not.toContain('argon2');
      // Sin renovación no se repone la cookie.
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });
  });

  it.runIf(hasDb)('si la sesión se renueva, repone la cookie con la nueva caducidad', async () => {
    await withApp(async ({ app, tx }) => {
      const { user } = await loginAs(tx, 'ALUMNO');
      const vieja = await createSession(tx, user.id, new Date(Date.now() - 20 * DAY));
      const res = await call(app, 'GET', '/api/me', { cookie: `sesion=${vieja.token}` });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie.startsWith(`sesion=${vieja.token}; `)).toBe(true);
      const expires = new Date(/Expires=([^;]+)/.exec(setCookie)![1]!);
      expect(expires.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    });
  });
});

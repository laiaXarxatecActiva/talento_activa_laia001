import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { TransactionSql } from 'postgres';
import { hasDb, inRollback, loginAs } from '../helpers/db.js';
import { requireAuth } from '../../src/controller/middleware.js';
import type { AppEnv } from '../../src/controller/http.js';
import type { Rol } from '../../src/model/user.js';

// Mini-app con una ruta por combinación de roles.
function testApp(tx: TransactionSql | null) {
  const deps = {
    transaction: <T>(work: (t: TransactionSql) => T | Promise<T>) => {
      if (!tx) throw new Error('no debería llamarse a la BD');
      return tx.savepoint(work);
    },
  };
  const app = new Hono<AppEnv>();
  const ok = (c: { var: AppEnv['Variables']; json: (b: unknown) => Response }) => c.json({ actor: c.var.actor });
  app.get('/cualquiera', requireAuth(deps), (c) => ok(c));
  app.get('/admin', requireAuth(deps, 'ADMIN'), (c) => ok(c));
  app.get('/socio-o-admin', requireAuth(deps, 'SOCIO', 'ADMIN'), (c) => ok(c));
  app.get('/alumno', requireAuth(deps, 'ALUMNO'), (c) => ok(c));
  return app;
}

function get(app: Hono<AppEnv>, path: string, cookie?: string) {
  return app.request(path, { headers: cookie ? { Cookie: cookie } : {} });
}

describe('requireAuth — sin sesión', () => {
  it('sin cookie → 401 sin tocar la BD', async () => {
    const res = await get(testApp(null), '/admin');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No autenticado' });
  });

  it.runIf(hasDb)('cookie con token mal formado → 401 y limpia la cookie', async () => {
    await inRollback(async (tx) => {
      const res = await get(testApp(tx), '/cualquiera', 'sesion=basura');
      expect(res.status).toBe(401);
      expect(res.headers.get('Set-Cookie')).toMatch(/^sesion=; /);
    });
  });
});

describe('requireAuth — acceso por rol (integración Supabase)', () => {
  const matriz: Array<[string, Record<Rol, number>]> = [
    ['/cualquiera', { ADMIN: 200, SOCIO: 200, ALUMNO: 200 }],
    ['/admin', { ADMIN: 200, SOCIO: 403, ALUMNO: 403 }],
    ['/socio-o-admin', { ADMIN: 200, SOCIO: 200, ALUMNO: 403 }],
    ['/alumno', { ADMIN: 403, SOCIO: 403, ALUMNO: 200 }],
  ];

  it.runIf(hasDb)('cada rol solo entra donde se le permite', async () => {
    await inRollback(async (tx) => {
      const app = testApp(tx);
      for (const rol of ['ADMIN', 'SOCIO', 'ALUMNO'] as const) {
        const { cookie } = await loginAs(tx, rol);
        for (const [path, esperado] of matriz) {
          const res = await get(app, path, cookie);
          expect({ path, rol, status: res.status }).toEqual({ path, rol, status: esperado[rol] });
        }
      }
    });
  });

  it.runIf(hasDb)('deja el Actor {id, rol} en el contexto', async () => {
    await inRollback(async (tx) => {
      const { user, cookie } = await loginAs(tx, 'SOCIO');
      const res = await get(testApp(tx), '/socio-o-admin', cookie);
      expect(await res.json()).toEqual({ actor: { id: user.id, rol: 'SOCIO' } });
    });
  });

  it.runIf(hasDb)('403 con mensaje genérico', async () => {
    await inRollback(async (tx) => {
      const { cookie } = await loginAs(tx, 'ALUMNO');
      const res = await get(testApp(tx), '/admin', cookie);
      expect(await res.json()).toEqual({ error: 'No autorizado' });
    });
  });

  it.runIf(hasDb)('usuario sin email verificado → 403 aunque tenga sesión', async () => {
    await inRollback(async (tx) => {
      const { user, cookie } = await loginAs(tx, 'ADMIN');
      await tx`update "User" set email_verified = false where id = ${user.id}`;
      const res = await get(testApp(tx), '/cualquiera', cookie);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Email no verificado' });
    });
  });
});

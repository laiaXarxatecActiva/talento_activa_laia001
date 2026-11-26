import { describe, it, expect } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { createUser } from '../../src/model/user.js';
import { createSession, resolveSession } from '../../src/model/session.js';
import { createApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

const PASSWORD = 'contrasena-de-prueba-larga';

// Ejecuta el test dentro de una transacción que se deshace siempre. La app
// recibe una `transaction` que abre savepoints en esa transacción externa, así
// que todo lo que haga la petición también se deshace.
class Rollback extends Error {}
async function withApp(fn: (app: ReturnType<typeof createApp>, tx: TransactionSql) => Promise<void>): Promise<void> {
  const sql: Sql = createDb();
  try {
    await sql.begin(async (tx) => {
      const app = createApp({ transaction: (work) => tx.savepoint(work) });
      await fn(app, tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await sql.end();
  }
}

// App sin BD para los casos que se rechazan antes de llegar al modelo.
const appSinBd = createApp({
  transaction: () => {
    throw new Error('no debería llamarse a la BD');
  },
});

function postLogin(app: ReturnType<typeof createApp>, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return app.request('/api/auth/login', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function tokenDe(setCookie: string | null): string {
  const m = /^sesion=([^;]+)/.exec(setCookie ?? '');
  if (!m) throw new Error(`Set-Cookie sin sesion: ${setCookie}`);
  return m[1]!;
}

describe('POST /api/auth/login — validación de entrada', () => {
  it('cuerpo que no es JSON → 400', async () => {
    const res = await postLogin(appSinBd, 'esto no es json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Datos no válidos' });
  });

  it('faltan campos o no son texto → 400', async () => {
    for (const body of [{}, { email: 'a@b.com' }, { password: PASSWORD }, { email: 1, password: PASSWORD }]) {
      const res = await postLogin(appSinBd, body);
      expect(res.status).toBe(400);
    }
  });

  it('contraseña fuera de rango → 400 sin consultar la BD', async () => {
    const res = await postLogin(appSinBd, { email: 'a@b.com', password: 'corta' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Datos no válidos' });
  });
});

describe('POST /api/auth/login — integración Supabase', () => {
  it.runIf(hasDb)('credenciales correctas → 200, cookie de sesión y usuario sin hash ni token', async () => {
    await withApp(async (app, tx) => {
      const user = await createUser(tx, null, { email: 'http-1@example.com', password: PASSWORD, rol: 'SOCIO' });
      const res = await postLogin(app, { email: 'http-1@example.com', password: PASSWORD });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toMatch(/^sesion=[A-Za-z0-9_-]{43}; /);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('Expires=');
      expect(setCookie!.toLowerCase()).not.toContain('max-age');

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        user: {
          id: user.id,
          email: 'http-1@example.com',
          rol: 'SOCIO',
          email_verified: false,
          created_at: user.created_at.toISOString(),
        },
      });
      const token = tokenDe(setCookie);
      expect(JSON.stringify(body)).not.toContain(token);
      expect(JSON.stringify(body)).not.toContain('argon2');

      await expect(resolveSession(tx, token)).resolves.not.toBeNull();
    });
  });

  it.runIf(hasDb)('email inexistente y contraseña mala → mismo 401 y mismo cuerpo, sin cookie', async () => {
    await withApp(async (app, tx) => {
      await createUser(tx, null, { email: 'http-2@example.com', password: PASSWORD, rol: 'ALUMNO' });
      const mala = await postLogin(app, { email: 'http-2@example.com', password: 'contrasena-incorrecta' });
      const nadie = await postLogin(app, { email: 'nadie-http@example.com', password: PASSWORD });

      expect(mala.status).toBe(401);
      expect(nadie.status).toBe(401);
      const bMala = await mala.json();
      const bNadie = await nadie.json();
      expect(bMala).toEqual(bNadie);
      expect(bMala).toEqual({ error: 'Credenciales no válidas' });
      expect(mala.headers.get('Set-Cookie')).toBeNull();
      expect(nadie.headers.get('Set-Cookie')).toBeNull();
    });
  });

  it.runIf(hasDb)('invalida la sesión previa que trae la cookie', async () => {
    await withApp(async (app, tx) => {
      const user = await createUser(tx, null, { email: 'http-3@example.com', password: PASSWORD, rol: 'ALUMNO' });
      const previa = await createSession(tx, user.id);
      const res = await postLogin(app, { email: 'http-3@example.com', password: PASSWORD }, `sesion=${previa.token}`);

      expect(res.status).toBe(200);
      const nuevo = tokenDe(res.headers.get('Set-Cookie'));
      expect(nuevo).not.toBe(previa.token);
      await expect(resolveSession(tx, previa.token)).resolves.toBeNull();
    });
  });
});

import { describe, it, expect } from 'vitest';
import { hasDb, withApp, appSinBd, loginAs, call } from '../helpers/db.js';

describe('POST /api/auth/register — acceso', () => {
  it('sin sesión → 401', async () => {
    const res = await call(appSinBd(), 'POST', '/api/auth/register', { body: { email: 'a@b.com', rol: 'SOCIO' } });
    expect(res.status).toBe(401);
  });

  it.runIf(hasDb)('SOCIO y ALUMNO → 403 y no se crea nada', async () => {
    await withApp(async ({ app, tx }) => {
      for (const rol of ['SOCIO', 'ALUMNO'] as const) {
        const { cookie } = await loginAs(tx, rol);
        const res = await call(app, 'POST', '/api/auth/register', {
          cookie,
          body: { email: `nuevo-${rol}@example.com`, rol: 'SOCIO' },
        });
        expect(res.status).toBe(403);
      }
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from "User" where email like 'nuevo-%'`;
      expect(row!.n).toBe(0);
    });
  });
});

describe('POST /api/auth/register — como ADMIN (integración Supabase)', () => {
  it.runIf(hasDb)('crea la cuenta sin verificar y devuelve 201 con el usuario público', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: { email: 'Invitado@Example.com', rol: 'SOCIO' },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user: Record<string, unknown> };
      expect(body.user).toMatchObject({ email: 'invitado@example.com', rol: 'SOCIO', email_verified: false });
      expect(body.user).not.toHaveProperty('password_hash');
      expect(JSON.stringify(body)).not.toContain('argon2');
    });
  });

  it.runIf(hasDb)('audita el alta a nombre del ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: { email: 'auditado@example.com', rol: 'ALUMNO' },
      });
      const { user } = (await res.json()) as { user: { id: string } };
      const [row] = await tx`select id_usuario from "Audit_log" where tabla = 'User' and id_registro = ${user.id}`;
      expect(row!.id_usuario).toBe(admin.id);
    });
  });

  it.runIf(hasDb)('email ya registrado → 409 genérico', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const body = { email: 'repetido@example.com', rol: 'SOCIO' };
      expect((await call(app, 'POST', '/api/auth/register', { cookie, body })).status).toBe(201);
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: { email: 'REPETIDO@example.com', rol: 'ALUMNO' },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'No se ha podido completar el registro' });
    });
  });

  it.runIf(hasDb)('datos no válidos → 400 (email, rol, cuerpo)', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      for (const body of [
        { email: 'no-es-email', rol: 'SOCIO' },
        { email: 'x@example.com', rol: 'JEFE' },
        { email: 'x@example.com' },
        { rol: 'SOCIO' },
      ]) {
        const res = await call(app, 'POST', '/api/auth/register', { cookie, body });
        expect(res.status).toBe(400);
      }
    });
  });

  it.runIf(hasDb)('no permite crear ADMIN (el staff se da de alta aparte) → 400', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: { email: 'otro-admin@example.com', rol: 'ADMIN' },
      });
      expect(res.status).toBe(400);
    });
  });

  it.runIf(hasDb)('la cuenta invitada no puede entrar hasta fijar su contraseña', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      await call(app, 'POST', '/api/auth/register', { cookie, body: { email: 'sinpass@example.com', rol: 'SOCIO' } });
      const res = await call(app, 'POST', '/api/auth/login', {
        body: { email: 'sinpass@example.com', password: 'contrasena-adivinada' },
      });
      expect(res.status).toBe(401);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { hasDb, withApp, appSinBd, loginAs, call, registerBody, nuevaEmpresa, nuevaEdicion } from '../helpers/db.js';

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
        body: await registerBody(tx, 'SOCIO', 'Invitado@Example.com'),
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
        body: await registerBody(tx, 'ALUMNO', 'auditado@example.com'),
      });
      const { user } = (await res.json()) as { user: { id: string } };
      const [row] = await tx`select id_usuario from "Audit_log" where tabla = 'User' and id_registro = ${user.id}`;
      expect(row!.id_usuario).toBe(admin.id);
    });
  });

  it.runIf(hasDb)('email ya registrado → 409 genérico', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const body = await registerBody(tx, 'SOCIO', 'repetido@example.com');
      expect((await call(app, 'POST', '/api/auth/register', { cookie, body })).status).toBe(201);
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: await registerBody(tx, 'ALUMNO', 'REPETIDO@example.com'),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'No se ha podido completar el registro' });
    });
  });

  it.runIf(hasDb)('datos no válidos → 400 (email, rol, cuerpo)', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const companyId = await nuevaEmpresa(tx);
      const editionId = await nuevaEdicion(tx);
      const inexistente = '00000000-0000-4000-8000-000000000999';
      for (const body of [
        { email: 'no-es-email', rol: 'SOCIO', company_id: companyId },
        { email: 'x@example.com', rol: 'JEFE' },
        { email: 'x@example.com' },
        { rol: 'SOCIO', company_id: companyId },
        // SOCIO siempre vinculado a una empresa existente.
        { email: 'x@example.com', rol: 'SOCIO' },
        { email: 'x@example.com', rol: 'SOCIO', company_id: inexistente },
        { email: 'x@example.com', rol: 'SOCIO', company_id: 'no-uuid' },
        // ALUMNO siempre con ficha en una edición existente.
        { email: 'x@example.com', rol: 'ALUMNO' },
        { email: 'x@example.com', rol: 'ALUMNO', edition_id: editionId },
        { email: 'x@example.com', rol: 'ALUMNO', nombre: 'Sin edición' },
        { email: 'x@example.com', rol: 'ALUMNO', edition_id: inexistente, nombre: 'X' },
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
      await call(app, 'POST', '/api/auth/register', { cookie, body: await registerBody(tx, 'SOCIO', 'sinpass@example.com') });
      const res = await call(app, 'POST', '/api/auth/login', {
        body: { email: 'sinpass@example.com', password: 'contrasena-adivinada' },
      });
      expect(res.status).toBe(401);
    });
  });

  it.runIf(hasDb)('SOCIO queda vinculado a su empresa (no hay cuentas de empresa sueltas)', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const companyId = await nuevaEmpresa(tx, 'Vinculada SL');
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: { email: 'vinculado@example.com', rol: 'SOCIO', company_id: companyId },
      });
      expect(res.status).toBe(201);
      const { user } = (await res.json()) as { user: { id: string } };
      const rels = await tx`select company_id from "Company_user_rel" where user_id = ${user.id}`;
      expect(rels.map((r) => r.company_id)).toEqual([companyId]);
    });
  });

  it.runIf(hasDb)('ALUMNO nace con su ficha Student (inactiva) en la edición indicada', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const editionId = await nuevaEdicion(tx, 'Edición Register');
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: { email: 'con-ficha@example.com', rol: 'ALUMNO', edition_id: editionId, nombre: 'Carla' },
      });
      expect(res.status).toBe(201);
      const { user } = (await res.json()) as { user: { id: string; rol: string } };
      expect(user.rol).toBe('ALUMNO');
      const [s] = await tx`select edition_id, nombre, estado from "Student" where user_id = ${user.id}`;
      expect(s).toMatchObject({ edition_id: editionId, nombre: 'Carla', estado: 'inactivo' });
    });
  });
});

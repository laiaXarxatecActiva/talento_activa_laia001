import { describe, it, expect } from 'vitest';
import { hasDb, withApp, appSinBd, loginAs, call, registerBody, PASSWORD } from '../helpers/db.js';
import type { EmailMessage } from '../../src/model/email.js';

function tokenDelEmail(m: EmailMessage | undefined): string {
  const match = /\/verificar\?token=([A-Za-z0-9_-]{43})/.exec(m?.text ?? '');
  if (!match) throw new Error(`Email sin enlace de verificación: ${m?.text}`);
  return match[1]!;
}

describe('POST /api/auth/verify — validación', () => {
  it('cuerpo no válido → 400 sin BD', async () => {
    for (const body of [{}, { token: 'x' }, { password: PASSWORD }, { token: 1, password: PASSWORD }]) {
      const res = await call(appSinBd(), 'POST', '/api/auth/verify', { body });
      expect(res.status).toBe(400);
    }
  });
});

describe('Flujo de invitación (integración Supabase)', () => {
  it.runIf(hasDb)('register envía el email de invitación con enlace a APP_URL/verificar', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: await registerBody(tx, 'SOCIO', 'flujo-1@example.com'),
      });
      expect(res.status).toBe(201);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.to).toBe('flujo-1@example.com');
      expect(outbox[0]!.text).toContain('http://localhost:3000/verificar?token=');
      // El token de verificación nunca va en la respuesta de la API.
      expect(await res.text()).not.toContain(tokenDelEmail(outbox[0]));
    });
  });

  it.runIf(hasDb)('invitar → verificar con contraseña → login → /api/me', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      await call(app, 'POST', '/api/auth/register', { cookie, body: await registerBody(tx, 'ALUMNO', 'flujo-2@example.com') });
      const token = tokenDelEmail(outbox[0]);

      const ver = await call(app, 'POST', '/api/auth/verify', { body: { token, password: PASSWORD } });
      expect(ver.status).toBe(200);
      expect(await ver.json()).toMatchObject({ user: { email: 'flujo-2@example.com', email_verified: true } });

      const log = await call(app, 'POST', '/api/auth/login', { body: { email: 'flujo-2@example.com', password: PASSWORD } });
      expect(log.status).toBe(200);
      const sesion = /^sesion=([^;]+)/.exec(log.headers.get('Set-Cookie') ?? '')![1]!;
      const me = await call(app, 'GET', '/api/me', { cookie: `sesion=${sesion}` });
      expect(me.status).toBe(200);
    });
  });

  it.runIf(hasDb)('token inválido o ya usado → 400 "Enlace no válido o caducado"', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      await call(app, 'POST', '/api/auth/register', { cookie, body: await registerBody(tx, 'SOCIO', 'flujo-3@example.com') });
      const token = tokenDelEmail(outbox[0]);
      await call(app, 'POST', '/api/auth/verify', { body: { token, password: PASSWORD } });

      for (const t of [token, 'A'.repeat(43)]) {
        const res = await call(app, 'POST', '/api/auth/verify', { body: { token: t, password: PASSWORD } });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Enlace no válido o caducado' });
      }
    });
  });

  it.runIf(hasDb)('si el envío del email falla, el alta no se guarda (502)', async () => {
    await withApp(
      async ({ app, tx }) => {
        const { cookie } = await loginAs(tx, 'ADMIN');
        const res = await call(app, 'POST', '/api/auth/register', {
          cookie,
          body: await registerBody(tx, 'SOCIO', 'flujo-4@example.com'),
        });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'No se ha podido enviar el email' });
        const [row] = await tx<{ n: number }[]>`select count(*)::int as n from "User" where email = 'flujo-4@example.com'`;
        expect(row!.n).toBe(0);
      },
      {
        email: {
          send: async () => {
            throw new Error('Resend caído');
          },
        },
      },
    );
  });
});

describe('POST /api/admin/users/:id/invitation — reenviar invitación', () => {
  it.runIf(hasDb)('solo ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const { user, cookie } = await loginAs(tx, 'SOCIO');
      const res = await call(app, 'POST', `/api/admin/users/${user.id}/invitation`, { cookie });
      expect(res.status).toBe(403);
    });
  });

  it.runIf(hasDb)('envía un enlace nuevo e invalida el anterior', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const reg = await call(app, 'POST', '/api/auth/register', {
        cookie,
        body: await registerBody(tx, 'SOCIO', 'reenvio@example.com'),
      });
      const { user } = (await reg.json()) as { user: { id: string } };
      const viejo = tokenDelEmail(outbox[0]);

      const res = await call(app, 'POST', `/api/admin/users/${user.id}/invitation`, { cookie });
      expect(res.status).toBe(204);
      expect(outbox).toHaveLength(2);
      const nuevo = tokenDelEmail(outbox[1]);
      expect(nuevo).not.toBe(viejo);

      expect((await call(app, 'POST', '/api/auth/verify', { body: { token: viejo, password: PASSWORD } })).status).toBe(400);
      expect((await call(app, 'POST', '/api/auth/verify', { body: { token: nuevo, password: PASSWORD } })).status).toBe(200);
    });
  });

  it.runIf(hasDb)('usuario ya verificado → 409; inexistente o id no válido → 404', async () => {
    await withApp(async ({ app, tx }) => {
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      expect((await call(app, 'POST', `/api/admin/users/${admin.id}/invitation`, { cookie })).status).toBe(409);
      const inexistente = '00000000-0000-4000-8000-000000000999';
      expect((await call(app, 'POST', `/api/admin/users/${inexistente}/invitation`, { cookie })).status).toBe(404);
      expect((await call(app, 'POST', '/api/admin/users/no-es-uuid/invitation', { cookie })).status).toBe(404);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { FixedWindowLimiter } from '../../src/controller/rate-limit.js';
import { hasDb, withApp, appSinBd, call, PASSWORD } from '../helpers/db.js';
import { createUser } from '../../src/model/user.js';
import { createApp, type AppDeps } from '../../src/controller/app.js';

describe('FixedWindowLimiter', () => {
  it('bloquea al llegar al máximo de fallos y se libera al pasar la ventana', () => {
    let now = 0;
    const l = new FixedWindowLimiter(3, 1000, () => now);
    expect(l.isBlocked('k')).toBe(false);
    l.fail('k');
    l.fail('k');
    expect(l.isBlocked('k')).toBe(false);
    l.fail('k');
    expect(l.isBlocked('k')).toBe(true);
    expect(l.isBlocked('otra')).toBe(false);
    now = 1001;
    expect(l.isBlocked('k')).toBe(false);
  });

  it('reset borra el contador de una clave', () => {
    const l = new FixedWindowLimiter(1, 1000, () => 0);
    l.fail('k');
    expect(l.isBlocked('k')).toBe(true);
    l.reset('k');
    expect(l.isBlocked('k')).toBe(false);
  });
});

describe('Límite de tamaño del JSON', () => {
  it('un cuerpo JSON de más de 64 KB → 413 sin tocar la BD', async () => {
    const res = await call(appSinBd(), 'POST', '/api/auth/login', {
      body: { email: 'a@b.com', password: 'x'.repeat(70 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Petición demasiado grande' });
  });
});

describe('Límite de intentos de login (integración Supabase)', () => {
  const limits = { loginPerEmail: 3, loginPerIp: 100, verifyPerIp: 3, windowMs: 60_000 };

  it.runIf(hasDb)('tras N fallos para un email → 429, exista o no el email (mismo error)', async () => {
    await withApp(
      async ({ app, tx }) => {
        await createUser(tx, null, { email: 'existe-rl@example.com', password: PASSWORD, rol: 'SOCIO' });
        await tx`update "User" set email_verified = true where email = 'existe-rl@example.com'`;
        for (const email of ['existe-rl@example.com', 'nadie-rl@example.com']) {
          for (let i = 0; i < 3; i++) {
            const r = await call(app, 'POST', '/api/auth/login', { body: { email, password: 'contrasena-mala-xx' } });
            expect(r.status).toBe(401);
          }
          const blocked = await call(app, 'POST', '/api/auth/login', { body: { email, password: 'contrasena-mala-xx' } });
          expect(blocked.status).toBe(429);
          expect(await blocked.json()).toEqual({ error: 'Demasiados intentos. Inténtalo más tarde.' });
        }
        // Bloqueado incluso con la contraseña correcta.
        const ok = await call(app, 'POST', '/api/auth/login', { body: { email: 'existe-rl@example.com', password: PASSWORD } });
        expect(ok.status).toBe(429);
      },
      { rateLimit: limits },
    );
  });

  it.runIf(hasDb)('un login correcto reinicia el contador del email', async () => {
    await withApp(
      async ({ app, tx }) => {
        await createUser(tx, null, { email: 'reset-rl@example.com', password: PASSWORD, rol: 'SOCIO' });
        const mala = () => call(app, 'POST', '/api/auth/login', { body: { email: 'reset-rl@example.com', password: 'contrasena-mala-xx' } });
        await mala();
        await mala();
        expect((await call(app, 'POST', '/api/auth/login', { body: { email: 'reset-rl@example.com', password: PASSWORD } })).status).toBe(200);
        await mala();
        await mala();
        expect((await mala()).status).toBe(401);
      },
      { rateLimit: limits },
    );
  });

  it('verify limita intentos fallidos por IP → 429', async () => {
    const app = appSinBdConLimites();
    for (let i = 0; i < 3; i++) {
      // Token mal formado: falla sin tocar la BD.
      expect((await call(app, 'POST', '/api/auth/verify', { body: { token: 'mal', password: PASSWORD } })).status).toBe(400);
    }
    expect((await call(app, 'POST', '/api/auth/verify', { body: { token: 'mal', password: PASSWORD } })).status).toBe(429);
  });
});

function appSinBdConLimites() {
  return createApp({
    // Sin BD: los casos probados fallan antes de usar la transacción.
    transaction: (async (work: (tx: never) => unknown) => work(null as never)) as AppDeps['transaction'],
    email: { send: async () => {} },
    rateLimit: { loginPerEmail: 3, loginPerIp: 100, verifyPerIp: 3, windowMs: 60_000 },
  });
}

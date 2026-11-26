import { describe, it, expect } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { createUser } from '../../src/model/user.js';
import { hashPassword } from '../../src/model/password.js';
import { createSession, hashSessionToken, resolveSession } from '../../src/model/session.js';
import { verifyCredentials, login, type UserWithHash } from '../../src/model/auth.js';
import { InvalidCredentialsError, InvalidDataError } from '../../src/model/errors.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

class Rollback extends Error {}
async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const sql: Sql = createDb();
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await sql.end();
  }
}

const PASSWORD = 'contrasena-de-prueba-larga';

async function fakeUser(): Promise<UserWithHash> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'existe@example.com',
    rol: 'SOCIO',
    email_verified: true,
    created_at: new Date(),
    password_hash: await hashPassword(PASSWORD),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function timeOf(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn().catch(() => {});
  return performance.now() - t0;
}

describe('model/auth — verifyCredentials (sin BD)', () => {
  it('devuelve el usuario si la contraseña es correcta', async () => {
    const user = await fakeUser();
    const res = await verifyCredentials(async () => user, 'existe@example.com', PASSWORD);
    expect(res.id).toBe(user.id);
  });

  it('busca el email normalizado (trim + minúsculas)', async () => {
    const user = await fakeUser();
    let buscado = '';
    await verifyCredentials(
      async (email) => {
        buscado = email;
        return user;
      },
      '  EXISTE@Example.com ',
      PASSWORD,
    );
    expect(buscado).toBe('existe@example.com');
  });

  it('email inexistente y contraseña incorrecta dan el MISMO error', async () => {
    const user = await fakeUser();
    const noExiste = await verifyCredentials(async () => null, 'nadie@example.com', PASSWORD).catch((e: unknown) => e);
    const malaPass = await verifyCredentials(async () => user, 'existe@example.com', 'otra-contrasena-mala').catch(
      (e: unknown) => e,
    );
    expect(noExiste).toBeInstanceOf(InvalidCredentialsError);
    expect(malaPass).toBeInstanceOf(InvalidCredentialsError);
    expect((noExiste as Error).message).toBe((malaPass as Error).message);
  });

  it('contraseña fuera de rango → InvalidDataError (sin depender del email)', async () => {
    await expect(verifyCredentials(async () => null, 'x@example.com', 'corta')).rejects.toBeInstanceOf(
      InvalidDataError,
    );
  });

  it('mismo coste temporal exista o no el email (HASH_SEÑUELO)', async () => {
    const user = await fakeUser();
    const existe = () => verifyCredentials(async () => user, 'existe@example.com', 'otra-contrasena-mala');
    const noExiste = () => verifyCredentials(async () => null, 'nadie@example.com', 'otra-contrasena-mala');

    // Calentamiento (incluye el cálculo inicial del hash señuelo).
    await timeOf(existe);
    await timeOf(noExiste);

    const tExiste: number[] = [];
    const tNoExiste: number[] = [];
    for (let i = 0; i < 7; i++) {
      tExiste.push(await timeOf(existe));
      tNoExiste.push(await timeOf(noExiste));
    }
    const a = median(tExiste);
    const b = median(tNoExiste);
    // Sin señuelo, "no existe" sería ~0 ms frente a decenas de ms de Argon2.
    expect(b).toBeGreaterThan(a * 0.7);
    expect(b).toBeLessThan(a * 1.3);
  }, 30_000);
});

describe('model/auth — login (integración Supabase)', () => {
  it.runIf(hasDb)('con credenciales correctas crea una sesión y devuelve el usuario público', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: 'login-1@example.com', password: PASSWORD, rol: 'SOCIO' });
      const res = await login(tx, 'Login-1@Example.com', PASSWORD, null);

      expect(res.user).toEqual(user);
      expect(res.user).not.toHaveProperty('password_hash');
      const resolved = await resolveSession(tx, res.token);
      expect(resolved!.actor).toEqual({ id: user.id, rol: 'SOCIO' });
      expect(res.expiresAt.getTime()).toBe(resolved!.expiresAt.getTime());
    });
  });

  it.runIf(hasDb)('email inexistente o contraseña mala → InvalidCredentialsError y ninguna sesión', async () => {
    await inRollback(async (tx) => {
      await createUser(tx, null, { email: 'login-2@example.com', password: PASSWORD, rol: 'ALUMNO' });
      await expect(login(tx, 'login-2@example.com', 'contrasena-incorrecta', null)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      await expect(login(tx, 'nadie-2@example.com', PASSWORD, null)).rejects.toBeInstanceOf(InvalidCredentialsError);
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from "Session"`;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('crea siempre una sesión nueva e invalida la previa de la cookie', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: 'login-3@example.com', password: PASSWORD, rol: 'ALUMNO' });
      const previa = await createSession(tx, user.id);

      const res = await login(tx, 'login-3@example.com', PASSWORD, previa.token);
      expect(res.token).not.toBe(previa.token);
      await expect(resolveSession(tx, previa.token)).resolves.toBeNull();
      await expect(resolveSession(tx, res.token)).resolves.not.toBeNull();

      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from "Session" where token_sha256 = ${hashSessionToken(previa.token)}
      `;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('un login fallido NO invalida la sesión previa', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: 'login-4@example.com', password: PASSWORD, rol: 'ALUMNO' });
      const previa = await createSession(tx, user.id);
      await login(tx, 'login-4@example.com', 'contrasena-incorrecta', previa.token).catch(() => {});
      await expect(resolveSession(tx, previa.token)).resolves.not.toBeNull();
    });
  });
});

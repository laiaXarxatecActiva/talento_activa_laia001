import { Hono, type Context } from 'hono';
import type { TransactionSql } from 'postgres';
import { login } from '../model/auth.js';
import { InvalidCredentialsError, InvalidDataError } from '../model/errors.js';
import { isValidPasswordLength } from '../model/password.js';
import { buildSessionCookie, readSessionToken } from './cookie.js';

// Réplica del tipo (no exportado) de `postgres` para `begin`/`savepoint`.
type UnwrapPromiseArray<T> = T extends any[] ? { [k in keyof T]: T[k] extends Promise<infer R> ? R : T[k] } : T;

/**
 * Ejecuta `work` en una transacción. En producción es `sql.begin`; en los tests
 * se abre un savepoint dentro de una transacción que luego se deshace.
 */
export type Transaction = <T>(work: (tx: TransactionSql) => T | Promise<T>) => Promise<UnwrapPromiseArray<T>>;

export interface AppDeps {
  transaction: Transaction;
}

function invalidData(c: Context) {
  return c.json({ error: 'Datos no válidos' }, 400);
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createApp({ transaction }: AppDeps) {
  const app = new Hono();

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c);
    const email = body?.email;
    const password = body?.password;
    if (typeof email !== 'string' || typeof password !== 'string') return invalidData(c);
    // Rechazo temprano: no abre transacción ni toca la BD (y no depende del email).
    if (!isValidPasswordLength(password)) return invalidData(c);

    const previousToken = readSessionToken(c.req.header('Cookie'));
    try {
      const { user, token, expiresAt } = await transaction((tx) => login(tx, email, password, previousToken));
      c.header('Set-Cookie', buildSessionCookie(token, expiresAt));
      return c.json({ user }, 200);
    } catch (e) {
      if (e instanceof InvalidDataError) return invalidData(c);
      if (e instanceof InvalidCredentialsError) return c.json({ error: e.message }, 401);
      throw e;
    }
  });

  return app;
}

import type { Context } from 'hono';
import type { TransactionSql } from 'postgres';
import type { EmailSender } from '../model/email.js';
import type { Actor } from '../model/session.js';

// Réplica del tipo (no exportado) de `postgres` para `begin`/`savepoint`.
type UnwrapPromiseArray<T> = T extends any[] ? { [k in keyof T]: T[k] extends Promise<infer R> ? R : T[k] } : T;

/**
 * Ejecuta `work` en una transacción. En producción es `sql.begin`; en los tests
 * se abre un savepoint dentro de una transacción que luego se deshace.
 */
export type Transaction = <T>(work: (tx: TransactionSql) => T | Promise<T>) => Promise<UnwrapPromiseArray<T>>;

/** Dependencias ya resueltas que usan las rutas. */
export interface Deps {
  transaction: Transaction;
  email: EmailSender;
  /** URL pública de la app, para enlaces en emails. */
  appUrl: string;
}

/** Entorno de Hono: variables que el middleware deja en el contexto. */
export interface AppEnv {
  Variables: { actor: Actor };
}

export type AppContext = Context<AppEnv>;

/** Cuerpo JSON como objeto, o `null` si no es JSON o no es un objeto. */
export async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** ¿Es un UUID? (para rechazar ids de ruta mal formados con 404). */
export { isUuid } from '../model/validation.js';

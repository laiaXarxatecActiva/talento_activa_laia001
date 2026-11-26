import type { Context } from 'hono';
import type { TransactionSql } from 'postgres';
import { writeAudit } from '../model/audit.js';
import type { EmailSender } from '../model/email.js';
import type { Actor } from '../model/session.js';
import type { Storage } from '../model/storage.js';
import type { Limiters } from './rate-limit.js';

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
  /** Almacenamiento de archivos; `null` si no está configurado. */
  storage: Storage | null;
  /** Limitadores de intentos (login/verify). */
  limiters: Limiters;
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

/** IP del cliente (conexión directa; no se confía en X-Forwarded-For). */
export function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'desconocida';
}

export const TOO_MANY = { error: 'Demasiados intentos. Inténtalo más tarde.' } as const;

const REMOVE_ATTEMPTS = 3;

/**
 * Borra archivos de Storage tras confirmar la transacción. Reintenta; si aun así
 * falla, no rompe la respuesta pero deja una entrada en Audit_log
 * (tabla 'Storage', datos {url, estado: 'pendiente'}) para reprocesarla.
 */
export async function removeFiles(
  deps: Pick<Deps, 'storage' | 'transaction'>,
  urls: Array<string | null>,
): Promise<void> {
  const { storage } = deps;
  if (!storage) return;
  for (const url of urls) {
    if (!url) continue;
    let ok = false;
    for (let i = 0; i < REMOVE_ATTEMPTS && !ok; i++) {
      try {
        await storage.remove(url);
        ok = true;
      } catch (e) {
        console.error(`No se pudo borrar de Storage (intento ${i + 1}):`, (e as Error).message);
      }
    }
    if (!ok) {
      await deps.transaction((tx) =>
        writeAudit(tx, {
          idUsuario: null,
          tabla: 'Storage',
          idRegistro: null,
          operacion: 'DELETE',
          datosAnteriores: { url, estado: 'pendiente' },
        }),
      );
    }
  }
}

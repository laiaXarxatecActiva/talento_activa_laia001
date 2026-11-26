import { createHash, randomBytes } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import type { Rol } from './user.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_DURATION_MS = 30 * DAY_MS;
export const SESSION_RENEW_THRESHOLD_MS = 15 * DAY_MS;

/** Identidad con la que el controlador autoriza cada petición. */
export interface Actor {
  id: string;
  rol: Rol;
}

export interface ResolvedSession {
  actor: Actor;
  /** Caducidad vigente (la nueva si se ha renovado). */
  expiresAt: Date;
  /** `true` si se ha extendido la caducidad: hay que reponer la cookie. */
  renewed: boolean;
}

// 32 bytes en base64url sin relleno = 43 caracteres.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Token opaco: 32 bytes de un CSPRNG (`randomBytes`) en base64url. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) del token: es lo único que se guarda en BD. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Crea una sesión de 30 días para el usuario y la audita.
 * @returns el token en claro (solo para ponerlo en la cookie) y su caducidad.
 */
export async function createSession(
  tx: TransactionSql,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  const [row] = await tx<{ id: string }[]>`
    insert into "Session" (user_id, token_sha256, expires_at)
    values (${userId}, ${hashSessionToken(token)}, ${expiresAt})
    returning id
  `;
  if (!row) throw new Error('No se pudo crear la sesión');

  await writeAudit(tx, {
    idUsuario: userId,
    tabla: 'Session',
    idRegistro: row.id,
    operacion: 'INSERT',
    datosNuevos: { user_id: userId, expires_at: expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Borra la sesión del token (logout / invalidar la previa en login).
 * Idempotente: `false` si el token no es válido o no existe.
 * @param actorId autor del borrado para la auditoría; si se omite, el dueño
 *        de la sesión (p. ej. en el logout).
 */
export async function deleteSession(tx: TransactionSql, token: string, actorId?: string | null): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;

  const [row] = await tx<{ id: string; user_id: string; expires_at: Date }[]>`
    delete from "Session" where token_sha256 = ${hashSessionToken(token)}
    returning id, user_id, expires_at
  `;
  if (!row) return false;

  await writeAudit(tx, {
    idUsuario: actorId === undefined ? row.user_id : actorId,
    tabla: 'Session',
    idRegistro: row.id,
    operacion: 'DELETE',
    datosAnteriores: { user_id: row.user_id, expires_at: row.expires_at },
  });
  return true;
}

/**
 * Resuelve un token de sesión.
 *
 * - Token mal formado o inexistente → `null`.
 * - Caducada o usuario inexistente → borra la fila y `null`.
 * - Si quedan menos de 15 días, extiende la caducidad a 30 días desde `now`
 *   (`renewed: true`, hay que reponer la cookie).
 */
export async function resolveSession(
  tx: TransactionSql,
  token: string,
  now: Date = new Date(),
): Promise<ResolvedSession | null> {
  if (!TOKEN_RE.test(token)) return null;

  const [row] = await tx<{ id: string; user_id: string; expires_at: Date; rol: Rol | null }[]>`
    select s.id, s.user_id, s.expires_at, u.rol
    from "Session" s
    left join "User" u on u.id = s.user_id
    where s.token_sha256 = ${hashSessionToken(token)}
  `;
  if (!row) return null;

  if (row.rol === null || row.expires_at.getTime() <= now.getTime()) {
    await tx`delete from "Session" where id = ${row.id}`;
    await writeAudit(tx, {
      idUsuario: null, // lo hace el sistema
      tabla: 'Session',
      idRegistro: row.id,
      operacion: 'DELETE',
      datosAnteriores: { user_id: row.user_id, expires_at: row.expires_at },
    });
    return null;
  }

  const actor: Actor = { id: row.user_id, rol: row.rol };

  if (row.expires_at.getTime() - now.getTime() >= SESSION_RENEW_THRESHOLD_MS) {
    return { actor, expiresAt: row.expires_at, renewed: false };
  }

  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await tx`update "Session" set expires_at = ${expiresAt} where id = ${row.id}`;
  await writeAudit(tx, {
    idUsuario: row.user_id,
    tabla: 'Session',
    idRegistro: row.id,
    operacion: 'UPDATE',
    datosAnteriores: { expires_at: row.expires_at },
    datosNuevos: { expires_at: expiresAt },
  });
  return { actor, expiresAt, renewed: true };
}

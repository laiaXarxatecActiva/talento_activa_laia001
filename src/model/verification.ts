import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { InvalidDataError } from './errors.js';
import { hashPassword, isValidPasswordLength } from './password.js';
import { generateSessionToken, hashSessionToken } from './session.js';
import { getPublicUser, markEmailVerified, type PublicUser } from './user.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Caducidad de los enlaces de invitación/verificación. */
export const VERIFICATION_TTL_MS = 7 * DAY_MS;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const LINK_ERROR = 'Enlace no válido o caducado';

/**
 * Crea un token de verificación de un solo uso (32 bytes, en BD solo su
 * SHA-256) e invalida los anteriores del usuario que no se hayan usado.
 * @returns el token en claro, para el enlace del email.
 */
export async function createVerificationToken(
  tx: TransactionSql,
  userId: string,
  actorId: string | null,
  now: Date = new Date(),
): Promise<string> {
  const previos = await tx<{ id: string; expires_at: Date }[]>`
    delete from "Email_verification_token" where user_id = ${userId} and used_at is null
    returning id, expires_at
  `;
  for (const p of previos) {
    await writeAudit(tx, {
      idUsuario: actorId,
      tabla: 'Email_verification_token',
      idRegistro: p.id,
      operacion: 'DELETE',
      datosAnteriores: { user_id: userId, expires_at: p.expires_at },
    });
  }

  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
  const [row] = await tx<{ id: string }[]>`
    insert into "Email_verification_token" (user_id, token_sha256, expires_at)
    values (${userId}, ${hashSessionToken(token)}, ${expiresAt})
    returning id
  `;
  if (!row) throw new Error('No se pudo crear el token de verificación');
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Email_verification_token',
    idRegistro: row.id,
    operacion: 'INSERT',
    datosNuevos: { user_id: userId, expires_at: expiresAt },
  });
  return token;
}

/**
 * Consume el token: fija la contraseña elegida por el usuario y marca su email
 * como verificado. Un solo uso.
 *
 * @throws InvalidDataError('Datos no válidos') si la contraseña está fuera de
 *         rango (el token NO se consume).
 * @throws InvalidDataError('Enlace no válido o caducado') si el token no existe,
 *         ya se usó o caducó.
 */
export async function consumeVerificationToken(
  tx: TransactionSql,
  token: string,
  password: string,
  now: Date = new Date(),
): Promise<PublicUser> {
  if (!isValidPasswordLength(password)) throw new InvalidDataError();
  if (!TOKEN_RE.test(token)) throw new InvalidDataError(LINK_ERROR);

  const [row] = await tx<{ id: string; user_id: string }[]>`
    select id, user_id from "Email_verification_token"
    where token_sha256 = ${hashSessionToken(token)} and used_at is null and expires_at > ${now}
    for update
  `;
  if (!row) throw new InvalidDataError(LINK_ERROR);

  await tx`update "Email_verification_token" set used_at = ${now} where id = ${row.id}`;
  await writeAudit(tx, {
    idUsuario: row.user_id,
    tabla: 'Email_verification_token',
    idRegistro: row.id,
    operacion: 'UPDATE',
    datosAnteriores: { used_at: null },
    datosNuevos: { used_at: now },
  });

  const passwordHash = await hashPassword(password);
  await tx`update "User" set password_hash = ${passwordHash} where id = ${row.user_id}`;
  await writeAudit(tx, {
    idUsuario: row.user_id,
    tabla: 'User',
    idRegistro: row.user_id,
    operacion: 'UPDATE',
    datosNuevos: { password_actualizada: true },
  });
  await markEmailVerified(tx, row.user_id, row.user_id);

  const user = await getPublicUser(tx, row.user_id);
  if (!user) throw new InvalidDataError(LINK_ERROR);
  return user;
}

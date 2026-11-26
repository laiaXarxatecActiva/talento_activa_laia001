import { randomBytes } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { InvalidCredentialsError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, deleteSession } from './session.js';
import type { PublicUser } from './user.js';

/** Usuario con su hash: SOLO para uso interno del modelo, nunca se devuelve. */
export interface UserWithHash extends PublicUser {
  password_hash: string;
}

export type FindUserByEmail = (normalizedEmail: string) => Promise<UserWithHash | null>;

/**
 * Hash Argon2id de una contraseña aleatoria que nadie conoce. Cuando el email
 * no existe se verifica contra él para que el login tarde lo mismo que con una
 * contraseña incorrecta (anti-enumeración). Se genera al cargar el módulo, con
 * los mismos parámetros que los hashes reales, para que la primera petición no
 * pague un coste extra.
 */
const HASH_SEÑUELO: Promise<string> = hashPassword(randomBytes(32).toString('base64url'));

/**
 * Comprueba email + contraseña. Hace SIEMPRE una verificación Argon2id, exista
 * o no el email.
 *
 * @throws InvalidDataError si la contraseña está fuera de rango.
 * @throws InvalidCredentialsError (mismo mensaje) si el email no existe o la
 *         contraseña no coincide.
 */
export async function verifyCredentials(
  findUser: FindUserByEmail,
  email: string,
  password: string,
): Promise<UserWithHash> {
  const user = await findUser(email.trim().toLowerCase());
  const ok = await verifyPassword(user?.password_hash ?? (await HASH_SEÑUELO), password);
  if (!user || !ok) throw new InvalidCredentialsError();
  return user;
}

function findUserByEmail(tx: TransactionSql): FindUserByEmail {
  return async (normalizedEmail) => {
    const [user] = await tx<UserWithHash[]>`
      select id, email, rol, email_verified, created_at, password_hash
      from "User" where lower(email) = ${normalizedEmail}
    `;
    return user ?? null;
  };
}

export interface LoginResult {
  user: PublicUser;
  /** Token en claro: solo para la cookie. */
  token: string;
  expiresAt: Date;
}

/**
 * Login: verifica credenciales, invalida la sesión previa de la cookie (si la
 * hay) y crea SIEMPRE una sesión nueva. Un login fallido no toca la sesión previa.
 */
export async function login(
  tx: TransactionSql,
  email: string,
  password: string,
  previousToken: string | null,
): Promise<LoginResult> {
  const { password_hash: _hash, ...user } = await verifyCredentials(findUserByEmail(tx), email, password);

  if (previousToken) await deleteSession(tx, previousToken, user.id);
  const { token, expiresAt } = await createSession(tx, user.id);
  return { user, token, expiresAt };
}

import { randomBytes } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { ConflictError, InvalidDataError } from './errors.js';
import { hashPassword } from './password.js';

export const ROLES = ['ADMIN', 'SOCIO', 'ALUMNO'] as const;
export type Rol = (typeof ROLES)[number];

export interface NewUser {
  email: string;
  password: string;
  rol: Rol;
}

/** Proyección pública del usuario: NUNCA incluye `password_hash`. */
export interface PublicUser {
  id: string;
  email: string;
  rol: Rol;
  email_verified: boolean;
  created_at: Date;
}

const EMAIL_MAX_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_UNIQUE_CONSTRAINT = 'user_email_lower_uk';

/** Email normalizado (sin espacios, minúsculas) o InvalidDataError. */
function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(normalized)) {
    throw new InvalidDataError();
  }
  return normalized;
}

function isEmailConflict(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === EMAIL_UNIQUE_CONSTRAINT;
}

/**
 * Da de alta un usuario por invitación (`email_verified=false`) y audita el
 * alta en la misma transacción.
 *
 * La inserción va en un savepoint: si el email ya existe se deshace solo esa
 * parte y la transacción del llamante sigue siendo usable.
 *
 * @param actorId usuario que crea la cuenta (el ADMIN), o `null` si es el sistema.
 * @throws InvalidDataError si el email, el rol o la contraseña no son válidos.
 * @throws ConflictError (mensaje genérico) si el email ya está registrado.
 */
export async function createUser(tx: TransactionSql, actorId: string | null, input: NewUser): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  if (!ROLES.includes(input.rol)) throw new InvalidDataError();
  // Se hashea siempre antes de tocar la BD: el coste temporal es el mismo
  // exista o no el email.
  const passwordHash = await hashPassword(input.password);

  try {
    return await tx.savepoint(async (sp) => {
      const [user] = await sp<PublicUser[]>`
        insert into "User" (email, password_hash, rol)
        values (${email}, ${passwordHash}, ${input.rol})
        returning id, email, rol, email_verified, created_at
      `;
      if (!user) throw new Error('No se pudo crear el usuario');

      await writeAudit(sp, {
        idUsuario: actorId,
        tabla: 'User',
        idRegistro: user.id,
        operacion: 'INSERT',
        datosNuevos: { ...user },
      });
      return user;
    });
  } catch (e) {
    if (isEmailConflict(e)) throw new ConflictError();
    throw e;
  }
}

/** Usuario por id en su proyección pública (sin hash), o `null`. */
export async function getPublicUser(tx: TransactionSql, id: string): Promise<PublicUser | null> {
  const [user] = await tx<PublicUser[]>`
    select id, email, rol, email_verified, created_at from "User" where id = ${id}
  `;
  return user ?? null;
}

/** Roles que se pueden invitar desde la API (el staff ADMIN se da de alta aparte). */
export const INVITABLE_ROLES = ['SOCIO', 'ALUMNO'] as const;
export type InvitableRol = (typeof INVITABLE_ROLES)[number];

/**
 * Alta por invitación. La cuenta nace sin verificar y con una contraseña
 * aleatoria que nadie conoce: el usuario fija la suya al verificar el email.
 *
 * @throws InvalidDataError si el rol no es invitable o el email no es válido.
 * @throws ConflictError si el email ya existe.
 */
export async function inviteUser(
  tx: TransactionSql,
  actorId: string | null,
  input: { email: string; rol: InvitableRol },
): Promise<PublicUser> {
  if (!(INVITABLE_ROLES as readonly string[]).includes(input.rol)) throw new InvalidDataError();
  const unusablePassword = randomBytes(32).toString('base64url');
  return createUser(tx, actorId, { email: input.email, password: unusablePassword, rol: input.rol });
}

/** Marca el email del usuario como verificado (auditado). Idempotente. */
export async function markEmailVerified(tx: TransactionSql, actorId: string | null, userId: string): Promise<void> {
  const [prev] = await tx<{ email_verified: boolean }[]>`
    select email_verified from "User" where id = ${userId} for update
  `;
  if (!prev) throw new InvalidDataError();
  if (prev.email_verified) return;

  await tx`update "User" set email_verified = true where id = ${userId}`;
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'User',
    idRegistro: userId,
    operacion: 'UPDATE',
    datosAnteriores: { email_verified: false },
    datosNuevos: { email_verified: true },
  });
}

/**
 * Alta del ADMIN inicial (staff), fuera de la API: ya verificado.
 * Lo usa `scripts/create-admin.ts`.
 */
export async function createInitialAdmin(tx: TransactionSql, email: string, password: string): Promise<PublicUser> {
  const admin = await createUser(tx, null, { email, password, rol: 'ADMIN' });
  await markEmailVerified(tx, null, admin.id);
  return { ...admin, email_verified: true };
}

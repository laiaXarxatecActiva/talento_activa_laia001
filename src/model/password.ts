import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { InvalidDataError } from './errors.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// `Algorithm` es un const enum ambiental: con verbatimModuleSyntax no se puede
// usar como valor, así que se pone el literal (Argon2id = 2) tipado.
const ARGON2ID = 2 as Algorithm.Argon2id;

/** Parámetros Argon2id exigidos por el cliente (ver CLAUDE.md). */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Lanza InvalidDataError si la contraseña no tiene entre 12 y 256 caracteres.
 * Se cuentan caracteres (code points), no unidades UTF-16. El límite superior
 * evita además gastar CPU hasheando entradas enormes.
 */
export function isValidPasswordLength(plain: string): boolean {
  const length = [...plain].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

function assertPasswordLength(plain: string): void {
  if (!isValidPasswordLength(plain)) throw new InvalidDataError('Datos no válidos');
}

/** Devuelve el hash Argon2id (formato PHC, con sal aleatoria) de la contraseña. */
export async function hashPassword(plain: string): Promise<string> {
  assertPasswordLength(plain);
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Comprueba la contraseña contra un hash Argon2id.
 * @returns `false` si no coincide o si el hash está mal formado.
 * @throws InvalidDataError si la contraseña está fuera de rango.
 */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  assertPasswordLength(plain);
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

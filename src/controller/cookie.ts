/**
 * Helpers de la cookie de sesión. El token viaja SOLO en esta cookie: nunca en
 * body, URL ni almacenamiento del navegador (ver CLAUDE.md).
 */

export const SESSION_COOKIE_NAME = 'sesion';

export interface CookieOptions {
  /** `Secure`; por defecto, solo cuando NODE_ENV=production. */
  secure?: boolean;
}

// Mismo formato que genera el modelo: 32 bytes en base64url.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EPOCH = new Date(0);

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function serialize(value: string, expires: Date, { secure = isProduction() }: CookieOptions): string {
  // `Expires` con fecha absoluta (formato HTTP, RFC 7231). Nunca `Max-Age`.
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Expires=${expires.toUTCString()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Valor de `Set-Cookie` que establece la sesión hasta `expiresAt`. */
export function buildSessionCookie(token: string, expiresAt: Date, options: CookieOptions = {}): string {
  if (!TOKEN_RE.test(token)) throw new Error('Token de sesión con formato no válido');
  if (Number.isNaN(expiresAt.getTime())) throw new Error('Fecha de caducidad no válida');
  return serialize(token, expiresAt, options);
}

/** Valor de `Set-Cookie` que borra la sesión del navegador. */
export function buildClearSessionCookie(options: CookieOptions = {}): string {
  return serialize('', EPOCH, options);
}

/** Token de la cookie `sesion` en la cabecera `Cookie`, o `null`. */
export function readSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const prefix = `${SESSION_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(';')) {
    const pair = part.trim();
    if (pair.startsWith(prefix)) {
      const value = pair.slice(prefix.length);
      return value === '' ? null : value;
    }
  }
  return null;
}

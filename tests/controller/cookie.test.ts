import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  buildClearSessionCookie,
  readSessionToken,
} from '../../src/controller/cookie.js';
import { generateSessionToken } from '../../src/model/session.js';

const EXPIRES = new Date('2026-12-26T10:30:00Z');
const EXPIRES_HTTP = 'Sat, 26 Dec 2026 10:30:00 GMT';

function attrs(header: string): string[] {
  return header.split(';').map((p) => p.trim());
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('controller/cookie — buildSessionCookie', () => {
  it('el nombre de la cookie es "sesion"', () => {
    expect(SESSION_COOKIE_NAME).toBe('sesion');
  });

  it('pone el token como valor de "sesion"', () => {
    const token = generateSessionToken();
    const header = buildSessionCookie(token, EXPIRES, { secure: false });
    expect(attrs(header)[0]).toBe(`sesion=${token}`);
  });

  it('lleva HttpOnly, SameSite=Lax y Path=/', () => {
    const a = attrs(buildSessionCookie(generateSessionToken(), EXPIRES, { secure: false }));
    expect(a).toContain('HttpOnly');
    expect(a).toContain('SameSite=Lax');
    expect(a).toContain('Path=/');
  });

  it('usa Expires con fecha absoluta en formato HTTP y nunca Max-Age', () => {
    const header = buildSessionCookie(generateSessionToken(), EXPIRES, { secure: false });
    expect(attrs(header)).toContain(`Expires=${EXPIRES_HTTP}`);
    expect(header.toLowerCase()).not.toContain('max-age');
  });

  it('Secure solo si se pide', () => {
    expect(attrs(buildSessionCookie(generateSessionToken(), EXPIRES, { secure: true }))).toContain('Secure');
    expect(attrs(buildSessionCookie(generateSessionToken(), EXPIRES, { secure: false }))).not.toContain('Secure');
  });

  it('por defecto, Secure solo cuando NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(attrs(buildSessionCookie(generateSessionToken(), EXPIRES))).toContain('Secure');
    vi.stubEnv('NODE_ENV', 'development');
    expect(attrs(buildSessionCookie(generateSessionToken(), EXPIRES))).not.toContain('Secure');
  });

  it('rechaza un token con formato no válido (evita inyectar atributos)', () => {
    expect(() => buildSessionCookie('abc; Domain=evil.com', EXPIRES, { secure: false })).toThrow();
    expect(() => buildSessionCookie('', EXPIRES, { secure: false })).toThrow();
  });

  it('rechaza una fecha no válida', () => {
    expect(() => buildSessionCookie(generateSessionToken(), new Date('nope'), { secure: false })).toThrow();
  });
});

describe('controller/cookie — buildClearSessionCookie', () => {
  it('vacía "sesion" con Expires en el pasado y los mismos flags', () => {
    const header = buildClearSessionCookie({ secure: true });
    const a = attrs(header);
    expect(a[0]).toBe('sesion=');
    expect(a).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(a).toContain('HttpOnly');
    expect(a).toContain('SameSite=Lax');
    expect(a).toContain('Path=/');
    expect(a).toContain('Secure');
    expect(header.toLowerCase()).not.toContain('max-age');
  });

  it('sin Secure fuera de producción', () => {
    expect(attrs(buildClearSessionCookie({ secure: false }))).not.toContain('Secure');
  });
});

describe('controller/cookie — readSessionToken', () => {
  it('extrae el token de la cabecera Cookie', () => {
    const token = generateSessionToken();
    expect(readSessionToken(`otra=1; sesion=${token}; tema=oscuro`)).toBe(token);
  });

  it('devuelve null si no hay cabecera o no hay cookie "sesion"', () => {
    expect(readSessionToken(undefined)).toBeNull();
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('')).toBeNull();
    expect(readSessionToken('otra=1; sesiones=x')).toBeNull();
  });

  it('devuelve null si la cookie "sesion" está vacía', () => {
    expect(readSessionToken('sesion=')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../../src/model/password.js';
import { InvalidDataError } from '../../src/model/errors.js';

const VALIDA = 'correcto-caballo-bateria';

describe('model/password — límites de longitud', () => {
  it('los límites son 12 y 256', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(256);
  });

  it('rechaza 11 caracteres con InvalidDataError', async () => {
    await expect(hashPassword('a'.repeat(11))).rejects.toBeInstanceOf(InvalidDataError);
  });

  it('acepta exactamente 12 caracteres', async () => {
    await expect(hashPassword('a'.repeat(12))).resolves.toMatch(/^\$argon2id\$/);
  });

  it('acepta exactamente 256 caracteres', async () => {
    await expect(hashPassword('a'.repeat(256))).resolves.toMatch(/^\$argon2id\$/);
  });

  it('rechaza 257 caracteres con InvalidDataError', async () => {
    await expect(hashPassword('a'.repeat(257))).rejects.toBeInstanceOf(InvalidDataError);
  });

  it('rechaza la cadena vacía', async () => {
    await expect(hashPassword('')).rejects.toBeInstanceOf(InvalidDataError);
  });

  it('cuenta caracteres, no unidades UTF-16 (12 emojis son válidos)', async () => {
    await expect(hashPassword('🔒'.repeat(12))).resolves.toMatch(/^\$argon2id\$/);
  });

  it('verifyPassword también rechaza contraseñas fuera de rango', async () => {
    const hash = await hashPassword(VALIDA);
    await expect(verifyPassword(hash, 'a'.repeat(257))).rejects.toBeInstanceOf(InvalidDataError);
    await expect(verifyPassword(hash, 'corta')).rejects.toBeInstanceOf(InvalidDataError);
  });
});

describe('model/password — hash Argon2id', () => {
  it('usa Argon2id con m=19456, t=2, p=1', async () => {
    const hash = await hashPassword(VALIDA);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('no contiene la contraseña en claro', async () => {
    const hash = await hashPassword(VALIDA);
    expect(hash).not.toContain(VALIDA);
  });

  it('usa sal aleatoria: dos hashes de la misma contraseña difieren', async () => {
    const [a, b] = await Promise.all([hashPassword(VALIDA), hashPassword(VALIDA)]);
    expect(a).not.toBe(b);
  });
});

describe('model/password — verificación', () => {
  it('verifica la contraseña correcta', async () => {
    const hash = await hashPassword(VALIDA);
    await expect(verifyPassword(hash, VALIDA)).resolves.toBe(true);
  });

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await hashPassword(VALIDA);
    await expect(verifyPassword(hash, 'otra-contrasena-larga')).resolves.toBe(false);
  });

  it('devuelve false (no lanza) si el hash está mal formado', async () => {
    await expect(verifyPassword('no-es-un-hash', VALIDA)).resolves.toBe(false);
  });
});

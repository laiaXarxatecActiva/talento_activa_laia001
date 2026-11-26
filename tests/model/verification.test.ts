import { describe, it, expect } from 'vitest';
import type { TransactionSql } from 'postgres';
import { hasDb, inRollback, PASSWORD } from '../helpers/db.js';
import { inviteUser } from '../../src/model/user.js';
import { login } from '../../src/model/auth.js';
import { hashSessionToken } from '../../src/model/session.js';
import {
  createVerificationToken,
  consumeVerificationToken,
  VERIFICATION_TTL_MS,
} from '../../src/model/verification.js';
import { InvalidDataError } from '../../src/model/errors.js';

const DAY = 24 * 60 * 60 * 1000;

async function invitado(tx: TransactionSql, email: string) {
  return inviteUser(tx, null, { email, rol: 'SOCIO' });
}

describe('model/verification — constantes', () => {
  it('los enlaces caducan a los 7 días', () => {
    expect(VERIFICATION_TTL_MS).toBe(7 * DAY);
  });
});

describe('model/verification — integración Supabase', () => {
  it.runIf(hasDb)('createVerificationToken guarda solo el SHA-256 con caducidad de 7 días', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-1@example.com');
      const now = new Date('2026-03-01T00:00:00Z');
      const token = await createVerificationToken(tx, user.id, null, now);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await tx`select token_sha256, expires_at, used_at from "Email_verification_token" where user_id = ${user.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_sha256).toBe(hashSessionToken(token));
      expect((rows[0]!.expires_at as Date).getTime()).toBe(now.getTime() + 7 * DAY);
      expect(rows[0]!.used_at).toBeNull();
    });
  });

  it.runIf(hasDb)('consumir el token fija la contraseña, verifica el email y permite login', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-2@example.com');
      const token = await createVerificationToken(tx, user.id, null);
      const verificado = await consumeVerificationToken(tx, token, PASSWORD);
      expect(verificado).toMatchObject({ id: user.id, email_verified: true });
      expect(verificado).not.toHaveProperty('password_hash');

      const res = await login(tx, 'ver-2@example.com', PASSWORD, null);
      expect(res.user.id).toBe(user.id);
      const [row] = await tx`select used_at from "Email_verification_token" where user_id = ${user.id}`;
      expect(row!.used_at).toBeInstanceOf(Date);
    });
  });

  it.runIf(hasDb)('es de un solo uso', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-3@example.com');
      const token = await createVerificationToken(tx, user.id, null);
      await consumeVerificationToken(tx, token, PASSWORD);
      await expect(consumeVerificationToken(tx, token, 'otra-contrasena-larga')).rejects.toBeInstanceOf(
        InvalidDataError,
      );
      // La contraseña no ha cambiado.
      await expect(login(tx, 'ver-3@example.com', PASSWORD, null)).resolves.toBeTruthy();
    });
  });

  it.runIf(hasDb)('caducado o inexistente → InvalidDataError con mensaje de enlace', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-4@example.com');
      const now = new Date();
      const viejo = await createVerificationToken(tx, user.id, null, new Date(now.getTime() - 8 * DAY));
      const e1 = await consumeVerificationToken(tx, viejo, PASSWORD, now).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(InvalidDataError);
      expect((e1 as Error).message).toBe('Enlace no válido o caducado');

      const e2 = await consumeVerificationToken(tx, 'A'.repeat(43), PASSWORD).catch((e: unknown) => e);
      expect((e2 as Error).message).toBe('Enlace no válido o caducado');
      const e3 = await consumeVerificationToken(tx, 'mal', PASSWORD).catch((e: unknown) => e);
      expect((e3 as Error).message).toBe('Enlace no válido o caducado');
    });
  });

  it.runIf(hasDb)('un token nuevo invalida los anteriores sin usar', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-5@example.com');
      const primero = await createVerificationToken(tx, user.id, null);
      const segundo = await createVerificationToken(tx, user.id, null);
      await expect(consumeVerificationToken(tx, primero, PASSWORD)).rejects.toBeInstanceOf(InvalidDataError);
      await expect(consumeVerificationToken(tx, segundo, PASSWORD)).resolves.toBeTruthy();
    });
  });

  it.runIf(hasDb)('contraseña fuera de rango → InvalidDataError y el token sigue válido', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-6@example.com');
      const token = await createVerificationToken(tx, user.id, null);
      const e = await consumeVerificationToken(tx, token, 'corta').catch((err: unknown) => err);
      expect(e).toBeInstanceOf(InvalidDataError);
      expect((e as Error).message).toBe('Datos no válidos');
      await expect(consumeVerificationToken(tx, token, PASSWORD)).resolves.toBeTruthy();
    });
  });

  it.runIf(hasDb)('la auditoría no contiene el token, su hash ni el hash de la contraseña', async () => {
    await inRollback(async (tx) => {
      const user = await invitado(tx, 'ver-7@example.com');
      const token = await createVerificationToken(tx, user.id, null);
      await consumeVerificationToken(tx, token, PASSWORD);
      const rows = await tx`select tabla, operacion, datos_anteriores, datos_nuevos from "Audit_log"`;
      const tablas = rows.map((r) => `${r.tabla}:${r.operacion}`);
      expect(tablas).toContain('Email_verification_token:INSERT');
      expect(tablas).toContain('Email_verification_token:UPDATE');
      const texto = JSON.stringify(rows);
      expect(texto).not.toContain(token);
      expect(texto).not.toContain(hashSessionToken(token));
      expect(texto).not.toContain('argon2');
    });
  });
});

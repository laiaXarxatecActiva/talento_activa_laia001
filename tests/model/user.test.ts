import { describe, it, expect } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { createUser, type NewUser } from '../../src/model/user.js';
import { ConflictError, InvalidDataError } from '../../src/model/errors.js';
import { verifyPassword } from '../../src/model/password.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

// Transacción que SIEMPRE se deshace: no deja filas de prueba en la BD.
class Rollback extends Error {}
async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const sql: Sql = createDb();
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await sql.end();
  }
}

const PASSWORD = 'contrasena-de-prueba-larga';

// Cliente falso: si la validación funciona, nunca se llega a la BD.
const noDb = (() => {
  throw new Error('no debería llamarse a la BD');
}) as unknown as TransactionSql;

describe('model/user — validación de createUser (sin BD)', () => {
  it('rechaza un email sin formato válido', async () => {
    await expect(
      createUser(noDb, null, { email: 'no-es-email', password: PASSWORD, rol: 'ALUMNO' }),
    ).rejects.toBeInstanceOf(InvalidDataError);
  });

  it('rechaza un email vacío', async () => {
    await expect(createUser(noDb, null, { email: '   ', password: PASSWORD, rol: 'ALUMNO' })).rejects.toBeInstanceOf(
      InvalidDataError,
    );
  });

  it('rechaza un rol desconocido', async () => {
    const input = { email: 'a@b.com', password: PASSWORD, rol: 'ROOT' } as unknown as NewUser;
    await expect(createUser(noDb, null, input)).rejects.toBeInstanceOf(InvalidDataError);
  });

  it('rechaza una contraseña fuera de rango', async () => {
    await expect(createUser(noDb, null, { email: 'a@b.com', password: 'corta', rol: 'ALUMNO' })).rejects.toBeInstanceOf(
      InvalidDataError,
    );
  });
});

describe('model/user — createUser (integración Supabase)', () => {
  it.runIf(hasDb)('crea el usuario con email_verified=false y devuelve la proyección pública', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, {
        email: 'alta-1@example.com',
        password: PASSWORD,
        rol: 'SOCIO',
      });
      expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(user.email).toBe('alta-1@example.com');
      expect(user.rol).toBe('SOCIO');
      expect(user.email_verified).toBe(false);
      expect(user.created_at).toBeInstanceOf(Date);
      expect(user).not.toHaveProperty('password_hash');
    });
  });

  it.runIf(hasDb)('guarda la contraseña como hash Argon2id verificable, nunca en claro', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: 'alta-2@example.com', password: PASSWORD, rol: 'ALUMNO' });
      const [row] = await tx<{ password_hash: string }[]>`select password_hash from "User" where id = ${user.id}`;
      expect(row!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(row!.password_hash).not.toContain(PASSWORD);
      await expect(verifyPassword(row!.password_hash, PASSWORD)).resolves.toBe(true);
    });
  });

  it.runIf(hasDb)('normaliza el email quitando espacios y pasándolo a minúsculas', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: '  Alta-3@Example.COM ', password: PASSWORD, rol: 'ALUMNO' });
      expect(user.email).toBe('alta-3@example.com');
    });
  });

  it.runIf(hasDb)('email repetido (sin distinguir mayúsculas) → ConflictError genérico', async () => {
    await inRollback(async (tx) => {
      await createUser(tx, null, { email: 'alta-4@example.com', password: PASSWORD, rol: 'ALUMNO' });
      const err = await createUser(tx, null, {
        email: 'ALTA-4@example.com',
        password: PASSWORD,
        rol: 'SOCIO',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as Error).message).toBe('No se ha podido completar el registro');

      // El conflicto no deja la transacción del llamante inutilizable.
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from "User" where lower(email) = 'alta-4@example.com'
      `;
      expect(row!.n).toBe(1);
    });
  });

  it.runIf(hasDb)('audita el alta en Audit_log con el autor y sin el hash', async () => {
    await inRollback(async (tx) => {
      const admin = await createUser(tx, null, { email: 'admin-5@example.com', password: PASSWORD, rol: 'ADMIN' });
      const user = await createUser(tx, admin.id, { email: 'alta-5@example.com', password: PASSWORD, rol: 'ALUMNO' });

      const rows = await tx`
        select id_usuario, tabla, operacion, datos_anteriores, datos_nuevos
        from "Audit_log" where tabla = 'User' and id_registro = ${user.id}
      `;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id_usuario).toBe(admin.id);
      expect(row.operacion).toBe('INSERT');
      expect(row.datos_anteriores).toBeNull();
      expect(row.datos_nuevos).toMatchObject({ email: 'alta-5@example.com', rol: 'ALUMNO', email_verified: false });
      expect(JSON.stringify(row)).not.toContain('argon2id');
    });
  });

  it.runIf(hasDb)('un alta fallida por conflicto no deja rastro en Audit_log', async () => {
    await inRollback(async (tx) => {
      await createUser(tx, null, { email: 'alta-6@example.com', password: PASSWORD, rol: 'ALUMNO' });
      await createUser(tx, null, { email: 'alta-6@example.com', password: PASSWORD, rol: 'ALUMNO' }).catch(() => {});
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from "Audit_log"
        where tabla = 'User' and datos_nuevos->>'email' = 'alta-6@example.com'
      `;
      expect(row!.n).toBe(1);
    });
  });
});

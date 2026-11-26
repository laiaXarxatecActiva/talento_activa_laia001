import { describe, it, expect } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { sanitizeAuditData, writeAudit, type AuditEntry } from '../../src/model/audit.js';

// Igual que en db.test.ts: los tests de integración solo corren con una
// DATABASE_URL real.
const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

// Ejecuta `fn` dentro de una transacción que SIEMPRE se deshace, para no dejar
// filas de prueba en la BD.
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

describe('model/audit — sanitizeAuditData', () => {
  it('devuelve null si no hay datos', () => {
    expect(sanitizeAuditData(null)).toBeNull();
    expect(sanitizeAuditData(undefined)).toBeNull();
  });

  it('conserva los campos no sensibles', () => {
    expect(sanitizeAuditData({ email: 'a@b.c', rol: 'ALUMNO' })).toEqual({
      email: 'a@b.c',
      rol: 'ALUMNO',
    });
  });

  it('elimina el hash de la contraseña y la contraseña en claro', () => {
    const out = sanitizeAuditData({ email: 'a@b.c', password_hash: '$argon2id$x', password: 'secreta123456' });
    expect(out).toEqual({ email: 'a@b.c' });
  });

  it('elimina tokens de sesión/verificación (en claro o su hash)', () => {
    const out = sanitizeAuditData({ user_id: 'u1', token: 'abc', token_sha256: 'deadbeef' });
    expect(out).toEqual({ user_id: 'u1' });
  });

  it('elimina campos sensibles también en objetos y arrays anidados', () => {
    const out = sanitizeAuditData({
      usuario: { email: 'a@b.c', password_hash: 'h' },
      sesiones: [{ id: 's1', token_sha256: 't' }],
    });
    expect(out).toEqual({ usuario: { email: 'a@b.c' }, sesiones: [{ id: 's1' }] });
  });

  it('no muta el objeto original', () => {
    const original = { email: 'a@b.c', password_hash: 'h' };
    sanitizeAuditData(original);
    expect(original).toEqual({ email: 'a@b.c', password_hash: 'h' });
  });
});

describe('model/audit — writeAudit (validación)', () => {
  it('rechaza una operación no válida sin tocar la BD', async () => {
    const fakeSql = (() => {
      throw new Error('no debería llamarse a la BD');
    }) as unknown as Sql;
    const entry = {
      idUsuario: null,
      tabla: 'User',
      idRegistro: null,
      operacion: 'TRUNCATE',
    } as unknown as AuditEntry;
    await expect(writeAudit(fakeSql, entry)).rejects.toThrow(/operaci/i);
  });

  it('rechaza una tabla vacía sin tocar la BD', async () => {
    const fakeSql = (() => {
      throw new Error('no debería llamarse a la BD');
    }) as unknown as Sql;
    await expect(
      writeAudit(fakeSql, { idUsuario: null, tabla: '  ', idRegistro: null, operacion: 'INSERT' }),
    ).rejects.toThrow(/tabla/i);
  });
});

describe('model/audit — writeAudit (integración Supabase)', () => {
  it.runIf(hasDb)('inserta una fila en "Audit_log" y devuelve su id', async () => {
    await inRollback(async (tx) => {
      const idRegistro = '00000000-0000-4000-8000-000000000001';
      const id = await writeAudit(tx, {
        idUsuario: null,
        tabla: 'Edition',
        idRegistro,
        operacion: 'INSERT',
        datosNuevos: { nombre: 'Edición de prueba' },
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const rows = await tx`select * from "Audit_log" where id = ${id}`;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id_usuario).toBeNull();
      expect(row.tabla).toBe('Edition');
      expect(row.id_registro).toBe(idRegistro);
      expect(row.operacion).toBe('INSERT');
      expect(row.datos_anteriores).toBeNull();
      expect(row.datos_nuevos).toEqual({ nombre: 'Edición de prueba' });
      expect(row.timestamp).toBeInstanceOf(Date);
    });
  });

  it.runIf(hasDb)('nunca persiste el hash de la contraseña ni tokens', async () => {
    await inRollback(async (tx) => {
      const id = await writeAudit(tx, {
        idUsuario: null,
        tabla: 'User',
        idRegistro: null,
        operacion: 'UPDATE',
        datosAnteriores: { email: 'old@x.com', password_hash: '$argon2id$old' },
        datosNuevos: { email: 'new@x.com', password_hash: '$argon2id$new', token: 'tok' },
      });
      const [row] = await tx`select datos_anteriores, datos_nuevos from "Audit_log" where id = ${id}`;
      expect(row!.datos_anteriores).toEqual({ email: 'old@x.com' });
      expect(row!.datos_nuevos).toEqual({ email: 'new@x.com' });
      const texto = JSON.stringify(row);
      expect(texto).not.toContain('argon2id');
      expect(texto).not.toContain('tok');
    });
  });

  it.runIf(hasDb)('registra el usuario autor de la mutación', async () => {
    await inRollback(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        insert into "User" (email, password_hash, rol)
        values ('audit-test@example.com', 'x', 'ADMIN')
        returning id
      `;
      const id = await writeAudit(tx, {
        idUsuario: user!.id,
        tabla: 'Edition',
        idRegistro: null,
        operacion: 'DELETE',
        datosAnteriores: { nombre: 'Borrada' },
      });
      const [row] = await tx`select id_usuario, datos_nuevos from "Audit_log" where id = ${id}`;
      expect(row!.id_usuario).toBe(user!.id);
      expect(row!.datos_nuevos).toBeNull();
    });
  });
});

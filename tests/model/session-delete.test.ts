import { describe, it, expect } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { createUser } from '../../src/model/user.js';
import { createSession, deleteSession, generateSessionToken, hashSessionToken } from '../../src/model/session.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

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

const noDb = (() => {
  throw new Error('no debería llamarse a la BD');
}) as unknown as TransactionSql;

describe('model/session — deleteSession sin BD', () => {
  it('token mal formado → false sin consultar la BD', async () => {
    await expect(deleteSession(noDb, 'no-vale', null)).resolves.toBe(false);
  });
});

describe('model/session — deleteSession (integración Supabase)', () => {
  it.runIf(hasDb)('borra la sesión del token y devuelve true', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: 'del-1@example.com', password: 'contrasena-larga-1', rol: 'ALUMNO' });
      const { token } = await createSession(tx, user.id);
      await expect(deleteSession(tx, token, user.id)).resolves.toBe(true);
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from "Session" where token_sha256 = ${hashSessionToken(token)}
      `;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('es idempotente: un token inexistente devuelve false', async () => {
    await inRollback(async (tx) => {
      await expect(deleteSession(tx, generateSessionToken(), null)).resolves.toBe(false);
    });
  });

  it.runIf(hasDb)('audita el borrado con el autor y sin token ni hash', async () => {
    await inRollback(async (tx) => {
      const user = await createUser(tx, null, { email: 'del-2@example.com', password: 'contrasena-larga-2', rol: 'ALUMNO' });
      const { token } = await createSession(tx, user.id);
      await deleteSession(tx, token, user.id);
      const rows = await tx`
        select id_usuario, datos_anteriores from "Audit_log" where tabla = 'Session' and operacion = 'DELETE'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id_usuario).toBe(user.id);
      expect(rows[0]!.datos_anteriores).toMatchObject({ user_id: user.id });
      const texto = JSON.stringify(rows);
      expect(texto).not.toContain(token);
      expect(texto).not.toContain(hashSessionToken(token));
    });
  });
});

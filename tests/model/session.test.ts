import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { createUser } from '../../src/model/user.js';
import {
  generateSessionToken,
  hashSessionToken,
  createSession,
  resolveSession,
  SESSION_DURATION_MS,
  SESSION_RENEW_THRESHOLD_MS,
} from '../../src/model/session.js';

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

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'contrasena-de-prueba-larga';

const noDb = (() => {
  throw new Error('no debería llamarse a la BD');
}) as unknown as TransactionSql;

async function newUser(tx: TransactionSql, email: string, rol: 'ADMIN' | 'SOCIO' | 'ALUMNO' = 'ALUMNO') {
  return createUser(tx, null, { email, password: PASSWORD, rol });
}

describe('model/session — constantes', () => {
  it('duración 30 días y umbral de renovación 15 días', () => {
    expect(SESSION_DURATION_MS).toBe(30 * DAY);
    expect(SESSION_RENEW_THRESHOLD_MS).toBe(15 * DAY);
  });
});

describe('model/session — token opaco', () => {
  it('son 32 bytes en base64url (43 caracteres, sin relleno)', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('no se repite', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSessionToken));
    expect(tokens.size).toBe(1000);
  });

  it('hashSessionToken es el SHA-256 en hex', () => {
    const token = generateSessionToken();
    const esperado = createHash('sha256').update(token).digest('hex');
    expect(hashSessionToken(token)).toBe(esperado);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('model/session — resolveSession sin BD', () => {
  it('devuelve null con un token mal formado sin consultar la BD', async () => {
    await expect(resolveSession(noDb, '')).resolves.toBeNull();
    await expect(resolveSession(noDb, 'corto')).resolves.toBeNull();
    await expect(resolveSession(noDb, 'x'.repeat(500))).resolves.toBeNull();
    await expect(resolveSession(noDb, '!'.repeat(43))).resolves.toBeNull();
  });
});

describe('model/session — integración Supabase', () => {
  it.runIf(hasDb)('createSession guarda solo el SHA-256 y caduca a los 30 días', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-1@example.com');
      const now = new Date('2026-01-01T00:00:00Z');
      const { token, expiresAt } = await createSession(tx, user.id, now);

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);

      const rows = await tx`select token_sha256, expires_at from "Session" where user_id = ${user.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_sha256).toBe(hashSessionToken(token));
      expect(JSON.stringify(rows)).not.toContain(token);
      expect((rows[0]!.expires_at as Date).getTime()).toBe(expiresAt.getTime());
    });
  });

  it.runIf(hasDb)('audita la creación sin el token ni su hash', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-2@example.com');
      const { token } = await createSession(tx, user.id);
      const rows = await tx`
        select id_usuario, operacion, datos_nuevos from "Audit_log" where tabla = 'Session'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id_usuario).toBe(user.id);
      expect(rows[0]!.operacion).toBe('INSERT');
      expect(rows[0]!.datos_nuevos).toMatchObject({ user_id: user.id });
      const texto = JSON.stringify(rows);
      expect(texto).not.toContain(token);
      expect(texto).not.toContain(hashSessionToken(token));
    });
  });

  it.runIf(hasDb)('resolveSession devuelve el Actor {id, rol} de una sesión válida', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-3@example.com', 'SOCIO');
      const { token, expiresAt } = await createSession(tx, user.id);
      const res = await resolveSession(tx, token);
      expect(res).not.toBeNull();
      expect(res!.actor).toEqual({ id: user.id, rol: 'SOCIO' });
      expect(res!.renewed).toBe(false);
      expect(res!.expiresAt.getTime()).toBe(expiresAt.getTime());
    });
  });

  it.runIf(hasDb)('resolveSession devuelve null con un token que no existe', async () => {
    await inRollback(async (tx) => {
      await expect(resolveSession(tx, generateSessionToken())).resolves.toBeNull();
    });
  });

  it.runIf(hasDb)('sesión caducada → null y se borra la fila', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-4@example.com');
      const now = new Date();
      const { token } = await createSession(tx, user.id, new Date(now.getTime() - 31 * DAY));

      await expect(resolveSession(tx, token, now)).resolves.toBeNull();
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from "Session" where user_id = ${user.id}`;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('usuario borrado → null y la sesión ya no existe', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-5@example.com');
      const { token } = await createSession(tx, user.id);
      await tx`delete from "User" where id = ${user.id}`;

      await expect(resolveSession(tx, token)).resolves.toBeNull();
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from "Session" where token_sha256 = ${hashSessionToken(token)}
      `;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('quedan menos de 15 días → se renueva a 30 días desde ahora', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-6@example.com');
      const now = new Date();
      // Creada hace 20 días → le quedan 10.
      const { token } = await createSession(tx, user.id, new Date(now.getTime() - 20 * DAY));

      const res = await resolveSession(tx, token, now);
      expect(res).not.toBeNull();
      expect(res!.renewed).toBe(true);
      expect(res!.expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);

      const [row] = await tx<{ expires_at: Date }[]>`
        select expires_at from "Session" where token_sha256 = ${hashSessionToken(token)}
      `;
      expect(row!.expires_at.getTime()).toBe(now.getTime() + 30 * DAY);
    });
  });

  it.runIf(hasDb)('quedan 15 días o más → no se renueva', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-7@example.com');
      const now = new Date();
      // Creada hace 10 días → le quedan 20.
      const created = new Date(now.getTime() - 10 * DAY);
      const { token, expiresAt } = await createSession(tx, user.id, created);

      const res = await resolveSession(tx, token, now);
      expect(res!.renewed).toBe(false);
      expect(res!.expiresAt.getTime()).toBe(expiresAt.getTime());
    });
  });

  it.runIf(hasDb)('la renovación y el borrado por caducidad quedan auditados', async () => {
    await inRollback(async (tx) => {
      const user = await newUser(tx, 'ses-8@example.com');
      const now = new Date();
      const renovable = await createSession(tx, user.id, new Date(now.getTime() - 20 * DAY));
      const caducada = await createSession(tx, user.id, new Date(now.getTime() - 31 * DAY));
      await resolveSession(tx, renovable.token, now);
      await resolveSession(tx, caducada.token, now);

      const rows = await tx<{ operacion: string }[]>`
        select operacion from "Audit_log" where tabla = 'Session' order by operacion
      `;
      expect(rows.map((r) => r.operacion)).toEqual(['DELETE', 'INSERT', 'INSERT', 'UPDATE']);
      const texto = JSON.stringify(await tx`select * from "Audit_log" where tabla = 'Session'`);
      expect(texto).not.toContain(hashSessionToken(renovable.token));
      expect(texto).not.toContain(hashSessionToken(caducada.token));
    });
  });
});

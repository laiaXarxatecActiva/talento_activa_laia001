import { describe, it, expect, vi } from 'vitest';
import { createDb, ping } from '../../src/model/db.js';

// ¿Hay credenciales reales? Los tests de integración solo corren si existe una
// DATABASE_URL de verdad (en .env). Una plantilla sin rellenar (con marcadores
// como <password>) o la ausencia de la variable se tratan como "no configurado"
// y los tests se omiten para no romper la suite.
const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

describe('model/db — configuración', () => {
  it('createDb lanza un error claro si la url es una cadena vacía', () => {
    expect(() => createDb('')).toThrow(/DATABASE_URL/);
  });

  it('createDb lanza si la url es solo espacios', () => {
    expect(() => createDb('   ')).toThrow(/DATABASE_URL/);
  });

  it('createDb lanza si no se pasa url y DATABASE_URL no está definida', () => {
    vi.stubEnv('DATABASE_URL', '');
    try {
      expect(() => createDb()).toThrow(/DATABASE_URL/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('model/db — conectividad real (Supabase)', () => {
  it.runIf(hasDb)('ping() conecta y devuelve true', async () => {
    const sql = createDb();
    try {
      await expect(ping(sql)).resolves.toBe(true);
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('la tabla "User" del seed existe en la BD', async () => {
    const sql = createDb();
    try {
      const rows = await sql<{ t: string | null }[]>`
        select to_regclass('public."User"')::text as t
      `;
      expect(rows[0]?.t).not.toBeNull();
    } finally {
      await sql.end();
    }
  });
});

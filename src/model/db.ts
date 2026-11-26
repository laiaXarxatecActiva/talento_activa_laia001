import postgres, { type Sql } from 'postgres';

/**
 * Crea un cliente de Postgres (Supabase) a partir de la cadena de conexión.
 *
 * El acceso real a datos va por el backend con conexión directa, que omite las
 * RLS de Supabase (ver CLAUDE.md). La frontera de seguridad es la capa de
 * aplicación, no la BD.
 *
 * @param url Cadena de conexión. Por defecto, `process.env.DATABASE_URL`.
 * @throws Si la cadena no está definida o está vacía.
 */
export function createDb(url: string | undefined = process.env.DATABASE_URL): Sql {
  if (!url || url.trim() === '') {
    throw new Error('DATABASE_URL no está definida');
  }

  return postgres(url, {
    // El pooler de Supabase (puerto 6543, PgBouncer en modo transacción) no
    // admite prepared statements: hay que desactivarlos.
    prepare: false,
    // Supabase exige TLS.
    ssl: 'require',
    max: 10,
  });
}

/**
 * Comprueba la conectividad ejecutando una consulta trivial.
 * @returns `true` si la BD responde correctamente.
 */
export async function ping(sql: Sql): Promise<boolean> {
  const rows = await sql<{ ok: number }[]>`select 1 as ok`;
  return rows[0]?.ok === 1;
}

import type { JSONValue, Sql, TransactionSql } from 'postgres';

/** Operaciones auditables (coinciden con el CHECK de `Audit_log.operacion`). */
export const AUDIT_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

export type AuditData = Record<string, unknown>;

export interface AuditEntry {
  /** Autor de la mutación; `null` si la genera el sistema. */
  idUsuario: string | null;
  tabla: string;
  idRegistro: string | null;
  operacion: AuditOperation;
  datosAnteriores?: AuditData | null;
  datosNuevos?: AuditData | null;
}

/**
 * Campos que NUNCA se auditan (invariante de seguridad, ver CLAUDE.md):
 * contraseña (en claro o hash) y tokens (en claro o su hash).
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(['password', 'password_hash', 'token', 'token_sha256']);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: AuditData = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SENSITIVE_KEYS.has(k)) out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/**
 * Devuelve una copia de `data` sin campos sensibles (recursivo, no muta el
 * original). `null`/`undefined` → `null`.
 */
export function sanitizeAuditData(data: AuditData | null | undefined): AuditData | null {
  if (data == null) return null;
  return strip(data) as AuditData;
}

/**
 * Escribe una entrada en `Audit_log` desde la capa de aplicación.
 * Acepta el cliente o una transacción, para auditar en la misma transacción
 * que la mutación.
 *
 * @returns el id de la fila de auditoría creada.
 */
export async function writeAudit(sql: Sql | TransactionSql, entry: AuditEntry): Promise<string> {
  if (!AUDIT_OPERATIONS.includes(entry.operacion)) {
    throw new Error(`Operación de auditoría no válida: ${String(entry.operacion)}`);
  }
  if (entry.tabla.trim() === '') {
    throw new Error('La tabla auditada es obligatoria');
  }

  const anteriores = sanitizeAuditData(entry.datosAnteriores);
  const nuevos = sanitizeAuditData(entry.datosNuevos);

  const [row] = await sql<{ id: string }[]>`
    insert into "Audit_log" (id_usuario, tabla, id_registro, operacion, datos_anteriores, datos_nuevos)
    values (
      ${entry.idUsuario},
      ${entry.tabla},
      ${entry.idRegistro},
      ${entry.operacion},
      ${anteriores === null ? null : sql.json(anteriores as JSONValue)},
      ${nuevos === null ? null : sql.json(nuevos as JSONValue)}
    )
    returning id
  `;
  if (!row) throw new Error('No se pudo escribir en Audit_log');
  return row.id;
}

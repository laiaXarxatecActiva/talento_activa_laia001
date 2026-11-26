import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { InvalidDataError, NotFoundError } from './errors.js';
import { intInRange, optionalIsoDate, requiredText } from './validation.js';

export interface Edition {
  id: string;
  nombre: string;
  anio: number;
  /** YYYY-MM-DD o null. */
  fecha_inicio: string | null;
  fecha_fin: string | null;
  estado: 'abierta' | 'cerrada';
}

// Las fechas se devuelven como texto YYYY-MM-DD (sin desfases de zona horaria).
const COLUMNS = (tx: TransactionSql) =>
  tx`id, nombre, anio, fecha_inicio::text as fecha_inicio, fecha_fin::text as fecha_fin, estado`;

export async function createEdition(tx: TransactionSql, actorId: string, input: Record<string, unknown>): Promise<Edition> {
  const nombre = requiredText(input.nombre, 200);
  const anio = intInRange(input.anio, 2000, 2100);
  const fechaInicio = optionalIsoDate(input.fecha_inicio);
  const fechaFin = optionalIsoDate(input.fecha_fin);
  if (fechaInicio && fechaFin && fechaFin < fechaInicio) throw new InvalidDataError();

  const [edition] = await tx<Edition[]>`
    insert into "Edition" (nombre, anio, fecha_inicio, fecha_fin)
    values (${nombre}, ${anio}, ${fechaInicio}, ${fechaFin})
    returning ${COLUMNS(tx)}
  `;
  if (!edition) throw new Error('No se pudo crear la edición');
  await writeAudit(tx, { idUsuario: actorId, tabla: 'Edition', idRegistro: edition.id, operacion: 'INSERT', datosNuevos: { ...edition } });
  return edition;
}

export async function listEditions(tx: TransactionSql): Promise<Edition[]> {
  return tx<Edition[]>`select ${COLUMNS(tx)} from "Edition" order by anio desc, nombre`;
}

export async function getEdition(tx: TransactionSql, id: string): Promise<Edition | null> {
  const [edition] = await tx<Edition[]>`select ${COLUMNS(tx)} from "Edition" where id = ${id}`;
  return edition ?? null;
}

/** Cierra la edición (idempotente: si ya estaba cerrada no cambia ni audita). */
export async function closeEdition(tx: TransactionSql, actorId: string, id: string): Promise<Edition> {
  const edition = await getEdition(tx, id);
  if (!edition) throw new NotFoundError();
  if (edition.estado === 'cerrada') return edition;

  await tx`update "Edition" set estado = 'cerrada' where id = ${id}`;
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Edition',
    idRegistro: id,
    operacion: 'UPDATE',
    datosAnteriores: { estado: 'abierta' },
    datosNuevos: { estado: 'cerrada' },
  });
  return { ...edition, estado: 'cerrada' };
}

import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { InvalidDataError } from './errors.js';
import { getEdition } from './edition.js';
import { inviteUser } from './user.js';
import { requiredText, uuid } from './validation.js';

export type StudentEstado = 'activo' | 'inactivo';

/** Vista del alumno para el panel de administración (incluye inactivos). */
export interface AdminStudentView {
  id: string;
  user_id: string;
  email: string;
  email_verified: boolean;
  nombre: string;
  edition_id: string;
  edition_nombre: string;
  estado: StudentEstado;
  consent_at: Date | null;
  filled_at: Date | null;
  created_at: Date;
}

const adminSelect = (tx: TransactionSql) => tx`
  select s.id, s.user_id, u.email, u.email_verified, s.nombre, s.edition_id, e.nombre as edition_nombre,
         s.estado, s.consent_at, s.filled_at, s.created_at
  from "Student" s
  join "User" u on u.id = s.user_id
  join "Edition" e on e.id = s.edition_id
`;

export async function getAdminStudent(tx: TransactionSql, id: string): Promise<AdminStudentView | null> {
  const [s] = await tx<AdminStudentView[]>`${adminSelect(tx)} where s.id = ${id}`;
  return s ?? null;
}

export async function listStudentsForAdmin(
  tx: TransactionSql,
  filter: { editionId?: string } = {},
): Promise<AdminStudentView[]> {
  const where = filter.editionId ? tx`where s.edition_id = ${filter.editionId}` : tx``;
  return tx<AdminStudentView[]>`${adminSelect(tx)} ${where} order by e.anio desc, s.nombre`;
}

/**
 * Alta de un alumno que ha FINALIZADO la formación: crea su usuario ALUMNO
 * (por invitación, sin verificar) y su ficha `Student` (inactiva hasta que dé
 * su consentimiento y se active).
 *
 * @throws InvalidDataError si el nombre, el email o la edición no son válidos.
 * @throws ConflictError si el email ya existe.
 */
export async function createStudentAccount(
  tx: TransactionSql,
  actorId: string,
  input: Record<string, unknown>,
): Promise<AdminStudentView> {
  const nombre = requiredText(input.nombre, 200);
  const editionId = uuid(input.edition_id);
  if (typeof input.email !== 'string') throw new InvalidDataError();
  if (!(await getEdition(tx, editionId))) throw new InvalidDataError();

  const user = await inviteUser(tx, actorId, { email: input.email, rol: 'ALUMNO' });
  const [row] = await tx<{ id: string }[]>`
    insert into "Student" (user_id, edition_id, nombre)
    values (${user.id}, ${editionId}, ${nombre})
    returning id
  `;
  if (!row) throw new Error('No se pudo crear la ficha del alumno');
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Student',
    idRegistro: row.id,
    operacion: 'INSERT',
    datosNuevos: { user_id: user.id, edition_id: editionId, nombre },
  });

  const student = await getAdminStudent(tx, row.id);
  if (!student) throw new Error('No se pudo leer la ficha del alumno');
  return student;
}

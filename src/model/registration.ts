import type { TransactionSql } from 'postgres';
import { getCompany, inviteCompanyUser } from './company.js';
import { InvalidDataError } from './errors.js';
import { createStudentAccount } from './student.js';
import { getPublicUser, type PublicUser } from './user.js';
import { isUuid } from './validation.js';

/**
 * Alta por invitación desde `POST /api/auth/register`. Es una fachada de los
 * flujos canónicos para que no existan cuentas incoherentes:
 * - SOCIO: exige `company_id` de una empresa existente y lo vincula a ella.
 * - ALUMNO: exige `edition_id` y `nombre`; crea también su ficha Student.
 * (ADMIN no se puede crear por la API: el staff va aparte.)
 *
 * @throws InvalidDataError si faltan datos o las referencias no existen.
 * @throws ConflictError si el email ya existe.
 */
export async function registerInvitedAccount(
  tx: TransactionSql,
  actorId: string,
  body: Record<string, unknown>,
): Promise<PublicUser> {
  if (typeof body.email !== 'string') throw new InvalidDataError();

  if (body.rol === 'SOCIO') {
    if (!isUuid(body.company_id) || !(await getCompany(tx, body.company_id))) throw new InvalidDataError();
    const { user } = await inviteCompanyUser(tx, actorId, body.company_id, body.email);
    return user;
  }

  if (body.rol === 'ALUMNO') {
    const student = await createStudentAccount(tx, actorId, {
      email: body.email,
      nombre: body.nombre,
      edition_id: body.edition_id,
    });
    const user = await getPublicUser(tx, student.user_id);
    if (!user) throw new Error('No se pudo leer el usuario creado');
    return user;
  }

  throw new InvalidDataError();
}

import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { InvalidDataError, NotFoundError } from './errors.js';
import { inviteUser, type PublicUser } from './user.js';
import { boolean, optionalText, requiredText } from './validation.js';

export interface CompanyView {
  id: string;
  nombre: string;
  es_socia: boolean;
  contacto: string | null;
  /** Emails de los usuarios SOCIO vinculados. */
  usuarios: string[];
}

const companySelect = (tx: TransactionSql) => tx`
  select c.id, c.nombre, c.es_socia, c.contacto,
         coalesce(array_agg(u.email order by u.email) filter (where u.id is not null), '{}') as usuarios
  from "Company" c
  left join "Company_user_rel" r on r.company_id = c.id
  left join "User" u on u.id = r.user_id
`;

export async function getCompany(tx: TransactionSql, id: string): Promise<CompanyView | null> {
  const [c] = await tx<CompanyView[]>`${companySelect(tx)} where c.id = ${id} group by c.id`;
  return c ?? null;
}

export async function listCompanies(tx: TransactionSql): Promise<CompanyView[]> {
  return tx<CompanyView[]>`${companySelect(tx)} group by c.id order by c.nombre`;
}

/** Invita a un usuario SOCIO y lo vincula a la empresa. */
async function addCompanyUser(tx: TransactionSql, actorId: string, companyId: string, email: unknown): Promise<PublicUser> {
  if (typeof email !== 'string') throw new InvalidDataError();
  const user = await inviteUser(tx, actorId, { email, rol: 'SOCIO' });
  await tx`insert into "Company_user_rel" (company_id, user_id) values (${companyId}, ${user.id})`;
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Company_user_rel',
    // Tabla puente: id_registro = el usuario vinculado (único por fila).
    idRegistro: user.id,
    operacion: 'INSERT',
    datosNuevos: { company_id: companyId, user_id: user.id },
  });
  return user;
}

/**
 * Alta de empresa por invitación: crea la Company y su primer usuario SOCIO.
 * @returns la empresa y el usuario creado (para enviarle la invitación).
 */
export async function createCompany(
  tx: TransactionSql,
  actorId: string,
  input: Record<string, unknown>,
): Promise<{ company: CompanyView; user: PublicUser }> {
  const nombre = requiredText(input.nombre, 200);
  const contacto = optionalText(input.contacto, 500);
  const esSocia = input.es_socia === undefined ? false : boolean(input.es_socia);
  if (typeof input.email !== 'string') throw new InvalidDataError();

  const [row] = await tx<{ id: string }[]>`
    insert into "Company" (nombre, es_socia, contacto, created_by)
    values (${nombre}, ${esSocia}, ${contacto}, ${actorId})
    returning id
  `;
  if (!row) throw new Error('No se pudo crear la empresa');
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Company',
    idRegistro: row.id,
    operacion: 'INSERT',
    datosNuevos: { nombre, es_socia: esSocia, contacto },
  });

  const user = await addCompanyUser(tx, actorId, row.id, input.email);
  const company = await getCompany(tx, row.id);
  if (!company) throw new Error('No se pudo leer la empresa');
  return { company, user };
}

/** Invita a otro usuario SOCIO a una empresa existente. */
export async function inviteCompanyUser(
  tx: TransactionSql,
  actorId: string,
  companyId: string,
  email: unknown,
): Promise<{ company: CompanyView; user: PublicUser }> {
  if (!(await getCompany(tx, companyId))) throw new NotFoundError();
  const user = await addCompanyUser(tx, actorId, companyId, email);
  const company = (await getCompany(tx, companyId))!;
  return { company, user };
}

/** Marca o desmarca la empresa como socia (auditado). */
export async function setCompanySocia(
  tx: TransactionSql,
  actorId: string,
  companyId: string,
  esSociaInput: unknown,
): Promise<CompanyView> {
  const esSocia = boolean(esSociaInput);
  const current = await getCompany(tx, companyId);
  if (!current) throw new NotFoundError();
  if (current.es_socia === esSocia) return current;

  await tx`update "Company" set es_socia = ${esSocia} where id = ${companyId}`;
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Company',
    idRegistro: companyId,
    operacion: 'UPDATE',
    datosAnteriores: { es_socia: current.es_socia },
    datosNuevos: { es_socia: esSocia },
  });
  return { ...current, es_socia: esSocia };
}

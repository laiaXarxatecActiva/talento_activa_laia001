import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { InvalidDataError, NotFoundError } from './errors.js';
import { getEdition } from './edition.js';
import { inviteUser } from './user.js';
import { boolean, optionalEnum, optionalHttpUrl, optionalText, requiredText, uuid } from './validation.js';

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

// ============================================================================
// Ficha del alumno (T15) y visibilidad según quién mira.
// ============================================================================

export const MODALIDADES = ['remoto', 'presencial', 'hibrido'] as const;
export const ESTADOS_LABORALES = ['buscando', 'trabajando'] as const;

/**
 * Campos cuya visibilidad para empresas controla el alumno en `privacy`.
 * Privacidad por defecto (opt-in): solo se muestran si `privacy[campo] === true`.
 * `nombre` y la edición se muestran siempre que el perfil sea consultable.
 */
export const PRIVACY_FIELDS = [
  'email',
  'foto_url',
  'bio',
  'ubicacion',
  'disponibilidad_traslado',
  'modalidad',
  'estado_laboral',
  'cv_url',
  'linkedin',
  'github',
] as const;
export type PrivacyField = (typeof PRIVACY_FIELDS)[number];
export type Privacy = Partial<Record<PrivacyField, boolean>>;

export interface SkillItem {
  id: string;
  nombre: string;
  nivel: string | null;
}
export type LanguageItem = SkillItem;
export interface ProjectItem {
  id: string;
  titulo: string;
  descripcion: string | null;
  url: string;
  thumbnail_url: string | null;
  created_at: Date;
}

/** Ficha completa (la ve el propio alumno y el ADMIN). */
export interface StudentFicha {
  id: string;
  user_id: string;
  email: string;
  nombre: string;
  edition: { id: string; nombre: string; anio: number };
  foto_url: string | null;
  bio: string | null;
  ubicacion: string | null;
  disponibilidad_traslado: boolean;
  modalidad: (typeof MODALIDADES)[number] | null;
  estado_laboral: (typeof ESTADOS_LABORALES)[number] | null;
  cv_url: string | null;
  linkedin: string | null;
  github: string | null;
  consent_at: Date | null;
  estado: StudentEstado;
  privacy: Privacy;
  filled_at: Date | null;
  created_at: Date;
  skills: SkillItem[];
  languages: LanguageItem[];
  projects: ProjectItem[];
}

/** Lo que ve una empresa: identidad básica + campos visibles + skills/idiomas/proyectos. */
export type PublicStudent = { id: string; nombre: string; edition: StudentFicha['edition'] } & Partial<
  Pick<StudentFicha, PrivacyField>
> &
  Pick<StudentFicha, 'skills' | 'languages' | 'projects'>;

type StudentRow = Omit<StudentFicha, 'edition' | 'skills' | 'languages' | 'projects'> & {
  edition_id: string;
  edition_nombre: string;
  edition_anio: number;
};

async function loadFicha(tx: TransactionSql, where: ReturnType<TransactionSql>): Promise<StudentFicha | null> {
  const [row] = await tx<StudentRow[]>`
    select s.id, s.user_id, u.email, s.nombre,
           e.id as edition_id, e.nombre as edition_nombre, e.anio as edition_anio,
           s.foto_url, s.bio, s.ubicacion, s.disponibilidad_traslado, s.modalidad, s.estado_laboral,
           s.cv_url, s.linkedin, s.github, s.consent_at, s.estado, s.privacy, s.filled_at, s.created_at
    from "Student" s
    join "User" u on u.id = s.user_id
    join "Edition" e on e.id = s.edition_id
    ${where}
  `;
  if (!row) return null;
  const { edition_id, edition_nombre, edition_anio, ...rest } = row;

  const skills = await tx<SkillItem[]>`
    select k.id, k.nombre, r.nivel from "Skill_student_rel" r join "Skill" k on k.id = r.skill_id
    where r.student_id = ${row.id} order by k.nombre`;
  const languages = await tx<LanguageItem[]>`
    select l.id, l.nombre, r.nivel from "Language_student_rel" r join "Language" l on l.id = r.language_id
    where r.student_id = ${row.id} order by l.nombre`;
  const projects = await tx<ProjectItem[]>`
    select id, titulo, descripcion, url, thumbnail_url, created_at from "Project"
    where student_id = ${row.id} order by created_at desc, titulo`;

  return {
    ...rest,
    edition: { id: edition_id, nombre: edition_nombre, anio: edition_anio },
    skills: [...skills],
    languages: [...languages],
    projects: [...projects],
  };
}

export function getStudentFicha(tx: TransactionSql, id: string): Promise<StudentFicha | null> {
  return loadFicha(tx, tx`where s.id = ${id}`);
}

export function getStudentFichaByUser(tx: TransactionSql, userId: string): Promise<StudentFicha | null> {
  return loadFicha(tx, tx`where s.user_id = ${userId}`);
}

/** ¿Lo puede consultar una empresa? Solo activo y con consentimiento. */
export function isPubliclyVisible(f: Pick<StudentFicha, 'estado' | 'consent_at'>): boolean {
  return f.estado === 'activo' && f.consent_at !== null;
}

/** Proyección para empresas, aplicando la privacidad por campo. */
export function toPublicStudent(f: StudentFicha): PublicStudent {
  const out: PublicStudent = {
    id: f.id,
    nombre: f.nombre,
    edition: f.edition,
    skills: f.skills,
    languages: f.languages,
    projects: f.projects,
  };
  for (const field of PRIVACY_FIELDS) {
    if (f.privacy[field] === true) (out as Record<string, unknown>)[field] = f[field];
  }
  return out;
}

/**
 * Ficha según quién mira (enforcement de privacidad en la capa de aplicación):
 * - ADMIN: completa (incluidos inactivos).
 * - ALUMNO: solo la suya, completa.
 * - SOCIO: solo si es consultable (activo + consentimiento), proyección pública.
 * En cualquier otro caso, NotFoundError (no se revela si existe).
 */
export async function getStudentForViewer(
  tx: TransactionSql,
  actor: { id: string; rol: string },
  id: string,
): Promise<StudentFicha | PublicStudent> {
  const ficha = await getStudentFicha(tx, id);
  if (!ficha) throw new NotFoundError();
  if (actor.rol === 'ADMIN') return ficha;
  if (actor.rol === 'ALUMNO') {
    if (ficha.user_id !== actor.id) throw new NotFoundError();
    return ficha;
  }
  if (!isPubliclyVisible(ficha)) throw new NotFoundError();
  return toPublicStudent(ficha);
}

const EDITABLE_VALIDATORS: Record<string, (v: unknown) => unknown> = {
  nombre: (v) => requiredText(v, 200),
  foto_url: optionalHttpUrl,
  bio: (v) => optionalText(v, 2000),
  ubicacion: (v) => optionalText(v, 200),
  disponibilidad_traslado: boolean,
  modalidad: (v) => optionalEnum(v, MODALIDADES),
  estado_laboral: (v) => optionalEnum(v, ESTADOS_LABORALES),
  cv_url: optionalHttpUrl,
  linkedin: optionalHttpUrl,
  github: optionalHttpUrl,
};

function validatePrivacy(v: unknown): Privacy {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InvalidDataError();
  const out: Privacy = {};
  for (const [k, val] of Object.entries(v)) {
    if (!(PRIVACY_FIELDS as readonly string[]).includes(k) || typeof val !== 'boolean') throw new InvalidDataError();
    out[k as PrivacyField] = val;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/**
 * El alumno edita su ficha (actualización parcial). Campos no editables o
 * desconocidos → InvalidDataError. `consent: false` retira el consentimiento e
 * inactiva el perfil. Audita solo lo que cambia.
 */
export async function updateOwnStudent(
  tx: TransactionSql,
  actorId: string,
  input: Record<string, unknown>,
  now: Date = new Date(),
): Promise<StudentFicha> {
  const current = await getStudentFichaByUser(tx, actorId);
  if (!current) throw new NotFoundError();

  // 1) Validar TODO antes de tocar nada.
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const validate = EDITABLE_VALIDATORS[key];
    if (validate) next[key] = validate(value);
    else if (key === 'privacy') next.privacy = { ...current.privacy, ...validatePrivacy(value) };
    else if (key === 'consent') {
      if (boolean(value)) {
        if (current.consent_at === null) next.consent_at = now;
      } else {
        next.consent_at = null;
        next.estado = 'inactivo';
      }
    } else throw new InvalidDataError();
  }
  if (current.filled_at === null && Object.keys(input).length > 0) next.filled_at = now;

  // 2) Quedarse con lo que realmente cambia.
  const antes: Record<string, unknown> = {};
  const despues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    const prev = (current as unknown as Record<string, unknown>)[key];
    if (!sameValue(prev, value)) {
      antes[key] = prev;
      despues[key] = value;
    }
  }
  if (Object.keys(despues).length === 0) return current;

  const set: Record<string, unknown> = { ...despues };
  if (set.privacy) set.privacy = tx.json(set.privacy as Privacy);
  await tx`update "Student" set ${tx(set as Record<string, string>)} where id = ${current.id}`;
  await writeAudit(tx, {
    idUsuario: actorId,
    tabla: 'Student',
    idRegistro: current.id,
    operacion: 'UPDATE',
    datosAnteriores: antes,
    datosNuevos: despues,
  });

  return (await getStudentFicha(tx, current.id))!;
}

import { randomBytes } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { InvalidDataError, NotFoundError } from './errors.js';
import { detectImageType, IMAGE_EXTENSIONS, type ImageType } from './storage.js';
import type { ProjectItem } from './student.js';
import { httpUrl, optionalText, requiredText } from './validation.js';

const FIELDS: Record<string, (v: unknown) => unknown> = {
  titulo: (v) => requiredText(v, 200),
  descripcion: (v) => optionalText(v, 2000),
  url: httpUrl,
};

function validate(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const fn = FIELDS[k];
    if (!fn) throw new InvalidDataError(); // p. ej. thumbnail_url: solo por subida
    out[k] = fn(v);
  }
  return out;
}

async function ownStudentId(tx: TransactionSql, userId: string): Promise<string> {
  const [s] = await tx<{ id: string }[]>`select id from "Student" where user_id = ${userId}`;
  if (!s) throw new NotFoundError();
  return s.id;
}

async function ownProject(tx: TransactionSql, userId: string, projectId: string): Promise<ProjectItem & { student_id: string }> {
  const [p] = await tx<(ProjectItem & { student_id: string })[]>`
    select p.id, p.student_id, p.titulo, p.descripcion, p.url, p.thumbnail_url, p.created_at
    from "Project" p join "Student" s on s.id = p.student_id
    where p.id = ${projectId} and s.user_id = ${userId}
    for update of p`;
  if (!p) throw new NotFoundError();
  return p;
}

const strip = ({ student_id: _s, ...p }: ProjectItem & { student_id: string }): ProjectItem => p;

export async function listOwnProjects(tx: TransactionSql, userId: string): Promise<ProjectItem[]> {
  const studentId = await ownStudentId(tx, userId);
  return tx<ProjectItem[]>`
    select id, titulo, descripcion, url, thumbnail_url, created_at from "Project"
    where student_id = ${studentId} order by created_at desc, titulo`;
}

export async function createOwnProject(tx: TransactionSql, userId: string, input: Record<string, unknown>): Promise<ProjectItem> {
  const studentId = await ownStudentId(tx, userId);
  const data = validate(input);
  if (data.titulo === undefined || data.url === undefined) throw new InvalidDataError();
  const [p] = await tx<ProjectItem[]>`
    insert into "Project" (student_id, titulo, descripcion, url)
    values (${studentId}, ${data.titulo as string}, ${(data.descripcion as string | null) ?? null}, ${data.url as string})
    returning id, titulo, descripcion, url, thumbnail_url, created_at`;
  if (!p) throw new Error('No se pudo crear el proyecto');
  await writeAudit(tx, {
    idUsuario: userId,
    tabla: 'Project',
    idRegistro: p.id,
    operacion: 'INSERT',
    datosNuevos: { student_id: studentId, titulo: p.titulo, descripcion: p.descripcion, url: p.url },
  });
  return p;
}

export async function updateOwnProject(
  tx: TransactionSql,
  userId: string,
  projectId: string,
  input: Record<string, unknown>,
): Promise<ProjectItem> {
  const current = await ownProject(tx, userId, projectId);
  const data = validate(input);
  const antes: Record<string, unknown> = {};
  const despues: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const prev = (current as unknown as Record<string, unknown>)[k];
    if (prev !== v) {
      antes[k] = prev;
      despues[k] = v;
    }
  }
  if (Object.keys(despues).length === 0) return strip(current);
  await tx`update "Project" set ${tx(despues as Record<string, string>)} where id = ${projectId}`;
  await writeAudit(tx, {
    idUsuario: userId,
    tabla: 'Project',
    idRegistro: projectId,
    operacion: 'UPDATE',
    datosAnteriores: { student_id: current.student_id, ...antes },
    datosNuevos: { student_id: current.student_id, ...despues },
  });
  return strip({ ...current, ...(despues as Partial<ProjectItem>) });
}

/** Borra el proyecto. @returns la URL de su miniatura (para borrarla de Storage). */
export async function deleteOwnProject(tx: TransactionSql, userId: string, projectId: string): Promise<string | null> {
  const current = await ownProject(tx, userId, projectId);
  await tx`delete from "Project" where id = ${projectId}`;
  await writeAudit(tx, {
    idUsuario: userId,
    tabla: 'Project',
    idRegistro: projectId,
    operacion: 'DELETE',
    datosAnteriores: { student_id: current.student_id, titulo: current.titulo, url: current.url },
  });
  return current.thumbnail_url;
}

/** Comprueba que el proyecto es del alumno (antes de subir nada). */
export async function assertOwnProject(tx: TransactionSql, userId: string, projectId: string): Promise<void> {
  await ownProject(tx, userId, projectId);
}

/** Fija la miniatura. @returns el proyecto y la URL anterior (para borrarla). */
export async function setProjectThumbnail(
  tx: TransactionSql,
  userId: string,
  projectId: string,
  thumbnailUrl: string,
): Promise<{ project: ProjectItem; previous: string | null }> {
  const current = await ownProject(tx, userId, projectId);
  await tx`update "Project" set thumbnail_url = ${thumbnailUrl} where id = ${projectId}`;
  await writeAudit(tx, {
    idUsuario: userId,
    tabla: 'Project',
    idRegistro: projectId,
    operacion: 'UPDATE',
    datosAnteriores: { student_id: current.student_id, thumbnail_url: current.thumbnail_url },
    datosNuevos: { student_id: current.student_id, thumbnail_url: thumbnailUrl },
  });
  return { project: strip({ ...current, thumbnail_url: thumbnailUrl }), previous: current.thumbnail_url };
}

/** Tamaño máximo de una miniatura (subida manual). */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * Reglas de negocio de la miniatura: PNG/JPEG/WebP (por magic bytes, sin fiarse
 * de la cabecera), no vacía y ≤ 2 MB. Devuelve el tipo y una ruta única.
 * @throws InvalidDataError si no cumple.
 */
export function prepareThumbnail(bytes: Uint8Array, projectId: string): { type: ImageType; path: string } {
  const type = detectImageType(bytes);
  if (!type || bytes.byteLength > MAX_THUMBNAIL_BYTES) throw new InvalidDataError();
  return { type, path: `thumbnails/${projectId}-${randomBytes(8).toString('base64url')}.${IMAGE_EXTENSIONS[type]}` };
}

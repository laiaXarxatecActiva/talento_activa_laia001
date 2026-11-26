import type { TransactionSql } from 'postgres';
import { writeAudit } from './audit.js';
import { ConflictError, InvalidDataError, NotFoundError } from './errors.js';
import type { SkillItem } from './student.js';
import { isUuid, requiredText } from './validation.js';

/** Configuración de un catálogo N:M con nivel (skills o idiomas). */
interface CatalogConfig {
  table: 'Skill' | 'Language';
  rel: 'Skill_student_rel' | 'Language_student_rel';
  fk: 'skill_id' | 'language_id';
  /** Clave de la lista en el cuerpo de la petición. */
  listKey: 'skills' | 'languages';
  niveles: readonly string[];
}

export const SKILLS: CatalogConfig = {
  table: 'Skill',
  rel: 'Skill_student_rel',
  fk: 'skill_id',
  listKey: 'skills',
  niveles: ['basico', 'medio', 'avanzado'],
};

export const LANGUAGES: CatalogConfig = {
  table: 'Language',
  rel: 'Language_student_rel',
  fk: 'language_id',
  listKey: 'languages',
  niveles: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'nativo'],
};

const MAX_ITEMS = 50;

export async function listCatalog(tx: TransactionSql, cfg: CatalogConfig): Promise<Array<{ id: string; nombre: string }>> {
  return tx<{ id: string; nombre: string }[]>`select id, nombre from ${tx(cfg.table)} order by nombre`;
}

/** El ADMIN añade una entrada al catálogo (auditado). Repetida → ConflictError. */
export async function addCatalogEntry(
  tx: TransactionSql,
  cfg: CatalogConfig,
  actorId: string,
  nombreInput: unknown,
): Promise<{ id: string; nombre: string }> {
  const nombre = requiredText(nombreInput, 100);
  try {
    return await tx.savepoint(async (sp) => {
      const [row] = await sp<{ id: string; nombre: string }[]>`
        insert into ${sp(cfg.table)} (nombre) values (${nombre}) returning id, nombre`;
      await writeAudit(sp, { idUsuario: actorId, tabla: cfg.table, idRegistro: row!.id, operacion: 'INSERT', datosNuevos: { nombre } });
      return row!;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError('Ya existe en el catálogo');
    throw e;
  }
}

async function studentItems(tx: TransactionSql, cfg: CatalogConfig, studentId: string): Promise<SkillItem[]> {
  return tx<SkillItem[]>`
    select c.id, c.nombre, r.nivel from ${tx(cfg.rel)} r join ${tx(cfg.table)} c on c.id = r.${tx(cfg.fk)}
    where r.student_id = ${studentId} order by c.nombre`;
}

/**
 * Sustituye el conjunto de skills/idiomas del alumno (con nivel). Valida todo
 * antes de escribir; audita el conjunto anterior y el nuevo.
 */
export async function replaceStudentItems(
  tx: TransactionSql,
  cfg: CatalogConfig,
  userId: string,
  body: Record<string, unknown>,
): Promise<SkillItem[]> {
  const [student] = await tx<{ id: string }[]>`select id from "Student" where user_id = ${userId}`;
  if (!student) throw new NotFoundError();

  const list = body[cfg.listKey];
  if (!Array.isArray(list) || list.length > MAX_ITEMS) throw new InvalidDataError();
  const items: Array<{ id: string; nivel: string }> = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (typeof it !== 'object' || it === null) throw new InvalidDataError();
    const { [cfg.fk]: id, nivel } = it as Record<string, unknown>;
    if (!isUuid(id) || typeof nivel !== 'string' || !cfg.niveles.includes(nivel) || seen.has(id)) {
      throw new InvalidDataError();
    }
    seen.add(id);
    items.push({ id, nivel });
  }
  if (items.length > 0) {
    const [found] = await tx<{ n: number }[]>`
      select count(*)::int as n from ${tx(cfg.table)} where id in ${tx(items.map((i) => i.id))}`;
    if (found!.n !== items.length) throw new InvalidDataError();
  }

  const antes = await studentItems(tx, cfg, student.id);
  await tx`delete from ${tx(cfg.rel)} where student_id = ${student.id}`;
  for (const it of items) {
    await tx`
      insert into ${tx(cfg.rel)} (${tx(cfg.fk)}, student_id, nivel) values (${it.id}, ${student.id}, ${it.nivel})`;
  }
  const despues = await studentItems(tx, cfg, student.id);

  await writeAudit(tx, {
    idUsuario: userId,
    tabla: cfg.rel,
    idRegistro: student.id,
    operacion: 'UPDATE',
    datosAnteriores: { student_id: student.id, [cfg.listKey]: antes.map(({ id, nivel }) => ({ id, nivel })) },
    datosNuevos: { student_id: student.id, [cfg.listKey]: despues.map(({ id, nivel }) => ({ id, nivel })) },
  });
  return [...despues];
}

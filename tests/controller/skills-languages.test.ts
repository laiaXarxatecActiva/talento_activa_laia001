import { describe, it, expect } from 'vitest';
import type { TransactionSql } from 'postgres';
import { hasDb, withApp, loginAs, alumnoConFicha, call } from '../helpers/db.js';

async function ids(tx: TransactionSql, tabla: 'Skill' | 'Language', ...nombres: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of nombres) {
    const [row] =
      tabla === 'Skill'
        ? await tx<{ id: string }[]>`select id from "Skill" where nombre = ${n}`
        : await tx<{ id: string }[]>`select id from "Language" where nombre = ${n}`;
    if (!row) throw new Error(`No existe ${tabla} ${n} (¿se ejecutó el seed?)`);
    out.push(row.id);
  }
  return out;
}

describe('Catálogos de skills e idiomas (integración Supabase)', () => {
  it.runIf(hasDb)('cualquier usuario con sesión ve los catálogos del seed', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'SOCIO');
      const s = await call(app, 'GET', '/api/skills', { cookie });
      expect(s.status).toBe(200);
      const { skills } = (await s.json()) as { skills: Array<{ id: string; nombre: string }> };
      expect(skills.map((k) => k.nombre)).toEqual(expect.arrayContaining(['TypeScript', 'Node.js', 'SQL']));

      const l = await call(app, 'GET', '/api/languages', { cookie });
      const { languages } = (await l.json()) as { languages: Array<{ nombre: string }> };
      expect(languages.map((k) => k.nombre)).toEqual(expect.arrayContaining(['Español', 'Catalán', 'Inglés']));
    });
  });

  it('sin sesión → 401', async () => {
    const { appSinBd } = await import('../helpers/db.js');
    expect((await call(appSinBd(), 'GET', '/api/skills')).status).toBe(401);
  });

  it.runIf(hasDb)('el ADMIN amplía el catálogo (auditado); repetido → 409; otros → 403', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/skills', { cookie, body: { nombre: '  Rust  ' } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ skill: { nombre: 'Rust' } });
      expect((await call(app, 'POST', '/api/admin/skills', { cookie, body: { nombre: 'Rust' } })).status).toBe(409);
      expect((await call(app, 'POST', '/api/admin/skills', { cookie, body: { nombre: '' } })).status).toBe(400);

      const lang = await call(app, 'POST', '/api/admin/languages', { cookie, body: { nombre: 'Euskera' } });
      expect(lang.status).toBe(201);

      const audit = await tx<{ tabla: string }[]>`select tabla from "Audit_log" where tabla in ('Skill', 'Language')`;
      expect(audit.map((a) => a.tabla).sort()).toEqual(['Language', 'Skill']);

      const socio = await loginAs(tx, 'SOCIO');
      expect((await call(app, 'POST', '/api/admin/skills', { cookie: socio.cookie, body: { nombre: 'Go' } })).status).toBe(403);
    });
  });
});

describe('PUT /api/students/me/skills y /languages (integración Supabase)', () => {
  it.runIf(hasDb)('sustituye el conjunto de skills con su nivel y aparece en la ficha', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie, user, studentId } = await alumnoConFicha(tx);
      const [ts, sql, git] = await ids(tx, 'Skill', 'TypeScript', 'SQL', 'Git');

      const r1 = await call(app, 'PUT', '/api/students/me/skills', {
        cookie,
        body: { skills: [{ skill_id: ts, nivel: 'avanzado' }, { skill_id: sql, nivel: 'medio' }] },
      });
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({
        skills: [
          { id: sql, nombre: 'SQL', nivel: 'medio' },
          { id: ts, nombre: 'TypeScript', nivel: 'avanzado' },
        ],
      });

      // Sustituye (no acumula).
      await call(app, 'PUT', '/api/students/me/skills', { cookie, body: { skills: [{ skill_id: git, nivel: 'basico' }] } });
      const me = await call(app, 'GET', '/api/students/me', { cookie });
      expect(await me.json()).toMatchObject({ student: { skills: [{ nombre: 'Git', nivel: 'basico' }] } });

      // Vaciar.
      const vacio = await call(app, 'PUT', '/api/students/me/skills', { cookie, body: { skills: [] } });
      expect(await vacio.json()).toEqual({ skills: [] });

      const rows = await tx<{ id_usuario: string; id_registro: string }[]>`
        select id_usuario, id_registro from "Audit_log" where tabla = 'Skill_student_rel'`;
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.id_usuario === user.id && r.id_registro === studentId)).toBe(true);
    });
  });

  it.runIf(hasDb)('idiomas con nivel MCER o nativo', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const [es, en] = await ids(tx, 'Language', 'Español', 'Inglés');
      const res = await call(app, 'PUT', '/api/students/me/languages', {
        cookie,
        body: { languages: [{ language_id: es, nivel: 'nativo' }, { language_id: en, nivel: 'B2' }] },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        languages: [
          { id: es, nombre: 'Español', nivel: 'nativo' },
          { id: en, nombre: 'Inglés', nivel: 'B2' },
        ],
      });
    });
  });

  it.runIf(hasDb)('datos no válidos → 400 y no cambia nada', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const [ts] = await ids(tx, 'Skill', 'TypeScript');
      const [es] = await ids(tx, 'Language', 'Español');
      const malos: Array<[string, unknown]> = [
        ['/api/students/me/skills', { skills: [{ skill_id: ts, nivel: 'experto' }] }],
        ['/api/students/me/skills', { skills: [{ skill_id: ts }] }],
        ['/api/students/me/skills', { skills: [{ skill_id: '00000000-0000-4000-8000-000000000999', nivel: 'medio' }] }],
        ['/api/students/me/skills', { skills: [{ skill_id: ts, nivel: 'medio' }, { skill_id: ts, nivel: 'basico' }] }],
        ['/api/students/me/skills', { skills: 'TypeScript' }],
        ['/api/students/me/skills', {}],
        ['/api/students/me/languages', { languages: [{ language_id: es, nivel: 'D1' }] }],
        ['/api/students/me/languages', { languages: [{ language_id: 'nope', nivel: 'B2' }] }],
      ];
      for (const [path, body] of malos) {
        const res = await call(app, 'PUT', path, { cookie, body });
        expect({ path, body, status: res.status }).toEqual({ path, body, status: 400 });
      }
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from "Audit_log" where tabla like '%_student_rel'`;
      expect(n!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('la empresa ve skills e idiomas de un perfil visible', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { publicado: true });
      const [ts] = await ids(tx, 'Skill', 'TypeScript');
      const [en] = await ids(tx, 'Language', 'Inglés');
      await call(app, 'PUT', '/api/students/me/skills', { cookie: alumna.cookie, body: { skills: [{ skill_id: ts, nivel: 'medio' }] } });
      await call(app, 'PUT', '/api/students/me/languages', {
        cookie: alumna.cookie,
        body: { languages: [{ language_id: en, nivel: 'C1' }] },
      });
      const socio = await loginAs(tx, 'SOCIO');
      const res = await call(app, 'GET', `/api/students/${alumna.studentId}`, { cookie: socio.cookie });
      expect(await res.json()).toMatchObject({
        student: { skills: [{ nombre: 'TypeScript', nivel: 'medio' }], languages: [{ nombre: 'Inglés', nivel: 'C1' }] },
      });
    });
  });

  it.runIf(hasDb)('solo ALUMNO con ficha', async () => {
    await withApp(async ({ app, tx }) => {
      const socio = await loginAs(tx, 'SOCIO');
      expect((await call(app, 'PUT', '/api/students/me/skills', { cookie: socio.cookie, body: { skills: [] } })).status).toBe(403);
      const sinFicha = await loginAs(tx, 'ALUMNO');
      expect((await call(app, 'PUT', '/api/students/me/skills', { cookie: sinFicha.cookie, body: { skills: [] } })).status).toBe(404);
    });
  });
});

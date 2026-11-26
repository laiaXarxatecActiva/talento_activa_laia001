import { describe, it, expect } from 'vitest';
import type { TransactionSql } from 'postgres';
import { hasDb, withApp, loginAs, alumnoConFicha, call } from '../helpers/db.js';

/** Llena la ficha con datos en todas las tablas dependientes. */
async function conDatos(tx: TransactionSql, studentId: string) {
  await tx`insert into "Project" (student_id, titulo, url) values (${studentId}, 'Mi proyecto', 'https://github.com/x/y')`;
  const [skill] = await tx<{ id: string }[]>`select id from "Skill" order by nombre limit 1`;
  await tx`insert into "Skill_student_rel" (skill_id, student_id, nivel) values (${skill!.id}, ${studentId}, 'medio')`;
  const [lang] = await tx<{ id: string }[]>`select id from "Language" order by nombre limit 1`;
  await tx`insert into "Language_student_rel" (language_id, student_id, nivel) values (${lang!.id}, ${studentId}, 'B2')`;
  const [company] = await tx<{ id: string }[]>`insert into "Company" (nombre) values ('Bookmarker') returning id`;
  await tx`insert into "Company_student_rel" (company_id, student_id) values (${company!.id}, ${studentId})`;
  await tx`insert into "Reminder_state" (student_id) values (${studentId})`;
}

async function cuenta(tx: TransactionSql, userId: string, studentId: string) {
  const [r] = await tx<Record<string, number>[]>`
    select
      (select count(*)::int from "User" where id = ${userId}) as user,
      (select count(*)::int from "Student" where id = ${studentId}) as student,
      (select count(*)::int from "Project" where student_id = ${studentId}) as project,
      (select count(*)::int from "Skill_student_rel" where student_id = ${studentId}) as skill,
      (select count(*)::int from "Language_student_rel" where student_id = ${studentId}) as language,
      (select count(*)::int from "Company_student_rel" where student_id = ${studentId}) as bookmark,
      (select count(*)::int from "Reminder_state" where student_id = ${studentId}) as reminder,
      (select count(*)::int from "Session" where user_id = ${userId}) as session`;
  return r!;
}

const CERO = { user: 0, student: 0, project: 0, skill: 0, language: 0, bookmark: 0, reminder: 0, session: 0 };

describe('DELETE /api/students/me — derecho al olvido (integración Supabase)', () => {
  it.runIf(hasDb)('borra al alumno y todos sus datos, y limpia la cookie', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { publicado: true });
      await conDatos(tx, alumna.studentId);

      const res = await call(app, 'DELETE', '/api/students/me', { cookie: alumna.cookie });
      expect(res.status).toBe(204);
      expect(res.headers.get('Set-Cookie')).toMatch(/^sesion=; /);
      expect(await cuenta(tx, alumna.user.id, alumna.studentId)).toEqual(CERO);

      // La sesión antigua ya no sirve.
      expect((await call(app, 'GET', '/api/me', { cookie: alumna.cookie })).status).toBe(401);
    });
  });

  it.runIf(hasDb)('Audit_log conserva la traza pero sin datos personales', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { nombre: 'Nombre Muy Unico' });
      // Genera auditoría con datos personales.
      await call(app, 'PATCH', '/api/students/me', {
        cookie: alumna.cookie,
        body: { bio: 'Bio muy personal', ubicacion: 'Calle Secreta 1' },
      });
      await call(app, 'DELETE', '/api/students/me', { cookie: alumna.cookie });

      const texto = JSON.stringify(await tx`select * from "Audit_log"`);
      expect(texto).not.toContain('Bio muy personal');
      expect(texto).not.toContain('Calle Secreta 1');
      expect(texto).not.toContain('Nombre Muy Unico');
      expect(texto).not.toContain(alumna.user.email);

      const borrados = await tx<{ tabla: string; operacion: string; id_registro: string }[]>`
        select tabla, operacion, id_registro from "Audit_log" where operacion = 'DELETE' and tabla in ('Student', 'User')`;
      expect(borrados.map((b) => b.tabla).sort()).toEqual(['Student', 'User']);
      // La traza (qué registro, qué operación) se mantiene.
      const [traza] = await tx<{ n: number }[]>`
        select count(*)::int as n from "Audit_log" where id_registro = ${alumna.studentId} and operacion = 'UPDATE'`;
      expect(traza!.n).toBe(1);
    });
  });

  it.runIf(hasDb)('no afecta a otros alumnos', async () => {
    await withApp(async ({ app, tx }) => {
      const yo = await alumnoConFicha(tx);
      const otra = await alumnoConFicha(tx);
      await conDatos(tx, otra.studentId);
      await call(app, 'DELETE', '/api/students/me', { cookie: yo.cookie });
      const c = await cuenta(tx, otra.user.id, otra.studentId);
      expect(c).toEqual({ user: 1, student: 1, project: 1, skill: 1, language: 1, bookmark: 1, reminder: 1, session: 1 });
    });
  });

  it.runIf(hasDb)('solo ALUMNO', async () => {
    await withApp(async ({ app, tx }) => {
      const socio = await loginAs(tx, 'SOCIO');
      expect((await call(app, 'DELETE', '/api/students/me', { cookie: socio.cookie })).status).toBe(403);
    });
  });
});

describe('DELETE /api/admin/students/:id (integración Supabase)', () => {
  it.runIf(hasDb)('el admin puede ejecutar el borrado; queda auditado a su nombre', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx);
      await conDatos(tx, alumna.studentId);
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'DELETE', `/api/admin/students/${alumna.studentId}`, { cookie });
      expect(res.status).toBe(204);
      expect(await cuenta(tx, alumna.user.id, alumna.studentId)).toEqual(CERO);
      const rows = await tx`select id_usuario from "Audit_log" where operacion = 'DELETE' and tabla = 'Student'`;
      expect(rows[0]!.id_usuario).toBe(admin.id);
    });
  });

  it.runIf(hasDb)('404 si no existe; 403 si no es ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      expect((await call(app, 'DELETE', '/api/admin/students/00000000-0000-4000-8000-000000000999', { cookie })).status).toBe(404);
      const alumna = await alumnoConFicha(tx);
      const socio = await loginAs(tx, 'SOCIO');
      expect((await call(app, 'DELETE', `/api/admin/students/${alumna.studentId}`, { cookie: socio.cookie })).status).toBe(403);
    });
  });
});

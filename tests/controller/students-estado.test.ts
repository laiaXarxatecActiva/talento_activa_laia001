import { describe, it, expect } from 'vitest';
import { hasDb, withApp, loginAs, alumnoConFicha, call } from '../helpers/db.js';

describe('PATCH /api/students/me/estado — el alumno (integración Supabase)', () => {
  it.runIf(hasDb)('con consentimiento puede activarse e inactivarse (auditado)', async () => {
    await withApp(async ({ app, tx }) => {
      const { user, cookie, studentId } = await alumnoConFicha(tx);
      await call(app, 'PATCH', '/api/students/me', { cookie, body: { consent: true } });

      const on = await call(app, 'PATCH', '/api/students/me/estado', { cookie, body: { estado: 'activo' } });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ student: { estado: 'activo' } });

      const off = await call(app, 'PATCH', '/api/students/me/estado', { cookie, body: { estado: 'inactivo' } });
      expect(await off.json()).toMatchObject({ student: { estado: 'inactivo' } });

      const rows = await tx`
        select id_usuario, datos_nuevos from "Audit_log"
        where tabla = 'Student' and id_registro = ${studentId} and datos_nuevos ? 'estado' order by "timestamp"`;
      expect(rows.map((r) => (r.datos_nuevos as { estado: string }).estado)).toEqual(['activo', 'inactivo']);
      expect(rows.every((r) => r.id_usuario === user.id)).toBe(true);
    });
  });

  it.runIf(hasDb)('sin consentimiento no puede activarse → 409', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const res = await call(app, 'PATCH', '/api/students/me/estado', { cookie, body: { estado: 'activo' } });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Para activar el perfil hace falta el consentimiento del alumno' });
    });
  });

  it.runIf(hasDb)('estado no válido → 400; otros roles → 403', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      for (const body of [{ estado: 'oculto' }, {}, { estado: true }]) {
        expect((await call(app, 'PATCH', '/api/students/me/estado', { cookie, body })).status).toBe(400);
      }
      const socio = await loginAs(tx, 'SOCIO');
      expect(
        (await call(app, 'PATCH', '/api/students/me/estado', { cookie: socio.cookie, body: { estado: 'activo' } })).status,
      ).toBe(403);
    });
  });
});

describe('PATCH /api/admin/students/:id/estado — el admin (integración Supabase)', () => {
  it.runIf(hasDb)('el admin puede inactivar a un alumno (auditado a su nombre)', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { publicado: true });
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'PATCH', `/api/admin/students/${alumna.studentId}/estado`, {
        cookie,
        body: { estado: 'inactivo' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ student: { id: alumna.studentId, estado: 'inactivo' } });
      const [a] = await tx`select id_usuario from "Audit_log" where tabla = 'Student' and id_registro = ${alumna.studentId}`;
      expect(a!.id_usuario).toBe(admin.id);
    });
  });

  it.runIf(hasDb)('el admin tampoco puede activar sin consentimiento → 409; 404 si no existe', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx);
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'PATCH', `/api/admin/students/${alumna.studentId}/estado`, { cookie, body: { estado: 'activo' } });
      expect(res.status).toBe(409);
      const nf = await call(app, 'PATCH', '/api/admin/students/00000000-0000-4000-8000-000000000999/estado', {
        cookie,
        body: { estado: 'inactivo' },
      });
      expect(nf.status).toBe(404);
    });
  });

  it.runIf(hasDb)('solo ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { publicado: true });
      const res = await call(app, 'PATCH', `/api/admin/students/${alumna.studentId}/estado`, {
        cookie: alumna.cookie,
        body: { estado: 'inactivo' },
      });
      expect(res.status).toBe(403);
    });
  });
});

describe('Enforcement: un inactivo nunca es consultable por empresas (integración Supabase)', () => {
  it.runIf(hasDb)('la empresa deja de verlo en cuanto pasa a inactivo, y lo vuelve a ver al reactivarse', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { publicado: true });
      const socio = await loginAs(tx, 'SOCIO');
      const ver = () => call(app, 'GET', `/api/students/${alumna.studentId}`, { cookie: socio.cookie });

      expect((await ver()).status).toBe(200);
      await call(app, 'PATCH', '/api/students/me/estado', { cookie: alumna.cookie, body: { estado: 'inactivo' } });
      expect((await ver()).status).toBe(404);
      await call(app, 'PATCH', '/api/students/me/estado', { cookie: alumna.cookie, body: { estado: 'activo' } });
      expect((await ver()).status).toBe(200);

      const admin = await loginAs(tx, 'ADMIN');
      await call(app, 'PATCH', `/api/admin/students/${alumna.studentId}/estado`, {
        cookie: admin.cookie,
        body: { estado: 'inactivo' },
      });
      expect((await ver()).status).toBe(404);
    });
  });

  it.runIf(hasDb)('el alumno inactivo sigue viendo y editando su ficha, y el admin lo sigue listando', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx);
      expect((await call(app, 'GET', '/api/students/me', { cookie: alumna.cookie })).status).toBe(200);
      const admin = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'GET', '/api/admin/students', { cookie: admin.cookie });
      const { students } = (await res.json()) as { students: Array<{ id: string; estado: string }> };
      expect(students.find((s) => s.id === alumna.studentId)).toMatchObject({ estado: 'inactivo' });
    });
  });
});

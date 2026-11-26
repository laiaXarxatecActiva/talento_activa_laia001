import { describe, it, expect } from 'vitest';
import type { TransactionSql } from 'postgres';
import { hasDb, withApp, loginAs, call, type TestApp } from '../helpers/db.js';

async function nuevaEdicion(app: TestApp, cookie: string, nombre = 'Edición T13'): Promise<string> {
  const res = await call(app, 'POST', '/api/admin/editions', { cookie, body: { nombre, anio: 2026 } });
  return ((await res.json()) as { edition: { id: string } }).edition.id;
}

async function contar(tx: TransactionSql, tabla: 'User' | 'Student', email: string): Promise<number> {
  const [row] =
    tabla === 'User'
      ? await tx<{ n: number }[]>`select count(*)::int as n from "User" where email = ${email}`
      : await tx<{ n: number }[]>`
          select count(*)::int as n from "Student" s join "User" u on u.id = s.user_id where u.email = ${email}`;
  return row!.n;
}

describe('POST /api/admin/students (integración Supabase)', () => {
  it.runIf(hasDb)('solo ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'SOCIO');
      const res = await call(app, 'POST', '/api/admin/students', { cookie, body: {} });
      expect(res.status).toBe(403);
    });
  });

  it.runIf(hasDb)('crea usuario ALUMNO + ficha inactiva en la edición y envía la invitación', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const editionId = await nuevaEdicion(app, cookie);
      const res = await call(app, 'POST', '/api/admin/students', {
        cookie,
        body: { email: 'Alumna@Example.com', nombre: '  Ana Pérez ', edition_id: editionId },
      });
      expect(res.status).toBe(201);
      const { student } = (await res.json()) as { student: Record<string, unknown> };
      expect(student).toMatchObject({
        email: 'alumna@example.com',
        nombre: 'Ana Pérez',
        edition_id: editionId,
        estado: 'inactivo',
        consent_at: null,
        email_verified: false,
      });
      const [u] = await tx`select rol from "User" where id = ${student.user_id as string}`;
      expect(u!.rol).toBe('ALUMNO');

      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.to).toBe('alumna@example.com');
      expect(outbox[0]!.text).toContain('/verificar?token=');
    });
  });

  it.runIf(hasDb)('audita el alta del Student a nombre del ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      const editionId = await nuevaEdicion(app, cookie);
      const res = await call(app, 'POST', '/api/admin/students', {
        cookie,
        body: { email: 'aud-alumno@example.com', nombre: 'Aud', edition_id: editionId },
      });
      const { student } = (await res.json()) as { student: { id: string } };
      const [row] = await tx`select id_usuario, operacion from "Audit_log" where tabla = 'Student' and id_registro = ${student.id}`;
      expect(row).toMatchObject({ id_usuario: admin.id, operacion: 'INSERT' });
    });
  });

  it.runIf(hasDb)('edición inexistente o datos no válidos → 400 y no se crea nada', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const editionId = await nuevaEdicion(app, cookie);
      const casos = [
        { email: 'm1@example.com', nombre: 'X', edition_id: '00000000-0000-4000-8000-000000000999' },
        { email: 'm2@example.com', nombre: 'X', edition_id: 'no-uuid' },
        { email: 'm3@example.com', nombre: '  ', edition_id: editionId },
        { email: 'no-email', nombre: 'X', edition_id: editionId },
        { email: 'm5@example.com', edition_id: editionId },
      ];
      for (const body of casos) {
        const res = await call(app, 'POST', '/api/admin/students', { cookie, body });
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      expect(await contar(tx, 'User', 'm1@example.com')).toBe(0);
    });
  });

  it.runIf(hasDb)('email ya registrado → 409 genérico', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const editionId = await nuevaEdicion(app, cookie);
      const body = { email: 'dup-alumno@example.com', nombre: 'Dup', edition_id: editionId };
      expect((await call(app, 'POST', '/api/admin/students', { cookie, body })).status).toBe(201);
      const res = await call(app, 'POST', '/api/admin/students', { cookie, body });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'No se ha podido completar el registro' });
    });
  });

  it.runIf(hasDb)('si falla el email no queda ni usuario ni ficha', async () => {
    await withApp(
      async ({ app, tx }) => {
        const { cookie } = await loginAs(tx, 'ADMIN');
        const editionId = await nuevaEdicion(app, cookie);
        const res = await call(app, 'POST', '/api/admin/students', {
          cookie,
          body: { email: 'sinmail@example.com', nombre: 'S', edition_id: editionId },
        });
        expect(res.status).toBe(502);
        expect(await contar(tx, 'User', 'sinmail@example.com')).toBe(0);
        expect(await contar(tx, 'Student', 'sinmail@example.com')).toBe(0);
      },
      { email: { send: async () => Promise.reject(new Error('caído')) } },
    );
  });
});

describe('GET /api/admin/students (integración Supabase)', () => {
  it.runIf(hasDb)('lista todos (activos e inactivos) y filtra por edición', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const e1 = await nuevaEdicion(app, cookie, 'E1');
      const e2 = await nuevaEdicion(app, cookie, 'E2');
      await call(app, 'POST', '/api/admin/students', { cookie, body: { email: 'l1@example.com', nombre: 'Uno', edition_id: e1 } });
      await call(app, 'POST', '/api/admin/students', { cookie, body: { email: 'l2@example.com', nombre: 'Dos', edition_id: e2 } });

      const todos = await call(app, 'GET', '/api/admin/students', { cookie });
      expect(todos.status).toBe(200);
      const { students } = (await todos.json()) as { students: Array<{ email: string; edition_nombre: string }> };
      expect(students.map((s) => s.email).sort()).toEqual(['l1@example.com', 'l2@example.com']);
      expect(students.find((s) => s.email === 'l1@example.com')!.edition_nombre).toBe('E1');

      const filtrado = await call(app, 'GET', `/api/admin/students?edition_id=${e2}`, { cookie });
      const body = (await filtrado.json()) as { students: Array<{ email: string }> };
      expect(body.students.map((s) => s.email)).toEqual(['l2@example.com']);

      expect((await call(app, 'GET', '/api/admin/students?edition_id=nope', { cookie })).status).toBe(400);
    });
  });
});

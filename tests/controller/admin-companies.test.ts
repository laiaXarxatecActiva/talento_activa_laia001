import { describe, it, expect } from 'vitest';
import { hasDb, withApp, loginAs, call } from '../helpers/db.js';

interface CompanyBody {
  company: { id: string; nombre: string; es_socia: boolean; contacto: string | null; usuarios: string[] };
}

describe('/api/admin/companies (integración Supabase)', () => {
  it.runIf(hasDb)('solo ADMIN', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ALUMNO');
      expect((await call(app, 'GET', '/api/admin/companies', { cookie })).status).toBe(403);
      expect((await call(app, 'POST', '/api/admin/companies', { cookie, body: {} })).status).toBe(403);
    });
  });

  it.runIf(hasDb)('crea empresa + usuario SOCIO vinculado + invitación', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/companies', {
        cookie,
        body: { nombre: ' Acme SL ', email: 'RRHH@acme.example.com', contacto: 'Laura, 600000000', es_socia: true },
      });
      expect(res.status).toBe(201);
      const { company } = (await res.json()) as CompanyBody;
      expect(company).toMatchObject({
        nombre: 'Acme SL',
        es_socia: true,
        contacto: 'Laura, 600000000',
        usuarios: ['rrhh@acme.example.com'],
      });

      const [rel] = await tx`
        select u.rol, u.email_verified from "Company_user_rel" r join "User" u on u.id = r.user_id
        where r.company_id = ${company.id}`;
      expect(rel).toMatchObject({ rol: 'SOCIO', email_verified: false });
      const [c] = await tx`select created_by from "Company" where id = ${company.id}`;
      expect(c!.created_by).toBe(admin.id);

      expect(outbox.map((m) => m.to)).toEqual(['rrhh@acme.example.com']);
      const audit = await tx<{ tabla: string }[]>`select tabla from "Audit_log" where tabla in ('Company', 'Company_user_rel')`;
      expect(audit.map((a) => a.tabla).sort()).toEqual(['Company', 'Company_user_rel']);
    });
  });

  it.runIf(hasDb)('es_socia es false por defecto y contacto opcional', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Beta', email: 'beta@example.com' } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ company: { es_socia: false, contacto: null } });
    });
  });

  it.runIf(hasDb)('datos no válidos → 400; email repetido → 409; nada a medias', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      for (const body of [
        { email: 'x@example.com' },
        { nombre: 'X', email: 'no-email' },
        { nombre: 'X', email: 'x@example.com', es_socia: 'si' },
      ]) {
        expect((await call(app, 'POST', '/api/admin/companies', { cookie, body })).status).toBe(400);
      }
      await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Uno', email: 'mismo@example.com' } });
      const dup = await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Dos', email: 'mismo@example.com' } });
      expect(dup.status).toBe(409);
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from "Company" where nombre = 'Dos'`;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('PATCH marca/desmarca socia (auditado); 404 si no existe', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Gamma', email: 'g@example.com' } });
      const { company } = (await res.json()) as CompanyBody;

      const patch = await call(app, 'PATCH', `/api/admin/companies/${company.id}`, { cookie, body: { es_socia: true } });
      expect(patch.status).toBe(200);
      expect(await patch.json()).toMatchObject({ company: { id: company.id, es_socia: true } });

      const [a] = await tx`select datos_anteriores, datos_nuevos from "Audit_log" where tabla = 'Company' and operacion = 'UPDATE'`;
      expect(a).toMatchObject({ datos_anteriores: { es_socia: false }, datos_nuevos: { es_socia: true } });

      expect((await call(app, 'PATCH', `/api/admin/companies/${company.id}`, { cookie, body: { es_socia: 'x' } })).status).toBe(400);
      expect(
        (await call(app, 'PATCH', '/api/admin/companies/00000000-0000-4000-8000-000000000999', { cookie, body: { es_socia: true } }))
          .status,
      ).toBe(404);
    });
  });

  it.runIf(hasDb)('invita a otro usuario de la misma empresa', async () => {
    await withApp(async ({ app, tx, outbox }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Delta', email: 'd1@example.com' } });
      const { company } = (await res.json()) as CompanyBody;

      const add = await call(app, 'POST', `/api/admin/companies/${company.id}/users`, { cookie, body: { email: 'd2@example.com' } });
      expect(add.status).toBe(201);
      expect(await add.json()).toMatchObject({ company: { usuarios: ['d1@example.com', 'd2@example.com'] } });
      expect(outbox.map((m) => m.to)).toEqual(['d1@example.com', 'd2@example.com']);

      const missing = await call(app, 'POST', '/api/admin/companies/00000000-0000-4000-8000-000000000999/users', {
        cookie,
        body: { email: 'd3@example.com' },
      });
      expect(missing.status).toBe(404);
    });
  });

  it.runIf(hasDb)('lista las empresas con sus usuarios', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Zeta', email: 'z@example.com', es_socia: true } });
      await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Alfa', email: 'a@example.com' } });
      const res = await call(app, 'GET', '/api/admin/companies', { cookie });
      expect(res.status).toBe(200);
      const { companies } = (await res.json()) as { companies: CompanyBody['company'][] };
      expect(companies.map((c) => c.nombre)).toEqual(['Alfa', 'Zeta']);
      expect(companies[1]).toMatchObject({ es_socia: true, usuarios: ['z@example.com'] });
    });
  });
});

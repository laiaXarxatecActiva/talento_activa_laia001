import { describe, it, expect } from 'vitest';
import { hasDb, withApp, loginAs, call } from '../helpers/db.js';

describe('Auditoría de Company_user_rel (integración Supabase)', () => {
  it.runIf(hasDb)('id_registro es el usuario vinculado (distinguible del alta de la empresa)', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/companies', { cookie, body: { nombre: 'Rel SL', email: 'rel@example.com' } });
      const { company } = (await res.json()) as { company: { id: string } };
      const [u] = await tx<{ id: string }[]>`select id from "User" where email = 'rel@example.com'`;
      const [a] = await tx`select id_registro, datos_nuevos from "Audit_log" where tabla = 'Company_user_rel'`;
      expect(a).toMatchObject({ id_registro: u!.id, datos_nuevos: { company_id: company.id, user_id: u!.id } });
    });
  });
});

import { describe, it, expect } from 'vitest';
import { hasDb, withApp, loginAs, call } from '../helpers/db.js';

const NUEVA = { nombre: 'Xarxatec Activa 2026', anio: 2026, fecha_inicio: '2026-01-15', fecha_fin: '2026-06-30' };

describe('/api/admin/editions (integración Supabase)', () => {
  it.runIf(hasDb)('solo ADMIN: SOCIO y ALUMNO → 403', async () => {
    await withApp(async ({ app, tx }) => {
      for (const rol of ['SOCIO', 'ALUMNO'] as const) {
        const { cookie } = await loginAs(tx, rol);
        expect((await call(app, 'GET', '/api/admin/editions', { cookie })).status).toBe(403);
        expect((await call(app, 'POST', '/api/admin/editions', { cookie, body: NUEVA })).status).toBe(403);
      }
    });
  });

  it.runIf(hasDb)('crea una edición abierta (201) y la audita', async () => {
    await withApp(async ({ app, tx }) => {
      const { user: admin, cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/editions', { cookie, body: { ...NUEVA, nombre: '  Edición 2026  ' } });
      expect(res.status).toBe(201);
      const { edition } = (await res.json()) as { edition: Record<string, unknown> };
      expect(edition).toMatchObject({
        nombre: 'Edición 2026',
        anio: 2026,
        fecha_inicio: '2026-01-15',
        fecha_fin: '2026-06-30',
        estado: 'abierta',
      });
      const [row] = await tx`select id_usuario, operacion from "Audit_log" where tabla = 'Edition' and id_registro = ${edition.id as string}`;
      expect(row).toMatchObject({ id_usuario: admin.id, operacion: 'INSERT' });
    });
  });

  it.runIf(hasDb)('las fechas son opcionales', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'POST', '/api/admin/editions', { cookie, body: { nombre: 'Sin fechas', anio: 2025 } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ edition: { fecha_inicio: null, fecha_fin: null } });
    });
  });

  it.runIf(hasDb)('datos no válidos → 400', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const malos = [
        { anio: 2026 },
        { nombre: '   ', anio: 2026 },
        { nombre: 'X', anio: '2026' },
        { nombre: 'X', anio: 1999 },
        { nombre: 'X', anio: 2026.5 },
        { nombre: 'X', anio: 2026, fecha_inicio: '2026-13-01' },
        { nombre: 'X', anio: 2026, fecha_inicio: '15/01/2026' },
        { nombre: 'X', anio: 2026, fecha_inicio: '2026-06-30', fecha_fin: '2026-01-01' },
        { nombre: 'x'.repeat(201), anio: 2026 },
      ];
      for (const body of malos) {
        const res = await call(app, 'POST', '/api/admin/editions', { cookie, body });
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
    });
  });

  it.runIf(hasDb)('lista las ediciones (más recientes primero)', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      await call(app, 'POST', '/api/admin/editions', { cookie, body: { nombre: 'Vieja', anio: 2024 } });
      await call(app, 'POST', '/api/admin/editions', { cookie, body: { nombre: 'Nueva', anio: 2026 } });
      const res = await call(app, 'GET', '/api/admin/editions', { cookie });
      expect(res.status).toBe(200);
      const { editions } = (await res.json()) as { editions: Array<{ nombre: string }> };
      const nombres = editions.map((e) => e.nombre);
      expect(nombres.indexOf('Nueva')).toBeLessThan(nombres.indexOf('Vieja'));
    });
  });

  it.runIf(hasDb)('cerrar una edición la marca como cerrada y se audita; es idempotente', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      const creada = await call(app, 'POST', '/api/admin/editions', { cookie, body: NUEVA });
      const { edition } = (await creada.json()) as { edition: { id: string } };

      const res = await call(app, 'POST', `/api/admin/editions/${edition.id}/close`, { cookie });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ edition: { id: edition.id, estado: 'cerrada' } });

      const otra = await call(app, 'POST', `/api/admin/editions/${edition.id}/close`, { cookie });
      expect(otra.status).toBe(200);

      const rows = await tx`select operacion, datos_anteriores, datos_nuevos from "Audit_log" where tabla = 'Edition' and operacion = 'UPDATE'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ datos_anteriores: { estado: 'abierta' }, datos_nuevos: { estado: 'cerrada' } });
    });
  });

  it.runIf(hasDb)('cerrar una edición inexistente → 404', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await loginAs(tx, 'ADMIN');
      expect((await call(app, 'POST', '/api/admin/editions/00000000-0000-4000-8000-000000000999/close', { cookie })).status).toBe(404);
      expect((await call(app, 'POST', '/api/admin/editions/nope/close', { cookie })).status).toBe(404);
    });
  });
});

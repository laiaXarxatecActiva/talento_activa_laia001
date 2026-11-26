import { describe, it, expect } from 'vitest';
import { hasDb, withApp, loginAs, alumnoConFicha, call } from '../helpers/db.js';

const COMPLETA = {
  foto_url: 'https://cdn.example.com/ana.jpg',
  bio: 'Me reconvertí a desarrollo web.',
  ubicacion: 'Barcelona',
  disponibilidad_traslado: true,
  modalidad: 'hibrido',
  estado_laboral: 'buscando',
  cv_url: 'https://cdn.example.com/ana.pdf',
  linkedin: 'https://www.linkedin.com/in/ana',
  github: 'https://github.com/ana',
};

describe('GET/PATCH /api/students/me (integración Supabase)', () => {
  it.runIf(hasDb)('solo ALUMNO con ficha: SOCIO → 403, ALUMNO sin ficha → 404', async () => {
    await withApp(async ({ app, tx }) => {
      const socio = await loginAs(tx, 'SOCIO');
      expect((await call(app, 'GET', '/api/students/me', { cookie: socio.cookie })).status).toBe(403);
      const sinFicha = await loginAs(tx, 'ALUMNO');
      expect((await call(app, 'GET', '/api/students/me', { cookie: sinFicha.cookie })).status).toBe(404);
    });
  });

  it.runIf(hasDb)('GET devuelve la ficha completa propia, con edición y privacidad', async () => {
    await withApp(async ({ app, tx }) => {
      const { user, cookie, studentId, editionId } = await alumnoConFicha(tx, { nombre: 'Ana' });
      const res = await call(app, 'GET', '/api/students/me', { cookie });
      expect(res.status).toBe(200);
      const { student } = (await res.json()) as { student: Record<string, unknown> };
      expect(student).toMatchObject({
        id: studentId,
        email: user.email,
        nombre: 'Ana',
        edition: { id: editionId, anio: 2026 },
        estado: 'inactivo',
        consent_at: null,
        privacy: {},
        bio: null,
        disponibilidad_traslado: false,
      });
    });
  });

  it.runIf(hasDb)('PATCH actualiza los campos enviados, marca filled_at y audita solo los cambios', async () => {
    await withApp(async ({ app, tx }) => {
      const { user, cookie, studentId } = await alumnoConFicha(tx);
      const res = await call(app, 'PATCH', '/api/students/me', { cookie, body: COMPLETA });
      expect(res.status).toBe(200);
      const { student } = (await res.json()) as { student: Record<string, unknown> };
      expect(student).toMatchObject(COMPLETA);
      expect(student.filled_at).not.toBeNull();

      // Parcial: solo cambia lo enviado.
      const res2 = await call(app, 'PATCH', '/api/students/me', { cookie, body: { ubicacion: 'Girona' } });
      expect(await res2.json()).toMatchObject({ student: { ubicacion: 'Girona', bio: COMPLETA.bio } });

      const rows = await tx`
        select id_usuario, datos_anteriores, datos_nuevos from "Audit_log"
        where tabla = 'Student' and id_registro = ${studentId} and operacion = 'UPDATE'
        order by "timestamp"`;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        id_usuario: user.id,
        datos_anteriores: { ubicacion: 'Barcelona' },
        datos_nuevos: { ubicacion: 'Girona' },
      });
    });
  });

  it.runIf(hasDb)('campos vacíos se guardan como null', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      await call(app, 'PATCH', '/api/students/me', { cookie, body: { bio: 'algo' } });
      const res = await call(app, 'PATCH', '/api/students/me', { cookie, body: { bio: '  ' } });
      expect(await res.json()).toMatchObject({ student: { bio: null } });
    });
  });

  it.runIf(hasDb)('datos no válidos → 400 sin cambios', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const malos = [
        { modalidad: 'teletrabajo' },
        { estado_laboral: 'parado' },
        { disponibilidad_traslado: 'si' },
        { linkedin: 'javascript:alert(1)' },
        { github: 'no es url' },
        { cv_url: 'ftp://x.com/cv.pdf' },
        { bio: 'x'.repeat(2001) },
        { nombre: '' },
        { privacy: { bio: 'si' } },
        { privacy: { campo_inventado: true } },
        { privacy: ['bio'] },
        { consent: 'si' },
        { email: 'otro@example.com' },
        { estado: 'activo' },
      ];
      for (const body of malos) {
        const res = await call(app, 'PATCH', '/api/students/me', { cookie, body });
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from "Audit_log" where tabla = 'Student'`;
      expect(row!.n).toBe(0);
    });
  });

  it.runIf(hasDb)('consent: true fija consent_at; consent: false lo borra e inactiva el perfil', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie, studentId } = await alumnoConFicha(tx);
      const r1 = await call(app, 'PATCH', '/api/students/me', { cookie, body: { consent: true } });
      const s1 = ((await r1.json()) as { student: { consent_at: string | null } }).student;
      expect(s1.consent_at).not.toBeNull();

      await tx`update "Student" set estado = 'activo' where id = ${studentId}`;
      const r2 = await call(app, 'PATCH', '/api/students/me', { cookie, body: { consent: false } });
      expect(await r2.json()).toMatchObject({ student: { consent_at: null, estado: 'inactivo' } });
    });
  });

  it.runIf(hasDb)('privacy se guarda por campo', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const res = await call(app, 'PATCH', '/api/students/me', {
        cookie,
        body: { privacy: { bio: true, email: true, cv_url: false } },
      });
      expect(await res.json()).toMatchObject({ student: { privacy: { bio: true, email: true, cv_url: false } } });
    });
  });
});

describe('GET /api/students/:id — visibilidad según quién mira (integración Supabase)', () => {
  it.runIf(hasDb)('SOCIO ve solo nombre, edición y los campos marcados visibles', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, {
        nombre: 'Berta',
        publicado: true,
        privacy: { bio: true, email: true, github: true, ubicacion: false },
        extra: { bio: 'Hola', ubicacion: 'Lleida', github: 'https://github.com/berta', linkedin: 'https://linkedin.com/in/b' },
      });
      const socio = await loginAs(tx, 'SOCIO');
      const res = await call(app, 'GET', `/api/students/${alumna.studentId}`, { cookie: socio.cookie });
      expect(res.status).toBe(200);
      const { student } = (await res.json()) as { student: Record<string, unknown> };
      expect(student).toEqual({
        id: alumna.studentId,
        nombre: 'Berta',
        edition: expect.objectContaining({ id: alumna.editionId }),
        bio: 'Hola',
        email: alumna.user.email,
        github: 'https://github.com/berta',
        skills: [],
        languages: [],
        projects: [],
      });
    });
  });

  it.runIf(hasDb)('SOCIO no ve alumnos inactivos o sin consentimiento → 404', async () => {
    await withApp(async ({ app, tx }) => {
      const inactiva = await alumnoConFicha(tx);
      const sinConsent = await alumnoConFicha(tx, { publicado: true });
      await tx`update "Student" set consent_at = null where id = ${sinConsent.studentId}`;
      const socio = await loginAs(tx, 'SOCIO');
      for (const id of [inactiva.studentId, sinConsent.studentId, '00000000-0000-4000-8000-000000000999']) {
        expect((await call(app, 'GET', `/api/students/${id}`, { cookie: socio.cookie })).status).toBe(404);
      }
    });
  });

  it.runIf(hasDb)('ADMIN ve la ficha completa aunque esté inactiva', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { extra: { bio: 'Privada' } });
      const admin = await loginAs(tx, 'ADMIN');
      const res = await call(app, 'GET', `/api/students/${alumna.studentId}`, { cookie: admin.cookie });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ student: { bio: 'Privada', estado: 'inactivo', privacy: {} } });
    });
  });

  it.runIf(hasDb)('un ALUMNO solo puede ver su propia ficha', async () => {
    await withApp(async ({ app, tx }) => {
      const otra = await alumnoConFicha(tx, { publicado: true });
      const yo = await alumnoConFicha(tx);
      expect((await call(app, 'GET', `/api/students/${otra.studentId}`, { cookie: yo.cookie })).status).toBe(404);
      expect((await call(app, 'GET', `/api/students/${yo.studentId}`, { cookie: yo.cookie })).status).toBe(200);
    });
  });
});

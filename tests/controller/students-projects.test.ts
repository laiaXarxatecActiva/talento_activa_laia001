import { describe, it, expect } from 'vitest';
import { hasDb, withApp, loginAs, alumnoConFicha, call, type TestApp } from '../helpers/db.js';
import type { Storage } from '../../src/model/storage.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface ProjectBody {
  project: { id: string; titulo: string; descripcion: string | null; url: string; thumbnail_url: string | null };
}

function fakeStorage() {
  const uploads: Array<{ path: string; contentType: string; size: number }> = [];
  const removed: string[] = [];
  const storage: Storage = {
    async upload(path, bytes, contentType) {
      uploads.push({ path, contentType, size: bytes.byteLength });
      return `https://cdn.test/${path}`;
    },
    async remove(url) {
      removed.push(url);
    },
  };
  return { storage, uploads, removed };
}

function putThumb(app: TestApp, id: string, cookie: string, bytes: Uint8Array, type = 'image/png') {
  return app.request(`/api/students/me/projects/${id}/thumbnail`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': type },
    body: bytes,
  });
}

async function crear(app: TestApp, cookie: string, body: Record<string, unknown> = {}) {
  const res = await call(app, 'POST', '/api/students/me/projects', {
    cookie,
    body: { titulo: 'Portfolio', url: 'https://github.com/ana/portfolio', ...body },
  });
  return { res, project: res.status === 201 ? ((await res.json()) as ProjectBody).project : null };
}

describe('Proyectos del alumno — CRUD (integración Supabase)', () => {
  it.runIf(hasDb)('crea, lista, edita y borra sus proyectos (todo auditado)', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie, user } = await alumnoConFicha(tx);
      const { res, project } = await crear(app, cookie, { descripcion: 'Mi web' });
      expect(res.status).toBe(201);
      expect(project).toMatchObject({ titulo: 'Portfolio', descripcion: 'Mi web', url: 'https://github.com/ana/portfolio', thumbnail_url: null });

      const list = await call(app, 'GET', '/api/students/me/projects', { cookie });
      expect(((await list.json()) as { projects: unknown[] }).projects).toHaveLength(1);

      const patch = await call(app, 'PATCH', `/api/students/me/projects/${project!.id}`, {
        cookie,
        body: { titulo: 'Portfolio v2' },
      });
      expect(patch.status).toBe(200);
      expect(await patch.json()).toMatchObject({ project: { titulo: 'Portfolio v2', url: 'https://github.com/ana/portfolio' } });

      const del = await call(app, 'DELETE', `/api/students/me/projects/${project!.id}`, { cookie });
      expect(del.status).toBe(204);
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from "Project" where id = ${project!.id}`;
      expect(n!.n).toBe(0);

      const ops = await tx<{ operacion: string; id_usuario: string }[]>`
        select operacion, id_usuario from "Audit_log" where tabla = 'Project' order by "timestamp"`;
      expect(ops.map((o) => o.operacion)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
      expect(ops.every((o) => o.id_usuario === user.id)).toBe(true);
    });
  });

  it.runIf(hasDb)('valida título y URL (http/https con dominio) → 400', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      for (const body of [
        { url: 'javascript:alert(1)' },
        { url: 'github.com/sin-esquema' },
        { url: 'ftp://x.com/a' },
        { titulo: '   ' },
        { titulo: 'x'.repeat(201) },
        { descripcion: 'x'.repeat(2001) },
        { thumbnail_url: 'https://cdn.example.com/x.png' },
      ]) {
        const { res } = await crear(app, cookie, body);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      const { project } = await crear(app, cookie);
      const res = await call(app, 'PATCH', `/api/students/me/projects/${project!.id}`, { cookie, body: { url: 'nope' } });
      expect(res.status).toBe(400);
    });
  });

  it.runIf(hasDb)('no puede tocar proyectos de otro alumno → 404', async () => {
    await withApp(async ({ app, tx }) => {
      const otra = await alumnoConFicha(tx);
      const { project } = await crear(app, otra.cookie);
      const yo = await alumnoConFicha(tx);
      expect((await call(app, 'PATCH', `/api/students/me/projects/${project!.id}`, { cookie: yo.cookie, body: { titulo: 'x' } })).status).toBe(404);
      expect((await call(app, 'DELETE', `/api/students/me/projects/${project!.id}`, { cookie: yo.cookie })).status).toBe(404);
      expect((await putThumb(app, project!.id, yo.cookie, PNG)).status).toBe(404);
    });
  });

  it.runIf(hasDb)('los proyectos aparecen en la ficha que ve la empresa (si el perfil es visible)', async () => {
    await withApp(async ({ app, tx }) => {
      const alumna = await alumnoConFicha(tx, { publicado: true });
      await crear(app, alumna.cookie, { titulo: 'App visible' });
      const socio = await loginAs(tx, 'SOCIO');
      const res = await call(app, 'GET', `/api/students/${alumna.studentId}`, { cookie: socio.cookie });
      expect(await res.json()).toMatchObject({ student: { projects: [{ titulo: 'App visible' }] } });
    });
  });

  it.runIf(hasDb)('solo ALUMNO', async () => {
    await withApp(async ({ app, tx }) => {
      const socio = await loginAs(tx, 'SOCIO');
      expect((await call(app, 'GET', '/api/students/me/projects', { cookie: socio.cookie })).status).toBe(403);
    });
  });
});

describe('Miniatura del proyecto — subida manual (integración Supabase)', () => {
  it.runIf(hasDb)('sube la imagen a Storage y guarda la URL pública', async () => {
    const fs = fakeStorage();
    await withApp(
      async ({ app, tx }) => {
        const { cookie } = await alumnoConFicha(tx);
        const { project } = await crear(app, cookie);
        const res = await putThumb(app, project!.id, cookie, PNG);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ProjectBody;
        expect(fs.uploads).toHaveLength(1);
        expect(fs.uploads[0]).toMatchObject({ contentType: 'image/png', size: PNG.byteLength });
        expect(fs.uploads[0]!.path).toMatch(new RegExp(`^thumbnails/${project!.id}-[A-Za-z0-9_-]+\\.png$`));
        expect(body.project.thumbnail_url).toBe(`https://cdn.test/${fs.uploads[0]!.path}`);
      },
      { storage: fs.storage },
    );
  });

  it.runIf(hasDb)('al reemplazarla o borrar el proyecto se elimina la imagen anterior', async () => {
    const fs = fakeStorage();
    await withApp(
      async ({ app, tx }) => {
        const { cookie } = await alumnoConFicha(tx);
        const { project } = await crear(app, cookie);
        const first = ((await (await putThumb(app, project!.id, cookie, PNG)).json()) as ProjectBody).project.thumbnail_url;
        const second = ((await (await putThumb(app, project!.id, cookie, PNG)).json()) as ProjectBody).project.thumbnail_url;
        expect(fs.removed).toEqual([first]);
        await call(app, 'DELETE', `/api/students/me/projects/${project!.id}`, { cookie });
        expect(fs.removed).toEqual([first, second]);
      },
      { storage: fs.storage },
    );
  });

  it.runIf(hasDb)('rechaza lo que no es PNG/JPEG/WebP o supera 2 MB → 400', async () => {
    const fs = fakeStorage();
    await withApp(
      async ({ app, tx }) => {
        const { cookie } = await alumnoConFicha(tx);
        const { project } = await crear(app, cookie);
        const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
        expect((await putThumb(app, project!.id, cookie, svg, 'image/svg+xml')).status).toBe(400);
        // Cabecera de imagen pero contenido que no lo es.
        expect((await putThumb(app, project!.id, cookie, new TextEncoder().encode('hola'), 'image/png')).status).toBe(400);
        const big = new Uint8Array(2 * 1024 * 1024 + 1);
        big.set(PNG);
        expect((await putThumb(app, project!.id, cookie, big)).status).toBe(400);
        expect((await putThumb(app, project!.id, cookie, new Uint8Array())).status).toBe(400);
        expect(fs.uploads).toHaveLength(0);
      },
      { storage: fs.storage },
    );
  });

  it.runIf(hasDb)('sin Storage configurado → 503', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const { project } = await crear(app, cookie);
      const res = await putThumb(app, project!.id, cookie, PNG);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Almacenamiento de archivos no configurado' });
    });
  });
});

import { describe, it, expect } from 'vitest';
import { hasDb, withApp, alumnoConFicha, loginAs, call, type TestApp } from '../helpers/db.js';
import type { Storage } from '../../src/model/storage.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function putThumb(app: TestApp, id: string, cookie: string) {
  return app.request(`/api/students/me/projects/${id}/thumbnail`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'image/png' },
    body: PNG,
  });
}

async function proyecto(app: TestApp, cookie: string): Promise<string> {
  const res = await call(app, 'POST', '/api/students/me/projects', {
    cookie,
    body: { titulo: 'P', url: 'https://github.com/a/b' },
  });
  return ((await res.json()) as { project: { id: string } }).project.id;
}

describe('Limpieza de Storage (integración Supabase)', () => {
  it.runIf(hasDb)('si falla guardar la miniatura tras subirla, se borra el fichero subido (sin huérfanos)', async () => {
    const uploaded: string[] = [];
    const removed: string[] = [];
    let txRef: { unsafe: (q: string) => Promise<unknown> } | null = null;
    let projectId = '';
    const storage: Storage = {
      async upload(path) {
        uploaded.push(path);
        // Simula que el proyecto se borra mientras se sube la imagen.
        await txRef!.unsafe(`delete from "Project" where id = '${projectId}'`);
        return `https://cdn.test/${path}`;
      },
      async remove(url) {
        removed.push(url);
      },
    };
    await withApp(
      async ({ app, tx }) => {
        txRef = tx;
        const { cookie } = await alumnoConFicha(tx);
        projectId = await proyecto(app, cookie);
        const res = await putThumb(app, projectId, cookie);
        expect(res.status).toBe(404);
        expect(removed).toEqual([`https://cdn.test/${uploaded[0]}`]);
      },
      { storage },
    );
  });

  it.runIf(hasDb)('si el borrado en Storage falla, se reintenta y queda pendiente en Audit_log', async () => {
    let intentos = 0;
    const storage: Storage = {
      async upload(path) {
        return `https://cdn.test/${path}`;
      },
      async remove() {
        intentos++;
        throw new Error('Storage caído');
      },
    };
    await withApp(
      async ({ app, tx }) => {
        const alumna = await alumnoConFicha(tx);
        const pid = await proyecto(app, alumna.cookie);
        const thumb = ((await (await putThumb(app, pid, alumna.cookie)).json()) as { project: { thumbnail_url: string } })
          .project.thumbnail_url;

        const admin = await loginAs(tx, 'ADMIN');
        const res = await call(app, 'DELETE', `/api/admin/students/${alumna.studentId}`, { cookie: admin.cookie });
        expect(res.status).toBe(204);
        expect(intentos).toBe(3);

        const rows = await tx`
          select id_usuario, operacion, datos_anteriores from "Audit_log" where tabla = 'Storage'`;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id_usuario: null,
          operacion: 'DELETE',
          datos_anteriores: { url: thumb, estado: 'pendiente' },
        });
      },
      { storage },
    );
  });
});

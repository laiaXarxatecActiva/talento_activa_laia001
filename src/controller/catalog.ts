import { Hono } from 'hono';
import { LANGUAGES, listCatalog, SKILLS } from '../model/catalog.js';
import type { AppEnv, Deps } from './http.js';
import { requireAuth } from './middleware.js';

/** Catálogos de skills e idiomas (cualquier usuario con sesión). */
export function catalogRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/skills', requireAuth(deps), async (c) => {
    const skills = await deps.transaction((tx) => listCatalog(tx, SKILLS));
    return c.json({ skills }, 200);
  });

  r.get('/languages', requireAuth(deps), async (c) => {
    const languages = await deps.transaction((tx) => listCatalog(tx, LANGUAGES));
    return c.json({ languages }, 200);
  });

  return r;
}

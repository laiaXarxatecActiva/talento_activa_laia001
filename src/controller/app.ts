import { Hono } from 'hono';
import type { EmailMessage, EmailSender } from '../model/email.js';
import {
  ConflictError,
  EmailDeliveryError,
  InvalidCredentialsError,
  InvalidDataError,
  NotFoundError,
  StorageUnavailableError,
} from '../model/errors.js';
import type { Storage } from '../model/storage.js';
import { bodyLimit } from 'hono/body-limit';
import { createLimiters, DEFAULT_RATE_LIMIT, type RateLimitConfig } from './rate-limit.js';
import { adminRoutes } from './admin.js';
import { authRoutes } from './auth.js';
import { catalogRoutes } from './catalog.js';
import { studentRoutes } from './students.js';
import type { AppEnv, Deps, Transaction } from './http.js';

export type { Transaction } from './http.js';

export interface AppDeps {
  transaction: Transaction;
  /** Envío de emails. Por defecto, los escribe en consola (desarrollo). */
  email?: EmailSender;
  /** URL pública para enlaces en emails. Por defecto, APP_URL o localhost. */
  appUrl?: string;
  /** Almacenamiento de archivos (miniaturas). Sin él, las subidas → 503. */
  storage?: Storage;
  /** Límites de intentos de login/verify. */
  rateLimit?: RateLimitConfig;
}

/** Tamaño máximo de un cuerpo JSON (las miniaturas tienen su propio límite). */
const MAX_JSON_BYTES = 64 * 1024;

const consoleEmail: EmailSender = {
  async send(m: EmailMessage) {
    console.log(`[email] Para: ${m.to} | Asunto: ${m.subject}\n${m.text}`);
  },
};

export function createApp(appDeps: AppDeps) {
  const deps: Deps = {
    transaction: appDeps.transaction,
    email: appDeps.email ?? consoleEmail,
    appUrl: appDeps.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000',
    storage: appDeps.storage ?? null,
    limiters: createLimiters(appDeps.rateLimit ?? DEFAULT_RATE_LIMIT),
  };

  const app = new Hono<AppEnv>();

  // Traduce los errores del modelo a respuestas HTTP. Lo no previsto → 500
  // genérico (sin filtrar detalles internos).
  app.onError((err, c) => {
    if (err instanceof InvalidDataError) return c.json({ error: err.message }, 400);
    if (err instanceof InvalidCredentialsError) return c.json({ error: err.message }, 401);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof EmailDeliveryError) return c.json({ error: err.message }, 502);
    if (err instanceof StorageUnavailableError) return c.json({ error: err.message }, 503);
    console.error(err);
    return c.json({ error: 'Error interno' }, 500);
  });

  // Límite de tamaño para todo lo que no sea una subida de miniatura.
  const jsonLimit = bodyLimit({
    maxSize: MAX_JSON_BYTES,
    onError: (c) => c.json({ error: 'Petición demasiado grande' }, 413),
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.path.endsWith('/thumbnail')) return next();
    return jsonLimit(c, next);
  });

  app.route('/api', authRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.route('/api/students', studentRoutes(deps));
  app.route('/api', catalogRoutes(deps));

  return app;
}

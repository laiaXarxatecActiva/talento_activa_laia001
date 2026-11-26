import { Hono } from 'hono';
import type { EmailMessage, EmailSender } from '../model/email.js';
import {
  ConflictError,
  EmailDeliveryError,
  InvalidCredentialsError,
  InvalidDataError,
  NotFoundError,
} from '../model/errors.js';
import { adminRoutes } from './admin.js';
import { authRoutes } from './auth.js';
import { studentRoutes } from './students.js';
import type { AppEnv, Deps, Transaction } from './http.js';

export type { Transaction } from './http.js';

export interface AppDeps {
  transaction: Transaction;
  /** Envío de emails. Por defecto, los escribe en consola (desarrollo). */
  email?: EmailSender;
  /** URL pública para enlaces en emails. Por defecto, APP_URL o localhost. */
  appUrl?: string;
}

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
    console.error(err);
    return c.json({ error: 'Error interno' }, 500);
  });

  app.route('/api', authRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.route('/api/students', studentRoutes(deps));

  return app;
}

// Utilidades compartidas por los tests de integración. No es un fichero de test
// (no termina en .test.ts), pero los tests bloqueados dependen de él: cambia su
// comportamiento solo con el mismo cuidado que un test bloqueado.
import type { Sql, TransactionSql } from 'postgres';
import { createDb } from '../../src/model/db.js';
import { createApp, type AppDeps } from '../../src/controller/app.js';
import { createUser, type PublicUser, type Rol } from '../../src/model/user.js';
import { createSession } from '../../src/model/session.js';
import type { EmailMessage } from '../../src/model/email.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
/** ¿Hay una BD real configurada? Si no, los tests de integración se omiten. */
export const hasDb = raw.length > 0 && !raw.includes('<');

export const PASSWORD = 'contrasena-de-prueba-larga';

class Rollback extends Error {}

/** Ejecuta `fn` en una transacción que SIEMPRE se deshace. */
export async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const sql: Sql = createDb();
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await sql.end();
  }
}

export type TestApp = ReturnType<typeof createApp>;

export interface AppContext {
  app: TestApp;
  tx: TransactionSql;
  /** Emails "enviados" por la app durante el test. */
  outbox: EmailMessage[];
}

/**
 * Crea la app con una transacción que abre savepoints dentro de una transacción
 * externa que se deshace al final: nada de lo que haga la petición persiste.
 */
export async function withApp(
  fn: (ctx: AppContext) => Promise<void>,
  overrides: Partial<AppDeps> = {},
): Promise<void> {
  await inRollback(async (tx) => {
    const outbox: EmailMessage[] = [];
    const app = createApp({
      transaction: (work) => tx.savepoint(work),
      email: { send: async (m) => void outbox.push(m) },
      appUrl: 'http://localhost:3000',
      ...overrides,
    });
    await fn({ app, tx, outbox });
  });
}

/** App que falla si intenta tocar la BD (casos que se rechazan antes). */
export function appSinBd(): TestApp {
  return createApp({
    transaction: () => {
      throw new Error('no debería llamarse a la BD');
    },
    email: {
      send: async () => {
        throw new Error('no debería enviarse email');
      },
    },
    appUrl: 'http://localhost:3000',
  });
}

let seq = 0;

/** Crea un usuario verificado y una sesión; devuelve la cabecera Cookie lista. */
export async function loginAs(
  tx: TransactionSql,
  rol: Rol,
  email = `u${++seq}-${Date.now()}@example.com`,
): Promise<{ user: PublicUser; cookie: string; token: string }> {
  const user = await createUser(tx, null, { email, password: PASSWORD, rol });
  await tx`update "User" set email_verified = true where id = ${user.id}`;
  const { token } = await createSession(tx, user.id);
  return { user: { ...user, email_verified: true }, cookie: `sesion=${token}`, token };
}

/** Petición JSON a la app. */
export function call(
  app: TestApp,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie) headers.Cookie = opts.cookie;
  return Promise.resolve(
    app.request(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

/**
 * Crea una edición y un ALUMNO verificado con ficha Student y sesión.
 * `estado`/`consent` permiten dejarlo ya publicado (activo + consentimiento).
 */
export async function alumnoConFicha(
  tx: TransactionSql,
  opts: { nombre?: string; publicado?: boolean; privacy?: Record<string, boolean>; extra?: Record<string, unknown> } = {},
): Promise<{ user: PublicUser; cookie: string; studentId: string; editionId: string }> {
  const { user, cookie } = await loginAs(tx, 'ALUMNO');
  const [edition] = await tx<{ id: string }[]>`
    insert into "Edition" (nombre, anio) values (${`Edición ${user.email}`}, 2026) returning id`;
  const [student] = await tx<{ id: string }[]>`
    insert into "Student" (user_id, edition_id, nombre, estado, consent_at, privacy)
    values (${user.id}, ${edition!.id}, ${opts.nombre ?? 'Alumna Test'},
            ${opts.publicado ? 'activo' : 'inactivo'}, ${opts.publicado ? new Date() : null},
            ${tx.json(opts.privacy ?? {})})
    returning id`;
  if (opts.extra && Object.keys(opts.extra).length > 0) {
    await tx`update "Student" set ${tx(opts.extra as Record<string, string>)} where id = ${student!.id}`;
  }
  return { user, cookie, studentId: student!.id, editionId: edition!.id };
}

/** Crea una empresa directamente en BD y devuelve su id. */
export async function nuevaEmpresa(tx: TransactionSql, nombre = 'Empresa Test'): Promise<string> {
  const [c] = await tx<{ id: string }[]>`insert into "Company" (nombre) values (${nombre}) returning id`;
  return c!.id;
}

/** Crea una edición directamente en BD y devuelve su id. */
export async function nuevaEdicion(tx: TransactionSql, nombre = 'Edición Test'): Promise<string> {
  const [e] = await tx<{ id: string }[]>`insert into "Edition" (nombre, anio) values (${nombre}, 2026) returning id`;
  return e!.id;
}

/** Cuerpo válido de POST /api/auth/register para cada rol invitable. */
export async function registerBody(
  tx: TransactionSql,
  rol: 'SOCIO' | 'ALUMNO',
  email: string,
): Promise<Record<string, string>> {
  return rol === 'SOCIO'
    ? { email, rol, company_id: await nuevaEmpresa(tx) }
    : { email, rol, edition_id: await nuevaEdicion(tx), nombre: 'Alumno Invitado' };
}

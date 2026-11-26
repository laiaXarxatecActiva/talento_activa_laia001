import { describe, it, expect } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { hasDb } from '../helpers/db.js';
import { createDb } from '../../src/model/db.js';
import { setStudentEstado, updateOwnStudent } from '../../src/model/student.js';

// Las decisiones sobre estado/consentimiento leen la ficha con bloqueo de fila
// (select ... for update) para que dos cambios concurrentes no dejen un estado
// incoherente. Se comprueba con dos conexiones: una retiene el bloqueo y la otra
// debe esperar en la LECTURA (incluso cuando no va a cambiar nada).
// Necesita datos confirmados: se crean y se borran al final.
describe('model/student — bloqueo de fila en cambios de estado (integración Supabase)', () => {
  it.runIf(hasDb)('setStudentEstado y updateOwnStudent esperan al bloqueo de otra transacción', async () => {
    const a: Sql = createDb();
    const b: Sql = createDb();
    const email = `lock-${Date.now()}@example.com`;
    let userId = '';
    let editionId = '';
    try {
      const [u] = await a<{ id: string }[]>`
        insert into "User" (email, password_hash, rol, email_verified) values (${email}, 'x', 'ALUMNO', true) returning id`;
      userId = u!.id;
      const [e] = await a<{ id: string }[]>`insert into "Edition" (nombre, anio) values ('Lock', 2026) returning id`;
      editionId = e!.id;
      const [s] = await a<{ id: string }[]>`
        insert into "Student" (user_id, edition_id, nombre) values (${userId}, ${editionId}, 'Lock') returning id`;
      const studentId = s!.id;

      await a.begin(async (holder) => {
        await holder`select id from "Student" where id = ${studentId} for update`;

        // Sin cambios reales: sin bloqueo en la lectura terminarían sin esperar.
        const intento = (fn: (tx: TransactionSql) => Promise<unknown>) =>
          b.begin(async (tx) => {
            await tx`set local lock_timeout = '300ms'`;
            return fn(tx);
          });
        await expect(intento((tx) => setStudentEstado(tx, userId, studentId, 'inactivo'))).rejects.toMatchObject({
          code: '55P03',
        });
        await expect(intento((tx) => updateOwnStudent(tx, userId, {}))).rejects.toMatchObject({ code: '55P03' });
      });
    } finally {
      if (userId) await a`delete from "Audit_log" where id_usuario = ${userId}`;
      if (userId) await a`delete from "User" where id = ${userId}`;
      if (editionId) await a`delete from "Edition" where id = ${editionId}`;
      await a.end();
      await b.end();
    }
  });
});

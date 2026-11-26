import { describe, it, expect } from 'vitest';
import { hasDb, inRollback, PASSWORD } from '../helpers/db.js';
import { createInitialAdmin } from '../../src/model/user.js';
import { login } from '../../src/model/auth.js';
import { InvalidDataError, ConflictError } from '../../src/model/errors.js';

describe('model/user — createInitialAdmin (alta del staff, fuera de la API)', () => {
  it.runIf(hasDb)('crea un ADMIN ya verificado que puede hacer login', async () => {
    await inRollback(async (tx) => {
      const admin = await createInitialAdmin(tx, 'staff@example.com', PASSWORD);
      expect(admin).toMatchObject({ email: 'staff@example.com', rol: 'ADMIN', email_verified: true });
      const res = await login(tx, 'staff@example.com', PASSWORD, null);
      expect(res.user.id).toBe(admin.id);
    });
  });

  it.runIf(hasDb)('audita el alta y la verificación como acciones del sistema', async () => {
    await inRollback(async (tx) => {
      const admin = await createInitialAdmin(tx, 'staff2@example.com', PASSWORD);
      const rows = await tx<{ operacion: string; id_usuario: string | null }[]>`
        select operacion, id_usuario from "Audit_log" where tabla = 'User' and id_registro = ${admin.id}
        order by "timestamp", operacion
      `;
      expect(rows.map((r) => r.operacion).sort()).toEqual(['INSERT', 'UPDATE']);
      expect(rows.every((r) => r.id_usuario === null)).toBe(true);
    });
  });

  it.runIf(hasDb)('email repetido → ConflictError; contraseña corta → InvalidDataError', async () => {
    await inRollback(async (tx) => {
      await createInitialAdmin(tx, 'staff3@example.com', PASSWORD);
      await expect(createInitialAdmin(tx, 'staff3@example.com', PASSWORD)).rejects.toBeInstanceOf(ConflictError);
      await expect(createInitialAdmin(tx, 'staff4@example.com', 'corta')).rejects.toBeInstanceOf(InvalidDataError);
    });
  });
});

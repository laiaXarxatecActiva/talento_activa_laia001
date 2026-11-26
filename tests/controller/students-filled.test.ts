import { describe, it, expect } from 'vitest';
import { hasDb, withApp, alumnoConFicha, call } from '../helpers/db.js';

// filled_at detiene los recordatorios de la Fase 3: solo cuenta como "ficha
// rellenada" un cambio real en un campo de datos (no privacidad, consentimiento
// ni ediciones que no cambian nada).
describe('filled_at solo con cambios reales de datos (integración Supabase)', () => {
  it.runIf(hasDb)('privacidad, consentimiento o ediciones sin cambios no marcan filled_at', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie, studentId } = await alumnoConFicha(tx, { nombre: 'Igual' });
      for (const body of [{}, { privacy: {} }, { privacy: { bio: true } }, { consent: true }, { nombre: 'Igual' }, { bio: '' }]) {
        const res = await call(app, 'PATCH', '/api/students/me', { cookie, body });
        expect(res.status).toBe(200);
        const [row] = await tx<{ filled_at: Date | null }[]>`select filled_at from "Student" where id = ${studentId}`;
        expect({ body, filled_at: row!.filled_at }).toEqual({ body, filled_at: null });
      }
    });
  });

  it.runIf(hasDb)('el primer cambio de un dato de la ficha marca filled_at', async () => {
    await withApp(async ({ app, tx }) => {
      const { cookie } = await alumnoConFicha(tx);
      const res = await call(app, 'PATCH', '/api/students/me', { cookie, body: { bio: 'Ya relleno mi ficha' } });
      expect(((await res.json()) as { student: { filled_at: string | null } }).student.filled_at).not.toBeNull();
    });
  });
});

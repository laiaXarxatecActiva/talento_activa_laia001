import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Ficheros en serie: el test de coste temporal del login (anti-enumeración)
    // mide tiempos y se vuelve inestable si compite por CPU con otros ficheros.
    fileParallelism: false,
    // Los tests de integración hablan con Supabase por red: margen de latencia.
    testTimeout: 20_000,
  },
});

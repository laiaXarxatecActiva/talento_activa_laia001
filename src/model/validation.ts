import { InvalidDataError } from './errors.js';

// Validadores de entrada del modelo. Todos lanzan InvalidDataError (→ 400).

/** Texto obligatorio, recortado, de 1..max caracteres. */
export function requiredText(v: unknown, max: number): string {
  if (typeof v !== 'string') throw new InvalidDataError();
  const s = v.trim();
  if (s.length === 0 || s.length > max) throw new InvalidDataError();
  return s;
}

/** Texto opcional: `undefined`/`null`/'' → null; si no, recortado y ≤ max. */
export function optionalText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new InvalidDataError();
  const s = v.trim();
  if (s.length > max) throw new InvalidDataError();
  return s === '' ? null : s;
}

/** Entero en [min, max]. */
export function intInRange(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new InvalidDataError();
  return v;
}

export function boolean(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new InvalidDataError();
  return v;
}

/** Valor de una lista cerrada; opcional (`null`/`undefined` → null). */
export function optionalEnum<T extends string>(v: unknown, values: readonly T[]): T | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new InvalidDataError();
  return v as T;
}

/** Fecha opcional en formato YYYY-MM-DD (y que exista en el calendario). */
export function optionalIsoDate(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new InvalidDataError();
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new InvalidDataError();
  return v;
}

/** URL http(s) opcional y bien formada (≤ 2048). */
export function optionalHttpUrl(v: unknown): string | null {
  const s = optionalText(v, 2048);
  if (s === null) return null;
  return httpUrl(s);
}

/** URL http(s) obligatoria y bien formada (≤ 2048). */
export function httpUrl(v: unknown): string {
  const s = requiredText(v, 2048);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new InvalidDataError();
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.')) {
    throw new InvalidDataError();
  }
  return s;
}

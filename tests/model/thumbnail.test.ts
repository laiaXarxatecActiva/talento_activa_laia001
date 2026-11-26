import { describe, it, expect } from 'vitest';
import { prepareThumbnail, MAX_THUMBNAIL_BYTES } from '../../src/model/project.js';
import { InvalidDataError } from '../../src/model/errors.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PID = '00000000-0000-4000-8000-000000000001';

describe('model/project — prepareThumbnail (reglas de negocio de la miniatura)', () => {
  it('máximo 2 MB', () => {
    expect(MAX_THUMBNAIL_BYTES).toBe(2 * 1024 * 1024);
  });

  it('devuelve tipo detectado y ruta única por proyecto', () => {
    const a = prepareThumbnail(PNG, PID);
    const b = prepareThumbnail(PNG, PID);
    expect(a.type).toBe('image/png');
    expect(a.path).toMatch(new RegExp(`^thumbnails/${PID}-[A-Za-z0-9_-]+\\.png$`));
    expect(a.path).not.toBe(b.path);
  });

  it('rechaza vacío, no-imagen o demasiado grande', () => {
    expect(() => prepareThumbnail(new Uint8Array(), PID)).toThrow(InvalidDataError);
    expect(() => prepareThumbnail(new TextEncoder().encode('<svg/>'), PID)).toThrow(InvalidDataError);
    const big = new Uint8Array(MAX_THUMBNAIL_BYTES + 1);
    big.set(PNG);
    expect(() => prepareThumbnail(big, PID)).toThrow(InvalidDataError);
  });
});

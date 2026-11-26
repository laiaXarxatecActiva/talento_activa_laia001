import { describe, it, expect } from 'vitest';
import { createSupabaseStorage, detectImageType } from '../../src/model/storage.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('model/storage — detectImageType', () => {
  it('reconoce PNG, JPEG y WebP por su firma', () => {
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(WEBP)).toBe('image/webp');
  });

  it('rechaza lo demás (p. ej. SVG o PDF)', () => {
    expect(detectImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});

describe('model/storage — createSupabaseStorage', () => {
  function fake(status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  it('sube el objeto con la service key y devuelve la URL pública', async () => {
    const { calls, f } = fake();
    const storage = createSupabaseStorage({ url: 'https://ref.supabase.co/', serviceKey: 'svc', bucket: 'media', fetch: f });
    const url = await storage.upload('thumbnails/p1.png', PNG, 'image/png');

    expect(url).toBe('https://ref.supabase.co/storage/v1/object/public/media/thumbnails/p1.png');
    expect(calls[0]!.url).toBe('https://ref.supabase.co/storage/v1/object/media/thumbnails/p1.png');
    expect(calls[0]!.init.method).toBe('POST');
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get('Authorization')).toBe('Bearer svc');
    expect(h.get('apikey')).toBe('svc');
    expect(h.get('Content-Type')).toBe('image/png');
  });

  it('lanza si Supabase responde con error', async () => {
    const { f } = fake(400);
    const storage = createSupabaseStorage({ url: 'https://ref.supabase.co', serviceKey: 'svc', bucket: 'media', fetch: f });
    await expect(storage.upload('a.png', PNG, 'image/png')).rejects.toThrow(/400/);
  });

  it('remove borra a partir de la URL pública; ignora URLs ajenas', async () => {
    const { calls, f } = fake();
    const storage = createSupabaseStorage({ url: 'https://ref.supabase.co', serviceKey: 'svc', bucket: 'media', fetch: f });
    await storage.remove('https://ref.supabase.co/storage/v1/object/public/media/thumbnails/p1.png');
    expect(calls[0]!.url).toBe('https://ref.supabase.co/storage/v1/object/media/thumbnails/p1.png');
    expect(calls[0]!.init.method).toBe('DELETE');

    await storage.remove('https://otro.sitio.com/imagen.png');
    expect(calls).toHaveLength(1);
  });
});

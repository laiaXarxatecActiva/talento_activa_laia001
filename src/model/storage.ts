/** Puerto de almacenamiento de archivos (Supabase Storage en producción). */
export interface Storage {
  /** Sube el objeto y devuelve su URL pública. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** Borra el objeto a partir de su URL pública (ignora URLs ajenas). */
  remove(publicUrl: string): Promise<void>;
}

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export const IMAGE_EXTENSIONS: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

/**
 * Tipo de imagen por su firma (magic bytes), sin fiarse de la cabecera.
 * Solo PNG, JPEG y WebP (SVG queda fuera: puede llevar scripts).
 */
export function detectImageType(b: Uint8Array): ImageType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** Supabase Storage vía su API REST, con la service_role key (solo backend). */
export function createSupabaseStorage(opts: {
  url: string;
  serviceKey: string;
  bucket: string;
  fetch?: typeof fetch;
}): Storage {
  const base = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${opts.serviceKey}`, apikey: opts.serviceKey };
  const publicPrefix = `${base}/storage/v1/object/public/${opts.bucket}/`;

  return {
    async upload(path, bytes, contentType) {
      const res = await doFetch(`${base}/storage/v1/object/${opts.bucket}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!res.ok) throw new Error(`Supabase Storage respondió ${res.status}`);
      return `${publicPrefix}${path}`;
    },
    async remove(publicUrl) {
      if (!publicUrl.startsWith(publicPrefix)) return;
      const path = publicUrl.slice(publicPrefix.length);
      const res = await doFetch(`${base}/storage/v1/object/${opts.bucket}/${path}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) throw new Error(`Supabase Storage respondió ${res.status}`);
    },
  };
}

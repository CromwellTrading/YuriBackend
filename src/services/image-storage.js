import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './storage/uploads');
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseServiceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const supabaseBucket = String(process.env.SUPABASE_STORAGE_BUCKET || 'cafeteria-products');
const useSupabaseStorage = Boolean(supabaseUrl && supabaseServiceKey);

function objectUrl(filename) {
  return `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucket)}/${encodeURIComponent(filename)}`;
}

export function publicImageUrl(filename, req) {
  if (!filename) return null;
  if (useSupabaseStorage) {
    return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(supabaseBucket)}/${encodeURIComponent(filename)}`;
  }
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/uploads/${encodeURIComponent(filename)}`;
}

export async function storeProductImage(buffer, mime) {
  const extByMime = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const extension = extByMime[mime];
  if (!extension) throw new Error('Tipo de imagen no admitido.');
  const filename = `${crypto.randomUUID()}.${extension}`;
  if (useSupabaseStorage) {
    const response = await fetch(objectUrl(filename), {
      method: 'POST',
      headers: {
        apikey: supabaseServiceKey,
        Authorization: `Bearer ${supabaseServiceKey}`,
        'Content-Type': mime,
        'x-upsert': 'false',
      },
      body: buffer,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Do not include provider response text because it may contain deployment details.
      throw new Error(`No se pudo guardar la imagen en el almacenamiento (HTTP ${response.status}).`);
    }
  } else {
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, filename), buffer, { flag: 'wx', mode: 0o640 });
  }
  return filename;
}

export async function removeProductImage(filename) {
  if (!filename) return;
  if (useSupabaseStorage) {
    const response = await fetch(objectUrl(filename), {
      method: 'DELETE',
      headers: { apikey: supabaseServiceKey, Authorization: `Bearer ${supabaseServiceKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok && response.status !== 404) throw new Error(`No se pudo eliminar la imagen del almacenamiento (HTTP ${response.status}).`);
    return;
  }
  await fs.unlink(path.join(uploadDir, path.basename(filename))).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

export function imageStorageMode() { return useSupabaseStorage ? 'supabase-storage' : 'local-disk'; }

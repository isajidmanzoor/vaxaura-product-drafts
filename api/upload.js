import { route } from '../lib/http.mjs';
import { uploadMedia, slugify } from '../lib/woo.mjs';

const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
// First bytes of each format: a file is only stored when it really is the photo type it claims.
export function looksLike(mime, buf) {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  return false;
}

// One photo per request as base64 JSON (the browser shrinks it first; Vercel caps bodies at 4.5 MB).
export default route('POST', async (req) => {
  const { name, mime, data } = req.body || {};
  if (!TYPES[mime] || typeof data !== 'string' || !data) throw Object.assign(new Error('Only JPG, PNG and WebP photos can be uploaded.'), { status: 400 });
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 4 * 1024 * 1024) throw Object.assign(new Error('The photo is too large (over 4 MB after resizing).'), { status: 413 });
  if (!looksLike(mime, buf)) throw Object.assign(new Error('That file is not a real JPG, PNG or WebP photo.'), { status: 400 });
  const base = slugify(String(name || 'product-photo').replace(/\.[a-z0-9]+$/i, '')).slice(0, 60) || 'product-photo';
  return uploadMedia(buf, `vaxaura-${base}${TYPES[mime]}`, mime);
});

import { route } from '../lib/http.mjs';
import { uploadMedia, slugify } from '../lib/woo.mjs';

const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// One photo per request as base64 JSON (the browser shrinks it first; Vercel caps bodies at 4.5 MB).
export default route('POST', async (req) => {
  const { name, mime, data } = req.body || {};
  if (!TYPES[mime] || !data) throw Object.assign(new Error('Send a JPG, PNG or WebP photo'), { status: 400 });
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 4 * 1024 * 1024) throw Object.assign(new Error('Photo too large'), { status: 413 });
  const base = slugify(String(name || 'product-photo').replace(/\.[a-z0-9]+$/i, '')).slice(0, 60) || 'product-photo';
  return uploadMedia(buf, `vaxaura-${base}${TYPES[mime]}`, mime);
});

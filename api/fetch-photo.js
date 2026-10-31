import dns from 'node:dns/promises';
import net from 'node:net';
import { route } from '../lib/http.mjs';
import { uploadMedia, slugify } from '../lib/woo.mjs';

// Imports a photo from a link (supplier site, WhatsApp web image, Daraz, another store) into the
// Media Library. The server fetches it, so only public web addresses are allowed (no internal IPs).
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX = 8 * 1024 * 1024;
const RAW_MAX = 4.2 * 1024 * 1024;

export function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
    || (v.startsWith('::ffff:') && isPrivate(v.slice(7)));
}

async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Only http:// and https:// links can be added.'), { status: 400 });
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw Object.assign(new Error('That link does not point to a public website.'), { status: 400 });
}

export default route('POST', async (req, reply) => {
  let url;
  try { url = new URL(String(req.body?.url || '').trim()); } catch { throw Object.assign(new Error('That is not a valid link.'), { status: 400 }); }
  let res;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 VaxauraProductDrafts', Accept: 'image/*' }, signal: AbortSignal.timeout(20000) });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    url = new URL(res.headers.get('location'), url);
  }
  if (!res.ok) throw Object.assign(new Error(`The website answered with an error (HTTP ${res.status}).`), { status: 400 });
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[mime]) throw Object.assign(new Error(`The link is not a JPG/PNG/WebP photo (${mime || 'unknown type'}). Open the photo itself and copy its address.`), { status: 400 });
  if (Number(res.headers.get('content-length') || 0) > MAX) throw Object.assign(new Error('The photo is larger than 8 MB.'), { status: 413 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) throw Object.assign(new Error('The photo is larger than 8 MB.'), { status: 413 });
  let base;
  try { base = decodeURIComponent(url.pathname.split('/').pop() || 'photo'); } catch { base = 'photo'; }
  base = slugify(base.replace(/\.[a-z0-9]+$/i, '')).slice(0, 60) || 'photo';
  // raw: hand the photo back so the browser can add the Vaxaura branding before uploading it.
  // Vercel caps responses at 4.5 MB, so bigger photos are refused with a clear way round.
  if (req.body?.raw) {
    if (buf.length > RAW_MAX) throw Object.assign(new Error('This photo is over 4 MB. Save it to your device and add it with “Choose photos” instead.'), { status: 413 });
    reply.setHeader('Content-Type', mime);
    reply.setHeader('X-File-Name', `${base}${TYPES[mime]}`);
    reply.setHeader('Content-Length', String(buf.length));
    reply.statusCode = 200;
    reply.end(buf);
    return;
  }
  return uploadMedia(buf, `vaxaura-${base}${TYPES[mime]}`, mime);
});

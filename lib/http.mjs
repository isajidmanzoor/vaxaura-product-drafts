// Login (one shared admin password) and small helpers for the API routes (Vercel-style req/res on
// every host: lib/server.mjs for Node, worker.mjs for Cloudflare).

import crypto from 'node:crypto';
import { configure } from './woo.mjs';

// The same protection on every host (vercel.json "headers" has it for Vercel).
export const SECURITY = {
  'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
// server.mjs refuses to start without these; the Cloudflare Worker refuses API calls instead.
export const REQUIRED = ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'VAXAURA_WP_USER', 'VAXAURA_WP_APP_PASSWORD'];
export function setupProblem(env = process.env) {
  const missing = REQUIRED.filter((k) => !String(env[k] || '').trim());
  if (missing.length) return `set ${missing.join(', ')} in the host's environment variables.`;
  if (env.ADMIN_PASSWORD.length < 10) return 'ADMIN_PASSWORD must be at least 10 characters.';
  return '';
}

const COOKIE = 'vx_session';
const MAX_AGE = 30 * 24 * 3600;

// Signed with the admin password and the WordPress application password, so changing either one
// logs every browser out.
const secret = () => `${process.env.ADMIN_PASSWORD || ''}|${process.env.VAXAURA_WP_APP_PASSWORD || ''}`;
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

export function sessionCookie() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function isLoggedIn(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m || !process.env.ADMIN_PASSWORD) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function passwordMatches(given) {
  const want = crypto.createHash('sha256').update(String(process.env.ADMIN_PASSWORD || '')).digest();
  const got = crypto.createHash('sha256').update(String(given || '')).digest();
  return !!process.env.ADMIN_PASSWORD && crypto.timingSafeEqual(want, got);
}

// Wraps a route: method check, login check, WordPress config, JSON errors.
export function route(method, fn, { auth = true } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== method) return res.status(405).json({ error: 'Method not allowed.' });
    if (auth && !isLoggedIn(req)) return res.status(401).json({ error: 'Please sign in.' });
    try {
      if (auth) configure(process.env);
      const out = await fn(req, res);
      if (!res.headersSent) res.status(200).json(out ?? { ok: true });
    } catch (e) {
      console.error(e);
      // A WordPress request that never got an answer ("GET /wc/v3/products: fetch failed") is
      // shown in plain words; the technical detail stays in the server log.
      const unreachable = /^(GET|POST|PUT|DELETE) \/(wp|wc|rankmath)\/\S*: (fetch failed|.*timeout|.*aborted)/i.test(e.message);
      if (unreachable) return res.status(502).json({ error: 'Could not reach vaxaura.com just now. Please try again in a moment.' });
      if (/ -> HTTP 429:/.test(e.message)) return res.status(503).json({ error: 'vaxaura.com is refusing requests for a moment (too many at once). Please wait a minute and try again.' });
      // "POST /wc/v3/products -> HTTP 400: woocommerce_rest_x The message" -> "WordPress said: The message"
      const wp = e.message.match(/^(?:GET|POST|PUT|DELETE) \/\S+ -> HTTP (\d+): (?:[a-z0-9_]+ )?(.*)$/is);
      if (wp) return res.status(Number(wp[1]) >= 500 ? 502 : 400).json({ error: `WordPress could not complete the request: ${wp[2] || `HTTP ${wp[1]}`}` });
      res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message, audit: e.audit });
    }
  };
}

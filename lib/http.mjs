// Login (one shared admin password) and small helpers for the Vercel API routes.

import crypto from 'node:crypto';
import { configure } from './woo.mjs';

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
    if (req.method !== method) return res.status(405).json({ error: 'Method not allowed' });
    if (auth && !isLoggedIn(req)) return res.status(401).json({ error: 'Please log in' });
    try {
      if (auth) configure(process.env);
      const out = await fn(req, res);
      if (!res.headersSent) res.status(200).json(out ?? { ok: true });
    } catch (e) {
      console.error(e);
      res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message, audit: e.audit });
    }
  };
}

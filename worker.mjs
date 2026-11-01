// Cloudflare Workers start (free plan, no card): public/ comes from Workers static assets, api/*.js
// run here with the same Vercel-style req/res as lib/server.mjs gives them on a Node host.
// Settings: wrangler.jsonc "vars" and the secrets typed in Cloudflare's dashboard (process.env).
import { SECURITY, setupProblem } from './lib/http.mjs';
import audit from './api/audit.js';
import context from './api/context.js';
import draft from './api/draft.js';
import fetchPhoto from './api/fetch-photo.js';
import fix from './api/fix.js';
import login from './api/login.js';
import logout from './api/logout.js';
import me from './api/me.js';
import qa from './api/qa.js';
import research from './api/research.js';
import upload from './api/upload.js';
import write from './api/write.js';

export const ROUTES = { audit, context, draft, 'fetch-photo': fetchPhoto, fix, login, logout, me, qa, research, upload, write };
const BODY_MAX = 6 * 1024 * 1024; // as lib/server.mjs

const json = (status, o) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

async function api(request, url, handler) {
  if (Number(request.headers.get('content-length') || 0) > BODY_MAX) return json(413, { error: 'The request is too large.' });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > BODY_MAX) return json(413, { error: 'The request is too large.' });
  const headers = Object.fromEntries(request.headers);
  const req = { method: request.method, url: url.pathname + url.search, headers, query: Object.fromEntries(url.searchParams) };
  const text = new TextDecoder().decode(raw);
  try { req.body = text && /json/.test(headers['content-type'] || '') ? JSON.parse(text) : text; } catch { return json(400, { error: 'The request is not valid JSON.' }); }

  const out = new Headers();
  let body = null, sent = false;
  const res = {
    statusCode: 200,
    get headersSent() { return sent; },
    setHeader(k, v) { out.set(k, String(v)); },
    status(c) { res.statusCode = c; return res; },
    json(o) { out.set('Content-Type', 'application/json'); res.end(JSON.stringify(o)); },
    end(b) { body = b ?? null; sent = true; },
  };
  await handler(req, res);
  out.delete('Content-Length'); // the runtime sets it
  return new Response(body, { status: res.statusCode, headers: out });
}

async function respond(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/\/+$/, '');
    const handler = Object.hasOwn(ROUTES, name) ? ROUTES[name] : null;
    if (!handler) return json(404, { error: 'not found' });
    // No default password on a public address: until the secrets are set, only /api/me answers
    // (it tells the page which ones are missing).
    const problem = name === 'me' ? '' : setupProblem();
    if (problem) return json(503, { error: `The tool is not set up yet: ${problem}` });
    return api(request, url, handler);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const file = await env.ASSETS.fetch(request);
  const r = new Response(file.body, file);
  r.headers.set('Cache-Control', 'no-cache'); // always the latest page after a deploy
  return r;
}

export default {
  async fetch(request, env) {
    let r;
    try {
      r = await respond(request, env);
    } catch (e) {
      console.error(e);
      r = json(500, { error: 'Something went wrong on the server. Please try again.' });
    }
    for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v);
    return r;
  },
};

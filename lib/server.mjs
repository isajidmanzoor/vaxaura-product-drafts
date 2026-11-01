// The whole tool as one Node server: public/ as files and api/*.js with Vercel-style req/res.
// Used by server.mjs (hosting, e.g. Render) and cli/dev-server.mjs (local).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
// The same protection the Vercel deployment had (vercel.json "headers").
const SECURITY = {
  'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
const BODY_MAX = 6 * 1024 * 1024; // photos come as base64 JSON of at most ~140 KB; 6 MB is plenty
const DRAIN_MAX = 50 * 1024 * 1024;

const handlers = new Map();
async function handlerFor(name) {
  if (!handlers.has(name)) {
    const file = path.join(API, `${name}.js`);
    handlers.set(name, fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : null);
  }
  return handlers.get(name);
}

export function createAppServer({ fixtures } = {}) {
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return res.status(400).json({ error: 'Bad address.' }); }
    try {
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5).replace(/\/+$/, '');
        const handler = /^[a-z0-9-]+$/i.test(name) ? await handlerFor(name) : null;
        if (!handler) return res.status(404).json({ error: 'not found' });
        // A too-large body is read to its end and thrown away, then refused (so the browser gets the
        // answer instead of a broken connection); past DRAIN_MAX the connection is simply cut.
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > DRAIN_MAX) return req.socket.destroy();
          if (size <= BODY_MAX) chunks.push(c);
        }
        if (size > BODY_MAX) { res.setHeader('Connection', 'close'); return res.status(413).json({ error: 'The request is too large.' }); }
        const raw = Buffer.concat(chunks).toString();
        try { req.body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw; } catch { return res.status(400).json({ error: 'The request is not valid JSON.' }); }
        req.query = Object.fromEntries(url.searchParams);
        return await handler(req, res);
      }
      // Local browser tests only: `--fixtures <dir>` serves sample photos at /__fixtures/<name>.
      if (fixtures && url.pathname.startsWith('/__fixtures/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
        const f = path.join(fixtures, path.basename(decodeURIComponent(url.pathname)));
        if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
        return fs.createReadStream(f).pipe(res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
      let rel;
      try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { res.statusCode = 400; return res.end(); }
      const file = path.resolve(PUBLIC, '.' + rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache'); // always the latest page after a deploy
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
      else res.end();
    }
  });
  // Research and writing wait on the AI for up to 4.5 minutes.
  server.requestTimeout = 330 * 1000;
  server.headersTimeout = 60 * 1000;
  return server;
}

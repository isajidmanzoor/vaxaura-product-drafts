// Local stand-in for Vercel: serves public/ and runs api/*.js with Vercel-style req/res.
// Env: process.env, plus ~/.vaxaura/credentials.env when present (KEY=value lines).
//   node cli/dev-server.mjs   ->  http://localhost:3000

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRED = path.join(os.homedir(), '.vaxaura', 'credentials.env');
if (fs.existsSync(CRED)) {
  for (const line of fs.readFileSync(CRED, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// Local-only login password; on Vercel ADMIN_PASSWORD must be set in the project settings.
process.env.ADMIN_PASSWORD ||= 'vaxaura-local';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname.startsWith('/api/')) {
    const file = path.join(ROOT, 'api', url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '') + '.js');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    try { req.body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw; } catch { req.body = raw; }
    req.query = Object.fromEntries(url.searchParams);
    const handler = (await import(pathToFileURL(file).href)).default;
    return handler(req, res);
  }
  // `--fixtures <dir>` serves sample photos at /__fixtures/<name> for browser tests (local only).
  const fx = process.argv.indexOf('--fixtures');
  if (fx > 0 && url.pathname.startsWith('/__fixtures/')) {
    const f = path.join(process.argv[fx + 1], path.basename(decodeURIComponent(url.pathname)));
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    return fs.createReadStream(f).pipe(res);
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT || 3000), () => console.log(`http://localhost:${process.env.PORT || 3000}`));

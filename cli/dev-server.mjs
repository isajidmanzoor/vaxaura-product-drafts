// Local server: the same app as server.mjs (lib/server.mjs), for this computer only.
// Env: process.env, plus ~/.vaxaura/credentials.env when present (KEY=value lines).
//   node cli/dev-server.mjs [--fixtures <dir>]   ->  http://localhost:3000

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../lib/server.mjs';

const CRED = path.join(os.homedir(), '.vaxaura', 'credentials.env');
if (fs.existsSync(CRED)) {
  for (const line of fs.readFileSync(CRED, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// Local-only login password; a hosted copy must set ADMIN_PASSWORD (server.mjs refuses to start without it).
process.env.ADMIN_PASSWORD ||= 'vaxaura-local';

const fx = process.argv.indexOf('--fixtures');
const port = Number(process.env.PORT || 3000);
// Only this computer can open it.
createAppServer({ fixtures: fx > 0 ? process.argv[fx + 1] : null }).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));

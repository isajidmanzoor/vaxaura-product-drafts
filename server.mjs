// Production start (e.g. Render): `node server.mjs`. Settings come only from the environment;
// the server refuses to start without them (no default password on a public address).
import { createAppServer } from './lib/server.mjs';

const REQUIRED = ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'VAXAURA_WP_USER', 'VAXAURA_WP_APP_PASSWORD'];
const missing = REQUIRED.filter((k) => !String(process.env[k] || '').trim());
if (missing.length) {
  console.error(`Not started: set ${missing.join(', ')} in the host's environment variables.`);
  process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 10) {
  console.error('Not started: ADMIN_PASSWORD must be at least 10 characters.');
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
createAppServer().listen(port, '0.0.0.0', () => console.log(`Vaxaura Product Drafts listening on port ${port}`));

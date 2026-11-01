// Production start (e.g. Render): `node server.mjs`. Settings come only from the environment;
// the server refuses to start without them (no default password on a public address).
import { createAppServer } from './lib/server.mjs';
import { setupProblem } from './lib/http.mjs';

const problem = setupProblem();
if (problem) {
  console.error(`Not started: ${problem}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
createAppServer().listen(port, '0.0.0.0', () => console.log(`Vaxaura Product Drafts listening on port ${port}`));

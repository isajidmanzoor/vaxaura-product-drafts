import { route } from '../lib/http.mjs';
import { createDraft } from '../lib/woo.mjs';

// Saves the listing as a DRAFT. createDraft never publishes.
export default route('POST', async (req) => {
  const p = req.body?.product;
  if (!p) throw Object.assign(new Error('No product'), { status: 400 });
  delete p.status;
  return createDraft(p);
});

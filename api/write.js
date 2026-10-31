import { route } from '../lib/http.mjs';
import { storeContext } from '../lib/woo.mjs';
import { write } from '../lib/ai.mjs';

// One AI round per request (stays under Vercel's 300 s); send `previous` back to repair SEO failures,
// or `current` (the edited listing) to fix its keywords and copy from the review page.
export default route('POST', async (req) => {
  const deadline = Date.now() + 270000;
  const { mediaIds, hints, notes, previous, current, market, facts } = req.body || {};
  if (!Array.isArray(mediaIds) || !mediaIds.length || !notes) throw Object.assign(new Error('The research step has not run yet.'), { status: 400 });
  return write({ mediaIds, hints, notes, previous, current, market, facts, deadline, ctx: await storeContext() });
});

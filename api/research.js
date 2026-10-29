import { route } from '../lib/http.mjs';
import { storeContext } from '../lib/woo.mjs';
import { research } from '../lib/ai.mjs';

export default route('POST', async (req) => {
  const deadline = Date.now() + 270000;
  const { mediaIds, hints } = req.body || {};
  if (!Array.isArray(mediaIds) || !mediaIds.length) throw Object.assign(new Error('Upload photos first'), { status: 400 });
  return research({ mediaIds, hints, deadline, ctx: await storeContext() });
});

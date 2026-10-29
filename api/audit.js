import { route } from '../lib/http.mjs';
import { seoAudit, usedFocusKeywords, validate } from '../lib/woo.mjs';

// Live SEO score while the owner edits the listing.
export default route('POST', async (req) => {
  const p = req.body?.product;
  if (!p) throw Object.assign(new Error('No product'), { status: 400 });
  p.images = (p.images || []).map((i) => ({ ...i, update_media: true }));
  return { audit: seoAudit(p, { usedFocus: await usedFocusKeywords() }), errors: validate(p) };
});

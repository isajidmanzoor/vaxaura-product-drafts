import { route } from '../lib/http.mjs';
import { seoAudit, shopKeywords, validate } from '../lib/woo.mjs';

// Live SEO score while the owner edits the listing, with the keyword clashes against the shop.
export default route('POST', async (req) => {
  const p = req.body?.product;
  if (!p) throw Object.assign(new Error('No product data was sent.'), { status: 400 });
  p.images = (p.images || []).map((i) => ({ ...i, update_media: true }));
  return { audit: seoAudit(p, { shop: await shopKeywords() }), errors: validate(p) };
});

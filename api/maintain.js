import { route } from '../lib/http.mjs';
import { photoPlan, applyPhotos, undoPhotos, skuPlan, applySkus, undoSku } from '../lib/maintenance.mjs';

// Shop maintenance for products already in the shop: photos (to WebP under 100 KB) and SKUs.
// Plans change nothing; apply/undo run only after the owner confirmed in the browser.
const ACTIONS = { 'photos-plan': photoPlan, 'photos-apply': applyPhotos, 'photos-undo': undoPhotos, 'sku-plan': skuPlan, 'sku-apply': applySkus, 'sku-undo': undoSku };

export default route('POST', async (req) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const run = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!run) throw Object.assign(new Error('Unknown action.'), { status: 400 });
  return run(body);
});

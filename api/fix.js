import { route } from '../lib/http.mjs';
import { previewFix, applyFix, undoFix } from '../lib/fix.mjs';
import { photoPlan, applyPhotos, undoPhotos, skuPlan, applySkus, undoSku } from '../lib/maintenance.mjs';

// Fixes for products already in the shop (one route: Vercel's plan allows 12 functions).
// Keyword: 'preview' changes nothing; 'apply' (after the owner confirmed in the browser) saves it
// with a backup; 'undo' restores the backup. Photos and SKUs: 'photos-plan' / 'sku-plan' change
// nothing; '…-apply' and '…-undo' run only after the owner confirmed.
const ACTIONS = {
  preview: ({ id, keyword, edits }) => previewFix({ id, keyword, edits }),
  apply: ({ id, keyword, edits, modified }) => applyFix({ id, keyword, edits, modified }),
  undo: ({ id }) => undoFix({ id }),
  'photos-plan': photoPlan, 'photos-apply': applyPhotos, 'photos-undo': undoPhotos,
  'sku-plan': skuPlan, 'sku-apply': applySkus, 'sku-undo': undoSku,
};

export default route('POST', async (req) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const run = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!run) throw Object.assign(new Error('Unknown action.'), { status: 400 });
  return run(body);
});

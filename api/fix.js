import { route } from '../lib/http.mjs';
import { previewFix, applyFix, undoFix } from '../lib/fix.mjs';

// Keyword fix for a product already in the shop: { action: 'preview' } changes nothing; 'apply'
// (after the owner confirmed in the browser) saves it with a backup; 'undo' restores the backup.
export default route('POST', async (req) => {
  const { action, id, keyword, edits, modified } = req.body || {};
  if (action === 'preview') return previewFix({ id, keyword, edits });
  if (action === 'apply') return applyFix({ id, keyword, edits, modified });
  if (action === 'undo') return undoFix({ id });
  throw Object.assign(new Error('Unknown action.'), { status: 400 });
});

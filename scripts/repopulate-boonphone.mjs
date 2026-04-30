/**
 * Re-populate Boonphone collected cache after Phase 126 fix.
 * Run: node scripts/repopulate-boonphone.mjs
 */
import { populateDebtCache } from '../server/sync/populateCache.js';

console.log('[repopulate] Starting Boonphone collected cache rebuild...');
const start = Date.now();
try {
  const result = await populateDebtCache('Boonphone');
  console.log(`[repopulate] Done in ${Date.now() - start}ms:`, JSON.stringify(result));
} catch (err) {
  console.error('[repopulate] Error:', err.message);
  process.exit(1);
}

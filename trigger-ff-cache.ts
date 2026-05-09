/**
 * trigger-ff-cache.ts
 * Manually trigger populateDebtCache for Fastfone365 directly
 * Usage: pnpm tsx trigger-ff-cache.ts
 */
import { populateDebtCache } from "./server/sync/populateCache";

console.log("[trigger-ff-cache] Starting populateDebtCache for Fastfone365...");
const start = Date.now();

try {
  const result = await populateDebtCache("Fastfone365");
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[trigger-ff-cache] Done in ${elapsed}s — target=${result.targetRows}, collected=${result.collectedRows}`);
} catch (err: any) {
  console.error("[trigger-ff-cache] Failed:", err?.message ?? err);
  process.exit(1);
}

process.exit(0);

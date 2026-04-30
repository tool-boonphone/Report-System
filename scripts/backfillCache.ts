/**
 * backfillCache.ts — One-time script to populate debt_target_cache and
 * debt_collected_cache for all sections.
 *
 * Usage:
 *   npx tsx scripts/backfillCache.ts
 */
import { populateDebtCache } from "../server/sync/populateCache";
import { SECTIONS } from "../shared/const";

async function main() {
  for (const section of SECTIONS) {
    console.log(`\n[backfill] Starting ${section}...`);
    const start = Date.now();
    try {
      const result = await populateDebtCache(section);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[backfill] ${section} done in ${elapsed}s — target=${result.targetRows}, collected=${result.collectedRows}`,
      );
    } catch (err: any) {
      console.error(`[backfill] ${section} FAILED:`, err?.message ?? err);
    }
  }
  console.log("\n[backfill] All sections complete.");
  process.exit(0);
}

main();

/**
 * backfillCache.mjs — One-time script to populate debt_target_cache and
 * debt_collected_cache for all sections.
 *
 * Usage:
 *   node scripts/backfillCache.mjs
 *
 * Requires DATABASE_URL to be set in the environment (loaded from .env automatically).
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { register } from "tsx/esm";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

// Use tsx to handle TypeScript imports
register();

const { populateDebtCache } = await import("../server/sync/populateCache.ts");

const SECTIONS = ["Boonphone", "Fastfone365"];

for (const section of SECTIONS) {
  console.log(`\n[backfill] Starting ${section}...`);
  const start = Date.now();
  try {
    const result = await populateDebtCache(section);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[backfill] ${section} done in ${elapsed}s — target=${result.targetRows}, collected=${result.collectedRows}`,
    );
  } catch (err) {
    console.error(`[backfill] ${section} FAILED:`, err);
  }
}

console.log("\n[backfill] All sections complete.");
process.exit(0);

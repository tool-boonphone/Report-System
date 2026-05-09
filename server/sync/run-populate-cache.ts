/**
 * run-populate-cache.ts — Trigger populateDebtCache for both sections
 * Usage: npx tsx server/sync/run-populate-cache.ts [section]
 *   section: "Fastfone365" | "Boonphone" | "all" (default: "all")
 */
import { populateDebtCache } from "./populateCache";
import type { SectionKey } from "../../shared/const";

const arg = process.argv[2] ?? "all";

async function main() {
  const sections: SectionKey[] = arg === "all"
    ? ["Fastfone365", "Boonphone"]
    : [arg as SectionKey];

  for (const section of sections) {
    console.log(`\n[Populate Cache] Starting ${section}...`);
    try {
      const result = await populateDebtCache(section);
      console.log(`[Populate Cache] ✅ ${section} completed — target: ${result.targetRows}, collected: ${result.collectedRows}`);
    } catch (err) {
      console.error(`[Populate Cache] ❌ ${section} failed:`, err);
    }
  }
  console.log("\n[Populate Cache] All done.");
  process.exit(0);
}

main();

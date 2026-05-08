/**
 * runPopulate.ts — Run populate cache manually for a section
 * Usage: npx tsx scripts/runPopulate.ts [Fastfone365|Boonphone|all]
 */
import { populateDebtCache } from "../server/sync/populateCache";
import type { SectionKey } from "../shared/const";

const arg = process.argv[2] ?? "all";
const sections: SectionKey[] = arg === "all" ? ["Fastfone365", "Boonphone"] : [arg as SectionKey];

async function main() {
  for (const section of sections) {
    console.log(`\n[runPopulate] Starting ${section}...`);
    const start = Date.now();
    const result = await populateDebtCache(section);
    console.log(`[runPopulate] ${section} done in ${Date.now() - start}ms:`, result);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[runPopulate] Error:", e);
  process.exit(1);
});

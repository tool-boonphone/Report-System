/**
 * Manual sync script — รัน sync สำหรับทั้ง Fastfone365 และ Boonphone
 * Usage: npx tsx server/sync/run-manual-sync.ts [section]
 *   section: "Fastfone365" | "Boonphone" | "all" (default: "all")
 */
import { runSectionSync } from "./runner";
import type { SectionKey } from "../../shared/const";

const arg = process.argv[2] ?? "all";

async function main() {
  const sections: SectionKey[] = arg === "all"
    ? ["Fastfone365", "Boonphone"]
    : [arg as SectionKey];

  for (const section of sections) {
    console.log(`\n[Manual Sync] Starting ${section}...`);
    try {
      await runSectionSync(section, "manual");
      console.log(`[Manual Sync] ✅ ${section} completed`);
    } catch (err) {
      console.error(`[Manual Sync] ❌ ${section} failed:`, err);
    }
  }

  console.log("\n[Manual Sync] All done.");
  process.exit(0);
}

main();

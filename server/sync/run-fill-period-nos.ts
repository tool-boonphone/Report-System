/**
 * run-fill-period-nos.ts — Backfill period_no/sub_no for payment_transactions
 * Usage: npx tsx server/sync/run-fill-period-nos.ts [section]
 *   section: "Fastfone365" | "Boonphone" | "all" (default: "all")
 */
import { fillPeriodNosForSection } from "./fillPeriodNos";
import type { SectionKey } from "../../shared/const";

const arg = process.argv[2] ?? "all";

async function main() {
  const sections: SectionKey[] = arg === "all"
    ? ["Fastfone365", "Boonphone"]
    : [arg as SectionKey];

  for (const section of sections) {
    console.log(`\n[FillPeriodNos] Starting ${section}...`);
    try {
      const count = await fillPeriodNosForSection(section);
      console.log(`[FillPeriodNos] ✅ ${section} completed — updated ${count} rows`);
    } catch (err) {
      console.error(`[FillPeriodNos] ❌ ${section} failed:`, err);
    }
  }
  console.log("\n[FillPeriodNos] All done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

/**
 * Script ทดสอบ getMonthlyDebtSummary function
 */
import { getMonthlyDebtSummary } from "../server/monthlyTargetDetailSnapshotDb.js";
import type { SectionKey } from "../server/shared/const.js";

async function test(section: SectionKey) {
  console.log(`\n[${section}] Testing getMonthlyDebtSummary...`);
  try {
    const result = await getMonthlyDebtSummary(section);
    if (result.length === 0) {
      console.log(`  [${section}] No data returned`);
    } else {
      for (const row of result) {
        console.log(`  ${row.snapshotMonth}: target=${row.targetAmount.toLocaleString()} collected=${row.collectedAmount.toLocaleString()} pct=${row.percentage.toFixed(1)}% rows=${row.rowCount}`);
      }
    }
  } catch (err) {
    console.error(`  [${section}] Error:`, err);
  }
}

(async () => {
  await test("Boonphone");
  await test("Fastfone365");
  process.exit(0);
})();

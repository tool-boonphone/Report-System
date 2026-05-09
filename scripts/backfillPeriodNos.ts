/**
 * backfillPeriodNos.ts
 *
 * One-time backfill: คำนวณ period_no/sub_no สำหรับ payment_transactions ทั้งหมด
 * Run: npx tsx scripts/backfillPeriodNos.ts
 */
import "dotenv/config";
import { fillPeriodNosAll } from "../server/sync/fillPeriodNos";

async function main() {
  console.log("=== Backfill period_no/sub_no ===");
  console.log("Start:", new Date().toISOString());
  await fillPeriodNosAll();
  console.log("Done:", new Date().toISOString());
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

/**
 * snapshot-only.ts
 *
 * Script สำหรับรัน Steps 6-7 เท่านั้น (monthly_collection_snapshot + monthly_target_detail_snapshot)
 * ใช้เมื่อ debt_target_cache มีข้อมูลครบแล้ว และต้องการทำ snapshot โดยตรง
 *
 * ใช้งาน:
 *   faketime '2026-06-01 00:00:00' npx tsx server/sync/snapshot-only.ts Fastfone365
 */

import { normalizeSectionKey } from "../../shared/const";
import { populateMonthlyCollectionSnapshot } from "../monthlyCollectionSnapshotDb";
import { populateTargetDetailSnapshot as populateMonthlyTargetDetailSnapshot } from "../monthlyTargetDetailSnapshotDb";

// ── ตรวจสอบ argument ──────────────────────────────────────────────────────────
let section: "Boonphone" | "Fastfone365";
try {
  section = normalizeSectionKey(process.argv[2] || "") as "Boonphone" | "Fastfone365";
} catch {
  console.error("Usage: npx tsx server/sync/snapshot-only.ts <boonphone|fastfone|Boonphone|Fastfone365>");
  process.exit(1);
}

// ── ตรวจสอบวันที่ปัจจุบัน ──────────────────────────────────────────────────
const now = new Date();
const bangkokDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);

const dayOfMonth = parseInt(bangkokDate.slice(8, 10), 10);
const currentMonth = bangkokDate.slice(0, 7); // "YYYY-MM"

console.log(`\n========================================`);
console.log(`[snapshot-only] section: ${section}`);
console.log(`[snapshot-only] simulated date: ${bangkokDate} (Bangkok)`);
console.log(`[snapshot-only] dayOfMonth: ${dayOfMonth}`);
console.log(`[snapshot-only] currentMonth: ${currentMonth}`);
console.log(`[snapshot-only] raw Date.now(): ${now.toISOString()}`);
console.log(`========================================\n`);

async function main() {
  try {
    // ── Step 6: Populate monthly_collection_snapshot ────────────────────────
    const snapshotCutoffMode = "end_of_month";
    console.log(`\n[Step 6] Populate monthly_collection_snapshot (cutoffMode=${snapshotCutoffMode})...`);
    const snapshotRows = await populateMonthlyCollectionSnapshot(section, (current, total) => {
      process.stdout.write(`\r  ${current}/${total}`);
    }, snapshotCutoffMode);
    console.log(`\n  ✓ monthly_collection_snapshot: ${snapshotRows} months`);

    // ── Step 7: Populate monthly_target_detail_snapshot ─────────────────────
    const autoSnapshotFilterState = JSON.stringify({
      search: "",
      statusFilter: [],
      approveDateFilter: [],
      dueDateFilter: [],
      productTypeFilter: [],
      dueDateExact: "",
      debtSetMode: true,
      debtSetCutoffMode: "end_of_month",
      principalOnly: true,
    });

    console.log(`\n[Step 7] Populate monthly_target_detail_snapshot for ${currentMonth} (end_of_month mode)...`);
    const detailRows = await populateMonthlyTargetDetailSnapshot(
      section,
      currentMonth,
      "end_of_month",
      true,  // filterDebtOnly
      true,  // filterPrincipalOnly
      autoSnapshotFilterState,
    );
    console.log(`  ✓ monthly_target_detail_snapshot: ${detailRows} rows for ${currentMonth}`);

    // ── สรุปผล ───────────────────────────────────────────────────────────────
    console.log(`\n========================================`);
    console.log(`[snapshot-only] COMPLETED for ${section}`);
    console.log(`  Month: ${currentMonth}`);
    console.log(`  monthly_collection_snapshot: ${snapshotRows} months`);
    console.log(`  monthly_target_detail_snapshot: ${detailRows} rows`);
    console.log(`========================================\n`);

    process.exit(0);
  } catch (err: any) {
    console.error(`\n[snapshot-only] FATAL ERROR:`, err?.message ?? err);
    console.error(err?.stack);
    process.exit(1);
  }
}

main();

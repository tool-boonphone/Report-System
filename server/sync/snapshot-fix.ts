/**
 * snapshot-fix.ts
 *
 * Script สำหรับ populate cache + snapshot สำหรับเดือนที่ต้องการ
 * โดยไม่ต้อง sync จาก API — ใช้ข้อมูลที่มีอยู่ใน DB เท่านั้น
 *
 * ใช้งาน:
 *   faketime '2026-06-01 00:00:00' npx tsx server/sync/snapshot-fix.ts boonphone
 *   faketime '2026-06-01 00:00:00' npx tsx server/sync/snapshot-fix.ts fastfone
 *
 * หมายเหตุ: ต้องรันด้วย faketime เพื่อให้ new Date() = 2026-06-01
 *           เพราะ populate functions ใช้ new Date() ในการคำนวณ
 */

import { populateDebtCache } from "./populateCache";
import { normalizeSectionKey } from "../../shared/const";
import { rebuildIncomeMonthlySummary, populateIncomeType } from "../accountingDb";
import { populateMonthlySummaryCache, populateDueMonthCache } from "../monthlySummaryDb";
import { populateMonthlyCollectionSnapshot } from "../monthlyCollectionSnapshotDb";
import { populateTargetDetailSnapshot as populateMonthlyTargetDetailSnapshot } from "../monthlyTargetDetailSnapshotDb";

// ── ตรวจสอบ argument ──────────────────────────────────────────────────────────
let section: "Boonphone" | "Fastfone365";
try {
  section = normalizeSectionKey(process.argv[2] || "") as "Boonphone" | "Fastfone365";
} catch {
  console.error("Usage: npx tsx server/sync/snapshot-fix.ts <boonphone|fastfone|Boonphone|Fastfone365>");
  process.exit(1);
}

// ── ตรวจสอบวันที่ปัจจุบัน (ต้องเป็น 2026-06-01 ถ้าใช้ faketime) ──────────────
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
console.log(`[snapshot-fix] section: ${section}`);
console.log(`[snapshot-fix] simulated date: ${bangkokDate} (Bangkok)`);
console.log(`[snapshot-fix] dayOfMonth: ${dayOfMonth}`);
console.log(`[snapshot-fix] currentMonth: ${currentMonth}`);
console.log(`[snapshot-fix] raw Date.now(): ${now.toISOString()}`);
console.log(`========================================\n`);

if (dayOfMonth !== 1) {
  console.warn(`[snapshot-fix] WARNING: dayOfMonth = ${dayOfMonth} (ไม่ใช่วันที่ 1)`);
  console.warn(`[snapshot-fix] ควรรันด้วย faketime '2026-06-01 00:00:00' เพื่อให้ snapshot ถูกต้อง`);
  console.warn(`[snapshot-fix] กำลังดำเนินการต่อ...`);
}

async function main() {
  try {
    // ── Step 1: Populate debt_target_cache ──────────────────────────────────
    console.log(`\n[Step 1] Populate debt_target_cache...`);
    const cacheResult = await populateDebtCache(section, (phase, current, total) => {
      process.stdout.write(`\r  [${phase}] ${current}/${total}`);
    });
    console.log(`\n  ✓ debt_target_cache: target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);

    // ── Step 2: Populate income_type ────────────────────────────────────────
    console.log(`\n[Step 2] Populate income_type...`);
    const incomeTypeRows = await populateIncomeType(section);
    console.log(`  ✓ income_type: ${incomeTypeRows} rows`);

    // ── Step 3: Rebuild income_monthly_summary ──────────────────────────────
    console.log(`\n[Step 3] Rebuild income_monthly_summary...`);
    const summaryRows = await rebuildIncomeMonthlySummary(section);
    console.log(`  ✓ income_monthly_summary: ${summaryRows} rows`);

    // ── Step 4: Populate monthly_summary_cache ──────────────────────────────
    console.log(`\n[Step 4] Populate monthly_summary_cache...`);
    let msCacheRows = 0;
    try {
      msCacheRows = await populateMonthlySummaryCache(section, (current, total) => {
        process.stdout.write(`\r  ${current}/${total}`);
      });
      console.log(`\n  ✓ monthly_summary_cache: ${msCacheRows} rows`);
    } catch (step4Err: any) {
      console.warn(`\n  ⚠ Step 4 failed (non-fatal): ${step4Err?.message ?? step4Err}`);
      console.warn(`  ⚠ ข้าม Step 4 และดำเนินการต่อที่ Step 5...`);
    }

    // ── Step 5: Populate monthly_summary_due_month_cache ────────────────────
    console.log(`\n[Step 5] Populate monthly_summary_due_month_cache...`);
    let dmCacheRows = 0;
    try {
      dmCacheRows = await populateDueMonthCache(section, (current, total) => {
        process.stdout.write(`\r  ${current}/${total}`);
      });
      console.log(`\n  ✓ monthly_summary_due_month_cache: ${dmCacheRows} rows`);
    } catch (step5Err: any) {
      console.warn(`\n  ⚠ Step 5 failed (non-fatal): ${step5Err?.message ?? step5Err}`);
      console.warn(`  ⚠ ข้าม Step 5 และดำเนินการต่อที่ Step 6...`);
    }

    // ── Step 6: Populate monthly_collection_snapshot ────────────────────────
    // วันที่ 1 → end_of_month mode (นับงวดทั้งเดือน)
    const snapshotCutoffMode = dayOfMonth === 1 ? "end_of_month" : "today";
    console.log(`\n[Step 6] Populate monthly_collection_snapshot (cutoffMode=${snapshotCutoffMode})...`);
    const snapshotRows = await populateMonthlyCollectionSnapshot(section, (current, total) => {
      process.stdout.write(`\r  ${current}/${total}`);
    }, snapshotCutoffMode);
    console.log(`\n  ✓ monthly_collection_snapshot: ${snapshotRows} months`);

    // ── Step 7: Populate monthly_target_detail_snapshot ─────────────────────
    // วันที่ 1 → end_of_month mode, debtSetMode=true, principalOnly=true
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
    console.log(`[snapshot-fix] COMPLETED for ${section}`);
    console.log(`  Month: ${currentMonth}`);
    console.log(`  debt_target_cache: ${cacheResult.targetRows} target, ${cacheResult.collectedRows} collected`);
    console.log(`  monthly_collection_snapshot: ${snapshotRows} months`);
    console.log(`  monthly_target_detail_snapshot: ${detailRows} rows`);
    console.log(`========================================\n`);

    process.exit(0);
  } catch (err: any) {
    console.error(`\n[snapshot-fix] FATAL ERROR:`, err?.message ?? err);
    console.error(err?.stack);
    process.exit(1);
  }
}

main();

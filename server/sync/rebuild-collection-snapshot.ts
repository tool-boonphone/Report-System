/**
 * rebuild-collection-snapshot.ts
 *
 * Script สำหรับรัน Step 6 เท่านั้น (monthly_collection_snapshot)
 * ไม่รัน Step 7 (monthly_target_detail_snapshot) เพื่อป้องกันการ overwrite ข้อมูลที่ restore มา
 *
 * ใช้งาน:
 *   faketime '2026-06-01 00:00:00' npx tsx server/sync/rebuild-collection-snapshot.ts Fastfone365
 *   faketime '2026-06-01 00:00:00' npx tsx server/sync/rebuild-collection-snapshot.ts Boonphone
 */
import { normalizeSectionKey } from "../../shared/const";
import { populateMonthlyCollectionSnapshot } from "../monthlyCollectionSnapshotDb";

// ── ตรวจสอบ argument ──────────────────────────────────────────────────────────
let section: "Boonphone" | "Fastfone365";
try {
  section = normalizeSectionKey(process.argv[2] || "") as "Boonphone" | "Fastfone365";
} catch {
  console.error("Usage: npx tsx server/sync/rebuild-collection-snapshot.ts <boonphone|fastfone|Boonphone|Fastfone365>");
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
const currentMonth = bangkokDate.slice(0, 7); // "YYYY-MM"

console.log(`\n========================================`);
console.log(`[rebuild-collection-snapshot] section: ${section}`);
console.log(`[rebuild-collection-snapshot] simulated date: ${bangkokDate} (Bangkok)`);
console.log(`[rebuild-collection-snapshot] currentMonth: ${currentMonth}`);
console.log(`[rebuild-collection-snapshot] raw Date.now(): ${now.toISOString()}`);
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

    // ── สรุปผล ───────────────────────────────────────────────────────────────
    console.log(`\n========================================`);
    console.log(`[rebuild-collection-snapshot] COMPLETED for ${section}`);
    console.log(`  Month: ${currentMonth}`);
    console.log(`  monthly_collection_snapshot: ${snapshotRows} months`);
    console.log(`  NOTE: monthly_target_detail_snapshot was NOT modified`);
    console.log(`========================================\n`);
    process.exit(0);
  } catch (err: any) {
    console.error(`\n[rebuild-collection-snapshot] FATAL ERROR:`, err?.message ?? err);
    console.error(err?.stack);
    process.exit(1);
  }
}

main();

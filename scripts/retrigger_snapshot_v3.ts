/**
 * retrigger_snapshot_v3.ts
 * ลบ snapshot เดิมและ trigger ใหม่ทั้ง Boonphone และ Fastfone365
 * โดยใช้ targetAmount จาก SUM(total_amount) ใน debt_target_cache (end_of_month filter)
 * เพื่อให้ตรงกับ badge ยอดหนี้รวมที่เห็นบนหน้าจอ
 */
import { sql } from "drizzle-orm";
import { getDb, pgRows } from "../server/db";
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";
import { populateMonthlyCollectionSnapshot } from "../server/monthlyCollectionSnapshotDb";
import type { SectionKey } from "../shared/const";

function n(v: unknown): number {
  const num = parseFloat(String(v ?? "0"));
  return isNaN(num) ? 0 : num;
}

async function resetAndTrigger(section: SectionKey, snapshotMonth: string) {
  const db = await getDb(section);
  if (!db) { console.error(`[${section}] DB not found`); return; }

  console.log(`\n=== ${section} ===`);

  // 1. ลบ snapshot เดิม
  await db.execute(sql.raw(`DELETE FROM monthly_target_detail_snapshot WHERE section = '${section}' AND snapshot_month = '${snapshotMonth}'`));
  await db.execute(sql.raw(`DELETE FROM monthly_collection_snapshot WHERE section = '${section}' AND collection_month = '${snapshotMonth}'`));
  console.log(`[${section}] Deleted old snapshots for ${snapshotMonth}`);

  // 2. คำนวณ targetAmount จาก debt_target_cache
  // ใช้ due_date <= สิ้นเดือน (end_of_month) + ไม่รวมงวดที่ชำระครบแล้ว (isPaid)
  const [year, month] = snapshotMonth.split("-").map(Number);
  const lastDay = new Date(year, month, 0);
  const endOfMonth = `${year}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}`;

  const targetResult = await db.execute(sql.raw(`
    SELECT
      COALESCE(SUM(COALESCE(principal::numeric, 0) + COALESCE(interest::numeric, 0) + COALESCE(fee::numeric, 0)), 0) AS target_amount
    FROM debt_target_cache
    WHERE section = '${section}'
      AND due_date::date <= '${endOfMonth}'::date
      AND COALESCE(is_paid, FALSE) = FALSE
      AND COALESCE(is_closed, FALSE) = FALSE
      AND COALESCE(is_suspended, FALSE) = FALSE
  `));
  const targetRows = pgRows(targetResult);
  const targetAmount = n(targetRows[0]?.target_amount ?? 0);
  console.log(`[${section}] Calculated targetAmount = ${targetAmount.toLocaleString()}`);

  // 3. Populate monthly_collection_snapshot ด้วย end_of_month mode
  // signature: populateMonthlyCollectionSnapshot(section, onProgress?, cutoffMode)
  await populateMonthlyCollectionSnapshot(section, undefined, "end_of_month");

  // 4. Populate monthly_target_detail_snapshot + upsert targetAmount
  const filterState = JSON.stringify({
    search: "",
    statusFilter: [],
    approveDateFilter: "",
    dueDateFilter: [],
    productTypeFilter: [],
    dueDateExact: "",
    debtSetMode: true,
    debtSetCutoffMode: "end_of_month",
    principalOnly: true,
  });

  const inserted = await populateTargetDetailSnapshot(
    section,
    snapshotMonth,
    "end_of_month",
    true,   // filterDebtOnly
    true,   // filterPrincipalOnly
    filterState,
    // ไม่ส่ง clientTargetAmount → ใช้ target_amount ที่ populateMonthlyCollectionSnapshot คำนวณไว้แล้ว
  );

  console.log(`[${section}] Inserted ${inserted} detail rows`);
  console.log(`[${section}] Done ✅`);
}

async function main() {
  const snapshotMonth = "2026-06";
  await resetAndTrigger("Boonphone", snapshotMonth);
  await resetAndTrigger("Fastfone365", snapshotMonth);
  console.log("\n=== All Done ===");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

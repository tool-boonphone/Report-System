/**
 * debug_snapshot.ts
 * ตรวจสอบว่า monthly_target_detail_snapshot บันทึกข้อมูลอะไรบ้าง
 * และ debt_target_cache มีโครงสร้างอย่างไร
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { pgRows } from "../server/db";

async function main() {
  const db = await getDb("Boonphone");
  if (!db) { console.log("No DB"); return; }

  // 1. ดู sample rows จาก monthly_target_detail_snapshot
  console.log("\n=== Sample rows from monthly_target_detail_snapshot (2026-06) ===");
  const sample = await db.execute(sql.raw(`
    SELECT snapshot_month, due_date, total_amount, paid_amount,
           GREATEST(COALESCE(total_amount,0) - COALESCE(paid_amount,0), 0) as remaining
    FROM monthly_target_detail_snapshot
    WHERE section = 'Boonphone' AND snapshot_month = '2026-06'
    LIMIT 5
  `));
  pgRows(sample).forEach((r: any) => console.log(r));

  // 2. นับ distinct due_date months ใน snapshot 2026-06
  console.log("\n=== Distinct due_date months in snapshot 2026-06 ===");
  const months = await db.execute(sql.raw(`
    SELECT TO_CHAR(due_date::date, 'YYYY-MM') as due_month, COUNT(*) as cnt,
           SUM(GREATEST(COALESCE(total_amount,0) - COALESCE(paid_amount,0), 0)) as total_remaining
    FROM monthly_target_detail_snapshot
    WHERE section = 'Boonphone' AND snapshot_month = '2026-06'
    GROUP BY TO_CHAR(due_date::date, 'YYYY-MM')
    ORDER BY due_month
  `));
  pgRows(months).forEach((r: any) => console.log(r));

  // 3. ดู debt_target_cache structure
  console.log("\n=== debt_target_cache columns ===");
  const cols = await db.execute(sql.raw(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'debt_target_cache'
    ORDER BY ordinal_position
    LIMIT 20
  `));
  pgRows(cols).forEach((r: any) => console.log(r));

  // 4. ดูว่า debt_target_cache มี target_amount column หรือไม่
  console.log("\n=== Sample debt_target_cache rows (ตั้งหนี้เดือน 2026-06) ===");
  const targetCache = await db.execute(sql.raw(`
    SELECT *
    FROM debt_target_cache
    WHERE section = 'Boonphone'
    LIMIT 3
  `));
  if (pgRows(targetCache).length > 0) {
    console.log("Columns:", Object.keys(pgRows(targetCache)[0]));
    pgRows(targetCache).forEach((r: any) => console.log(r));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

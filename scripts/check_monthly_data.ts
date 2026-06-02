/**
 * Script ตรวจสอบข้อมูลใน monthly_collection_snapshot และ monthly_target_detail_snapshot
 * สำหรับ Boonphone และ Fastfone365
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db.js";
import type { SectionKey } from "../server/shared/const.js";

const pgRows = (r: any) => (r?.rows ?? r ?? []) as any[];
const n = (v: any) => Number(v ?? 0);

async function check(section: SectionKey) {
  const db = await getDb(section);
  if (!db) { console.log(`[${section}] No DB`); return; }

  // 1. ตรวจ monthly_collection_snapshot
  const cs = await db.execute(sql.raw(`
    SELECT collection_month, target_amount, collected_amount, collected_sale
    FROM monthly_collection_snapshot
    WHERE section = '${section}'
    ORDER BY collection_month DESC
    LIMIT 5
  `));
  const csRows = pgRows(cs);
  console.log(`\n[${section}] monthly_collection_snapshot (latest 5):`);
  for (const r of csRows) {
    console.log(`  ${r.collection_month}: target=${n(r.target_amount).toLocaleString()} collected=${n(r.collected_amount).toLocaleString()} sale=${n(r.collected_sale).toLocaleString()}`);
  }

  // 2. ตรวจ monthly_target_detail_snapshot
  const ts = await db.execute(sql.raw(`
    SELECT
      snapshot_month,
      COUNT(*) AS rows,
      SUM(GREATEST(COALESCE(total_amount::numeric,0) - COALESCE(paid_amount::numeric,0), 0)) AS target_total,
      MIN(due_date::text) AS min_due,
      MAX(due_date::text) AS max_due,
      COUNT(DISTINCT TO_CHAR(due_date::date,'YYYY-MM')) AS distinct_months
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
    GROUP BY snapshot_month
    ORDER BY snapshot_month DESC
    LIMIT 5
  `));
  const tsRows = pgRows(ts);
  console.log(`\n[${section}] monthly_target_detail_snapshot (latest 5 months):`);
  for (const r of tsRows) {
    console.log(`  snapshot_month=${r.snapshot_month}: rows=${r.rows} target=${n(r.target_total).toLocaleString()} due_range=${r.min_due}~${r.max_due} distinct_due_months=${r.distinct_months}`);
  }

  // 3. ตรวจ target ที่กรอง due_date ตาม snapshot_month
  const ts2 = await db.execute(sql.raw(`
    SELECT
      snapshot_month,
      SUM(GREATEST(COALESCE(total_amount::numeric,0) - COALESCE(paid_amount::numeric,0), 0)) AS target_filtered
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND TO_CHAR(due_date::date,'YYYY-MM') = snapshot_month
    GROUP BY snapshot_month
    ORDER BY snapshot_month DESC
    LIMIT 5
  `));
  const ts2Rows = pgRows(ts2);
  console.log(`\n[${section}] target_filtered (due_date = snapshot_month):`);
  for (const r of ts2Rows) {
    console.log(`  snapshot_month=${r.snapshot_month}: target_filtered=${n(r.target_filtered).toLocaleString()}`);
  }
}

(async () => {
  await check("Boonphone");
  await check("Fastfone365");
  process.exit(0);
})();

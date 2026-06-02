/**
 * Script ตรวจสอบ debt_collected_cache สำหรับ 2026-06
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db.js";
import type { SectionKey } from "../server/shared/const.js";

const pgRows = (r: any) => (r?.rows ?? r ?? []) as any[];
const n = (v: any) => Number(v ?? 0);

async function check(section: SectionKey) {
  const db = await getDb(section);
  if (!db) { console.log(`[${section}] No DB`); return; }

  // ตรวจสอบ debt_collected_cache ว่ามีข้อมูล paid_at เดือน 2026-06 หรือไม่
  const r1 = await db.execute(sql.raw(`
    SELECT
      TO_CHAR(paid_at, 'YYYY-MM') AS paid_month,
      COUNT(*) AS cnt,
      SUM(total_amount::numeric) AS total,
      SUM(CASE WHEN is_bad_debt_row = true THEN total_amount::numeric ELSE 0 END) AS sale_total,
      SUM(CASE WHEN is_bad_debt_row = false THEN total_amount::numeric ELSE 0 END) AS installment_total
    FROM debt_collected_cache
    WHERE section = '${section}'
      AND paid_at IS NOT NULL
      AND TO_CHAR(paid_at, 'YYYY-MM') >= '2026-05'
    GROUP BY TO_CHAR(paid_at, 'YYYY-MM')
    ORDER BY paid_month DESC
    LIMIT 5
  `));
  const rows = pgRows(r1);
  console.log(`\n[${section}] debt_collected_cache (paid_at >= 2026-05):`);
  if (rows.length === 0) {
    console.log(`  No data found`);
  } else {
    for (const r of rows) {
      console.log(`  ${r.paid_month}: cnt=${r.cnt} total=${n(r.total).toLocaleString()} installment=${n(r.installment_total).toLocaleString()} sale=${n(r.sale_total).toLocaleString()}`);
    }
  }

  // ตรวจสอบ paid_at ล่าสุด
  const r2 = await db.execute(sql.raw(`
    SELECT MAX(paid_at::text) AS max_paid_at, MIN(paid_at::text) AS min_paid_at, COUNT(*) AS total_rows
    FROM debt_collected_cache
    WHERE section = '${section}'
  `));
  const r2rows = pgRows(r2);
  console.log(`  Latest paid_at: ${r2rows[0]?.max_paid_at}, Earliest: ${r2rows[0]?.min_paid_at}, Total rows: ${r2rows[0]?.total_rows}`);
}

(async () => {
  await check("Boonphone");
  await check("Fastfone365");
  process.exit(0);
})();

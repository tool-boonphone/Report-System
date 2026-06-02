/**
 * Script: สร้าง migration_flags เพื่อป้องกัน v3/v4 reset ลบ snapshot
 * แล้วสร้าง Target Detail Snapshot 2026-06 สำหรับทั้ง Boonphone และ Fastfone365
 *
 * Usage: npx tsx scripts/setup_snapshot_202606.ts
 */
import "dotenv/config";
import { getDb, pgRows } from "../server/db";
import { sql } from "drizzle-orm";
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";

const SNAPSHOT_MONTH = "2026-06";

async function main() {
  const sections = ["Boonphone", "Fastfone365"] as const;

  for (const section of sections) {
    const db = await getDb(section);
    if (!db) { console.log(`${section}: no DB`); continue; }

    // 1. สร้าง migration_flags table ถ้ายังไม่มี
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS migration_flags (
        flag_key VARCHAR(128) PRIMARY KEY,
        ran_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `));
    console.log(`[setup] ${section}: migration_flags table ready`);

    // 2. Mark v3 และ v4 reset ว่าทำแล้ว (ป้องกันไม่ให้ลบ snapshot อีก)
    await db.execute(sql.raw(`
      INSERT INTO migration_flags (flag_key) VALUES
        ('snapshot_v3_reset_${section}'),
        ('snapshot_v4_reset_${section}')
      ON CONFLICT DO NOTHING
    `));
    console.log(`[setup] ${section}: migration flags v3+v4 marked as done`);

    // 3. ตรวจสอบ flags
    const flagCheck = await db.execute(sql.raw(`
      SELECT flag_key FROM migration_flags
      WHERE flag_key IN ('snapshot_v3_reset_${section}', 'snapshot_v4_reset_${section}')
    `));
    const flags = pgRows(flagCheck);
    console.log(`[setup] ${section}: flags in DB = ${flags.map((r: any) => r.flag_key).join(", ")}`);
  }

  // 4. สร้าง Snapshot 2026-06
  for (const section of sections) {
    console.log(`\n[setup] ${section}: กำลังสร้าง Snapshot ${SNAPSHOT_MONTH}...`);
    try {
      const count = await populateTargetDetailSnapshot(
        section,
        SNAPSHOT_MONTH,
        "today",
        false,
        true,
        null,
      );
      console.log(`[setup] ${section}: ✅ Snapshot ${SNAPSHOT_MONTH} — ${count} rows`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[setup] ${section}: ❌ ล้มเหลว — ${msg}`);
    }
  }

  // 5. ตรวจสอบผลลัพธ์
  console.log("\n[setup] ตรวจสอบ snapshot ใน DB:");
  for (const section of sections) {
    const db = await getDb(section);
    if (!db) continue;
    const r = await db.execute(sql.raw(`
      SELECT snapshot_month, COUNT(*) as cnt, cutoff_date
      FROM monthly_target_detail_snapshot
      WHERE section = '${section}'
      GROUP BY snapshot_month, cutoff_date
      ORDER BY snapshot_month DESC LIMIT 5
    `));
    const rows = pgRows(r);
    for (const row of rows as Record<string, unknown>[]) {
      console.log(`  ${section}: ${row.snapshot_month} | cutoff=${row.cutoff_date} | rows=${row.cnt}`);
    }
  }

  console.log("\n[setup] เสร็จสิ้น ✅");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

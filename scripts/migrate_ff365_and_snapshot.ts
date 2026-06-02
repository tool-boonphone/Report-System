/**
 * Script: migrate_ff365_and_snapshot.ts
 * 1. สร้าง monthly_collection_snapshot table ใน Fastfone365 (ถ้ายังไม่มี)
 * 2. ลบ snapshot เดือนปัจจุบัน (ถ้ามี)
 * 3. Trigger snapshot ใหม่ด้วย end_of_month cutoffMode
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { populateMonthlyCollectionSnapshot } from "../server/monthlyCollectionSnapshotDb";
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";

// เดือนปัจจุบัน (Bangkok time)
const bangkokDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const currentMonth = bangkokDate.slice(0, 7); // "YYYY-MM"

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

async function main() {
  console.log(`\n========================================`);
  console.log(`Migrate & Trigger Fastfone365 Snapshot: ${currentMonth}`);
  console.log(`========================================\n`);

  const db = await getDb("Fastfone365");
  if (!db) {
    console.error("❌ ไม่สามารถเชื่อมต่อ Fastfone365 DB ได้");
    process.exit(1);
  }

  // 1. สร้าง monthly_collection_snapshot table ถ้ายังไม่มี
  console.log("📦 สร้าง monthly_collection_snapshot table (IF NOT EXISTS)...");
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS monthly_collection_snapshot (
      id                      INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      section                 VARCHAR(32)      NOT NULL,
      collection_month        VARCHAR(7)       NOT NULL,
      target_amount           NUMERIC          NOT NULL DEFAULT 0,
      target_contract_count   INTEGER          NOT NULL DEFAULT 0,
      target_frozen_at        TIMESTAMP,
      target_principal        NUMERIC          NOT NULL DEFAULT 0,
      target_interest         NUMERIC          NOT NULL DEFAULT 0,
      target_fee              NUMERIC          NOT NULL DEFAULT 0,
      target_penalty          NUMERIC          NOT NULL DEFAULT 0,
      target_unlock_fee       NUMERIC          NOT NULL DEFAULT 0,
      collected_amount        NUMERIC          NOT NULL DEFAULT 0,
      collected_contract_count INTEGER         NOT NULL DEFAULT 0,
      collected_frozen_at     TIMESTAMP,
      collected_is_frozen     BOOLEAN          NOT NULL DEFAULT false,
      collected_principal     NUMERIC          NOT NULL DEFAULT 0,
      collected_interest      NUMERIC          NOT NULL DEFAULT 0,
      collected_fee           NUMERIC          NOT NULL DEFAULT 0,
      collected_penalty       NUMERIC          NOT NULL DEFAULT 0,
      collected_unlock_fee    NUMERIC          NOT NULL DEFAULT 0,
      collected_discount      NUMERIC          NOT NULL DEFAULT 0,
      collected_overpaid      NUMERIC          NOT NULL DEFAULT 0,
      collected_bad_debt      NUMERIC          NOT NULL DEFAULT 0,
      install_total           NUMERIC          NOT NULL DEFAULT 0,
      financed_total          NUMERIC          NOT NULL DEFAULT 0,
      overdue_total           NUMERIC          NOT NULL DEFAULT 0,
      collected_sale          NUMERIC          NOT NULL DEFAULT 0,
      created_at              TIMESTAMP        NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMP        NOT NULL DEFAULT NOW(),
      UNIQUE (section, collection_month)
    )
  `));
  console.log("✅ monthly_collection_snapshot table พร้อมแล้ว");

  // 2. ลบ snapshot เดือนปัจจุบัน (ถ้ามี)
  console.log(`\n🗑️  ลบ monthly_target_detail_snapshot เดือน ${currentMonth}...`);
  await db.execute(sql.raw(`
    DELETE FROM monthly_target_detail_snapshot
    WHERE section = 'Fastfone365' AND snapshot_month = '${currentMonth}'
  `));
  console.log("✅ ลบ detail snapshot แล้ว");

  console.log(`🗑️  ลบ monthly_collection_snapshot เดือน ${currentMonth}...`);
  await db.execute(sql.raw(`
    DELETE FROM monthly_collection_snapshot
    WHERE section = 'Fastfone365' AND collection_month = '${currentMonth}'
  `));
  console.log("✅ ลบ collection snapshot แล้ว");

  // 3. Populate monthly_collection_snapshot ด้วย end_of_month cutoffMode
  console.log(`\n🔄 Populate monthly_collection_snapshot (end_of_month)...`);
  const snapshotRows = await populateMonthlyCollectionSnapshot(
    "Fastfone365",
    (current, total) => {
      process.stdout.write(`\r  progress: ${current}/${total}`);
    },
    "end_of_month",
  );
  console.log(`\n✅ monthly_collection_snapshot: ${snapshotRows} months`);

  // 4. Populate monthly_target_detail_snapshot ด้วย end_of_month mode
  console.log(`\n🔄 Populate monthly_target_detail_snapshot (end_of_month)...`);
  const detailRows = await populateTargetDetailSnapshot(
    "Fastfone365",
    currentMonth,
    "end_of_month",
    true,  // filterDebtOnly
    true,  // filterPrincipalOnly
    autoSnapshotFilterState,
  );
  console.log(`✅ monthly_target_detail_snapshot: ${detailRows} rows สำหรับ ${currentMonth}`);

  console.log(`\n========================================`);
  console.log(`✅ Fastfone365 เสร็จสิ้น`);
  console.log(`========================================\n`);
  process.exit(0);
}

main().catch(err => {
  console.error("❌ Error:", err?.message ?? err);
  process.exit(1);
});

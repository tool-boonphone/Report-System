/**
 * Script: reset_and_trigger_snapshot.ts
 * ลบ monthly_collection_snapshot และ monthly_target_detail_snapshot ของเดือนปัจจุบัน
 * แล้ว trigger ใหม่ด้วย end_of_month cutoffMode สำหรับทั้ง Boonphone และ Fastfone365
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { populateMonthlyCollectionSnapshot } from "../server/monthlyCollectionSnapshotDb";
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";

const SECTIONS = ["Boonphone", "Fastfone365"] as const;
type SectionKey = (typeof SECTIONS)[number];

// เดือนปัจจุบัน (Bangkok time)
const bangkokDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const currentMonth = bangkokDate.slice(0, 7); // "YYYY-MM"

console.log(`\n========================================`);
console.log(`Reset & Trigger Snapshot: ${currentMonth}`);
console.log(`========================================\n`);

async function resetAndTrigger(section: SectionKey) {
  console.log(`\n[${section}] ── กำลังดำเนินการ ──`);
  const db = await getDb(section);
  if (!db) {
    console.error(`[${section}] ❌ ไม่สามารถเชื่อมต่อ DB ได้`);
    return;
  }

  // 1. ลบ monthly_target_detail_snapshot ของเดือนปัจจุบัน
  console.log(`[${section}] 🗑️  ลบ monthly_target_detail_snapshot เดือน ${currentMonth}...`);
  const delDetailResult = await db.execute(sql.raw(`
    DELETE FROM monthly_target_detail_snapshot
    WHERE section = '${section}' AND snapshot_month = '${currentMonth}'
  `));
  console.log(`[${section}] ✅ ลบ detail snapshot แล้ว`);

  // 2. ลบ monthly_collection_snapshot ของเดือนปัจจุบัน
  console.log(`[${section}] 🗑️  ลบ monthly_collection_snapshot เดือน ${currentMonth}...`);
  await db.execute(sql.raw(`
    DELETE FROM monthly_collection_snapshot
    WHERE section = '${section}' AND collection_month = '${currentMonth}'
  `));
  console.log(`[${section}] ✅ ลบ collection snapshot แล้ว`);

  // 3. Populate monthly_collection_snapshot ด้วย end_of_month cutoffMode
  console.log(`[${section}] 🔄 Populate monthly_collection_snapshot (end_of_month)...`);
  const snapshotRows = await populateMonthlyCollectionSnapshot(
    section,
    (current, total) => {
      process.stdout.write(`\r[${section}]   progress: ${current}/${total}`);
    },
    "end_of_month",
  );
  console.log(`\n[${section}] ✅ monthly_collection_snapshot: ${snapshotRows} months`);

  // 4. Populate monthly_target_detail_snapshot ด้วย end_of_month mode
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

  console.log(`[${section}] 🔄 Populate monthly_target_detail_snapshot (end_of_month)...`);
  const detailRows = await populateTargetDetailSnapshot(
    section,
    currentMonth,
    "end_of_month",
    true,  // filterDebtOnly
    true,  // filterPrincipalOnly
    autoSnapshotFilterState,
  );
  console.log(`[${section}] ✅ monthly_target_detail_snapshot: ${detailRows} rows สำหรับ ${currentMonth}`);
}

async function main() {
  for (const section of SECTIONS) {
    try {
      await resetAndTrigger(section);
    } catch (err: any) {
      console.error(`[${section}] ❌ Error:`, err?.message ?? err);
    }
  }
  console.log(`\n========================================`);
  console.log(`✅ เสร็จสิ้น`);
  console.log(`========================================\n`);
  process.exit(0);
}

main();

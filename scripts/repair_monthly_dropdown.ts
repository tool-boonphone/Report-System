/**
 * Repair dropdown "ตั้งเป้ารายเดือน > ตั้งหนี้" สำหรับ section + เดือนที่ระบุ
 *
 * ใช้เมื่อ sync วันที่ 1 สร้าง roll ไม่สำเร็จ หรือยอดรายวันเดือนก่อนหน้าขาด
 *
 * Usage:
 *   npx tsx scripts/repair_monthly_dropdown.ts Boonphone
 *   npx tsx scripts/repair_monthly_dropdown.ts Boonphone 2026-07 2026-06
 */
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";
import {
  backfillFrozenBreakdown,
  hasTargetDetailSnapshot,
  previousCalendarMonth,
} from "../server/monthlyCollectionSnapshotDb";
import type { SectionKey } from "../shared/const";

const filterStateJson = JSON.stringify({
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
  const section = (process.argv[2] ?? "Boonphone") as SectionKey;
  const bangkokMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);

  const months: string[] = process.argv.length > 3
    ? process.argv.slice(3)
    : [bangkokMonth, previousCalendarMonth(bangkokMonth)].filter(Boolean) as string[];

  console.log(`\n[repair] section=${section} months=${months.join(", ")}\n`);

  for (const month of months) {
    const exists = await hasTargetDetailSnapshot(section, month);
    if (!exists) {
      console.log(`[repair] ${month}: creating mtds roll...`);
      const rows = await populateTargetDetailSnapshot(
        section,
        month,
        "end_of_month",
        true,
        true,
        filterStateJson,
        undefined,
        false,
      );
      console.log(`[repair] ${month}: inserted ${rows} rows`);
    } else {
      console.log(`[repair] ${month}: mtds roll already exists — skip populate`);
    }

    const backfillCount = await backfillFrozenBreakdown(section, month);
    console.log(`[repair] ${month}: backfill updated=${backfillCount}`);
  }

  console.log("\n[repair] done\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

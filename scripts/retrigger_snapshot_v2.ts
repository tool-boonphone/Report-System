/**
 * retrigger_snapshot_v2.ts
 * ลบ monthly_collection_snapshot และ monthly_target_detail_snapshot ของ 2026-06
 * แล้ว trigger ใหม่ด้วย end_of_month cutoffMode (target_amount = SUM(total_amount) ไม่หัก paid)
 */
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { populateMonthlyCollectionSnapshot } from "../server/monthlyCollectionSnapshotDb";
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";

const SECTIONS = ["Boonphone", "Fastfone365"] as const;
const MONTH = "2026-06";

async function main() {
  for (const section of SECTIONS) {
    console.log(`\n=== ${section} ===`);
    const db = await getDb(section as any);
    if (!db) { console.error(`  DB not available`); continue; }

    // 1. ลบ monthly_collection_snapshot ของเดือนนี้
    await db.execute(sql.raw(`DELETE FROM monthly_collection_snapshot WHERE section = '${section}' AND collection_month = '${MONTH}'`));
    console.log(`  Deleted monthly_collection_snapshot: done`);

    // 2. ลบ monthly_target_detail_snapshot ของเดือนนี้
    await db.execute(sql.raw(`DELETE FROM monthly_target_detail_snapshot WHERE section = '${section}' AND snapshot_month = '${MONTH}'`));
    console.log(`  Deleted monthly_target_detail_snapshot: done`);

    // 3. Populate monthly_collection_snapshot ด้วย end_of_month cutoffMode
    console.log(`  Populating monthly_collection_snapshot (end_of_month)...`);
    const mcsCount = await populateMonthlyCollectionSnapshot(section as any, (cur, tot) => {
      if (cur % 5 === 0 || cur === tot) process.stdout.write(`\r    Progress: ${cur}/${tot}`);
    }, "end_of_month");
    console.log(`\n  monthly_collection_snapshot: ${mcsCount} rows upserted`);

    // 4. Populate monthly_target_detail_snapshot ด้วย end_of_month mode
    const filterState = JSON.stringify({
      debtSetMode: true,
      debtSetCutoffMode: "end_of_month",
      principalOnly: true,
    });
    console.log(`  Populating monthly_target_detail_snapshot (end_of_month)...`);
    const detailCount = await populateTargetDetailSnapshot(
      section as any,
      MONTH,
      "end_of_month",
      true,  // filterDebtOnly
      true,  // filterPrincipalOnly
      filterState,
    );
    console.log(`  monthly_target_detail_snapshot: ${detailCount} rows inserted`);

    // 5. ตรวจสอบผลลัพธ์
    const verify = await db.execute(sql.raw(`SELECT target_amount, target_contract_count FROM monthly_collection_snapshot WHERE section = '${section}' AND collection_month = '${MONTH}'`));
    const rows = (verify as any).rows ?? [];
    if (rows.length > 0) {
      console.log(`  ✅ target_amount = ${Number(rows[0].target_amount).toLocaleString()}, contracts = ${rows[0].target_contract_count}`);
    } else {
      console.log(`  ⚠️  No monthly_collection_snapshot found`);
    }
  }
  console.log("\n✅ Done!");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

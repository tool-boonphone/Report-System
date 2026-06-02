/**
 * Script: Populate monthly_collection_snapshot สำหรับ Boonphone และ Fastfone365
 * เพื่อให้มีข้อมูลเดือน 2026-06 ใน monthly_collection_snapshot
 * ซึ่งจะถูกใช้ใน dropdown "เป้าเก็บหนี้รายเดือน"
 */
import { populateMonthlyCollectionSnapshot } from "../server/monthlyCollectionSnapshotDb.js";
import type { SectionKey } from "../server/shared/const.js";

async function run(section: SectionKey) {
  console.log(`\n[${section}] Starting populateMonthlyCollectionSnapshot...`);
  const start = Date.now();
  try {
    await populateMonthlyCollectionSnapshot(section, (current, total) => {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      if (pct % 20 === 0) {
        console.log(`  [${section}] Progress: ${current}/${total} (${pct}%)`);
      }
    });
    console.log(`[${section}] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`[${section}] Error:`, err);
  }
}

(async () => {
  await run("Boonphone");
  await run("Fastfone365");
  process.exit(0);
})();

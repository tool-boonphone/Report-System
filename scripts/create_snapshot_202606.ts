/**
 * Script: สร้าง Target Detail Snapshot สำหรับเดือน 2026-06
 * ทั้ง Boonphone และ Fastfone365
 *
 * Usage: npx tsx scripts/create_snapshot_202606.ts
 */
import "dotenv/config";
import { populateTargetDetailSnapshot } from "../server/monthlyTargetDetailSnapshotDb";

const SNAPSHOT_MONTH = "2026-06";

async function main() {
  const sections = ["Boonphone", "Fastfone365"] as const;

  for (const section of sections) {
    console.log(`\n[create_snapshot] ${section}: กำลังสร้าง Snapshot ${SNAPSHOT_MONTH}...`);
    try {
      const count = await populateTargetDetailSnapshot(
        section,
        SNAPSHOT_MONTH,
        "today",      // snapshotMode
        false,        // filterDebtOnly
        true,         // filterPrincipalOnly
        null,         // filterState
      );
      console.log(`[create_snapshot] ${section}: ✅ สำเร็จ — ${count} rows inserted`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[create_snapshot] ${section}: ❌ ล้มเหลว — ${msg}`);
    }
  }

  console.log("\n[create_snapshot] เสร็จสิ้น");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function check(section: "Boonphone" | "Fastfone365") {
  const db = await getDb(section);
  if (!db) { console.error(`No DB for ${section}`); return; }
  
  const r = await db.execute(sql.raw(`
    SELECT collection_month, target_amount, target_contract_count, collected_amount, collected_is_frozen
    FROM monthly_collection_snapshot
    WHERE section = '${section}' AND collection_month = '2026-06'
  `));
  const rows: any[] = (r as any).rows ?? [];
  if (rows.length === 0) {
    console.log(`[${section}] ❌ ไม่พบ snapshot 2026-06`);
    return;
  }
  const row = rows[0];
  console.log(`[${section}] ✅ Snapshot 2026-06:`);
  console.log(`  target_amount: ${Number(row.target_amount).toLocaleString()}`);
  console.log(`  target_contract_count: ${row.target_contract_count}`);
  console.log(`  collected_amount: ${Number(row.collected_amount).toLocaleString()}`);
  console.log(`  collected_is_frozen: ${row.collected_is_frozen}`);
  
  // นับ detail rows
  const d = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt FROM monthly_target_detail_snapshot
    WHERE section = '${section}' AND snapshot_month = '2026-06'
  `));
  const dRows: any[] = (d as any).rows ?? [];
  console.log(`  detail_rows: ${dRows[0]?.cnt ?? 0}`);
}

async function main() {
  await check("Boonphone");
  await check("Fastfone365");
  process.exit(0);
}
main();

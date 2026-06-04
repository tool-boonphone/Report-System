import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function check() {
  const db = await getDb("Boonphone");
  if (!db) { console.log("No DB"); return; }
  
  // ดู monthly_collection_snapshot
  const r1 = await db.execute(sql`
    SELECT collection_month, target_amount, collected_amount, target_frozen_at
    FROM monthly_collection_snapshot
    WHERE section = 'Boonphone'
    ORDER BY collection_month DESC
    LIMIT 5
  `);
  console.log("monthly_collection_snapshot (Boonphone):");
  const rows1 = (r1 as any).rows ?? r1;
  for (const r of rows1) {
    console.log(`  ${r.collection_month}: target=${r.target_amount}, collected=${r.collected_amount}, frozen_at=${r.target_frozen_at}`);
  }
  
  // ดู monthly_target_detail_snapshot SUM
  const r2 = await db.execute(sql`
    SELECT snapshot_month, 
           SUM(GREATEST(COALESCE(total_amount::numeric,0) - COALESCE(paid_amount::numeric,0), 0)) as net_target,
           COUNT(*) as rows
    FROM monthly_target_detail_snapshot
    WHERE section = 'Boonphone'
    GROUP BY snapshot_month
    ORDER BY snapshot_month DESC
  `);
  console.log("\nmonthly_target_detail_snapshot SUM (Boonphone):");
  const rows2 = (r2 as any).rows ?? r2;
  for (const r of rows2) {
    console.log(`  ${r.snapshot_month}: net_target=${r.net_target}, rows=${r.rows}`);
  }
}

check().catch(console.error).finally(() => process.exit(0));

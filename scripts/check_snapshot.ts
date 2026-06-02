import "dotenv/config";
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  for (const sec of ["Boonphone", "Fastfone365"] as const) {
    const db = await getDb(sec);
    if (!db) { console.log(`${sec}: no DB`); continue; }
    const r = await db.execute(sql.raw(`
      SELECT snapshot_month, COUNT(*) as cnt, snapshot_mode, cutoff_date 
      FROM monthly_target_detail_snapshot 
      WHERE section = '${sec}' 
      GROUP BY snapshot_month, snapshot_mode, cutoff_date 
      ORDER BY snapshot_month DESC LIMIT 5
    `));
    console.log(`\n${sec}:`);
    const rows = (r as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
    for (const row of rows) {
      console.log(`  ${row.snapshot_month} | mode=${row.snapshot_mode} | cutoff=${row.cutoff_date} | rows=${row.cnt}`);
    }
  }
  process.exit(0);
}

main().catch(console.error);

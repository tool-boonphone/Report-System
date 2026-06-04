import { getDb, pgRows } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb("Boonphone");
  if (!db) { console.error("DB not found"); process.exit(1); }
  const r = await db.execute(sql.raw(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'monthly_collection_snapshot' ORDER BY ordinal_position`));
  console.log("Columns:", pgRows(r).map((x: any) => x.column_name));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });

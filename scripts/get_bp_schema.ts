import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function main() {
  const db = await getDb("Boonphone");
  if (!db) { console.error("No DB"); process.exit(1); }
  const r = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'monthly_collection_snapshot'
    ORDER BY ordinal_position
  `);
  const rows: any[] = (r as any).rows ?? [];
  console.log("monthly_collection_snapshot columns:");
  rows.forEach(row => console.log(` ${row.column_name}: ${row.data_type}${row.character_maximum_length ? `(${row.character_maximum_length})` : ''} ${row.is_nullable === 'NO' ? 'NOT NULL' : ''} ${row.column_default ? `DEFAULT ${row.column_default}` : ''}`));
  process.exit(0);
}
main();

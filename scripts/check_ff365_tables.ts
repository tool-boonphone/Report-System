import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function main() {
  const db = await getDb("Fastfone365");
  if (!db) { console.error("No DB"); process.exit(1); }
  const result = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name LIKE '%snapshot%'
    ORDER BY table_name
  `);
  const rows: any[] = (result as any).rows ?? [];
  console.log("Tables with 'snapshot' in Fastfone365:");
  rows.forEach(r => console.log(" -", r.table_name));
  process.exit(0);
}
main();

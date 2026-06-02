import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function main() {
  const db = await getDb("Fastfone365");
  if (!db) { console.error("No DB"); process.exit(1); }

  // ดู migration_flags
  try {
    const r = await db.execute(sql`SELECT * FROM migration_flags WHERE section = 'Fastfone365' ORDER BY flag_name`);
    const rows: any[] = (r as any).rows ?? [];
    console.log("Migration flags for Fastfone365:");
    rows.forEach(row => console.log(` - ${row.flag_name}: ${row.flag_value}`));
  } catch(e: any) {
    console.log("migration_flags error:", e.message);
  }

  // ดู tables ทั้งหมด
  const t = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
  const tables: any[] = (t as any).rows ?? [];
  console.log("\nAll tables in Fastfone365:");
  tables.forEach(row => console.log(` - ${row.table_name}`));

  process.exit(0);
}
main();

import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  const r1 = await db.execute(sql`SELECT section, COUNT(*) as cnt, MAX(populated_at) as last_pop FROM debt_target_cache GROUP BY section`);
  const r2 = await db.execute(sql`SELECT section, COUNT(*) as cnt, MAX(populated_at) as last_pop FROM debt_collected_cache GROUP BY section`);
  console.log("debt_target_cache:", (r1 as any)[0] ?? r1);
  console.log("debt_collected_cache:", (r2 as any)[0] ?? r2);
  process.exit(0);
}
main();

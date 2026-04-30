import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  // Check contracts count per section
  const r1 = await db.execute(sql`SELECT section, COUNT(*) as cnt FROM contracts GROUP BY section`);
  console.log("contracts per section:", (r1 as any)[0] ?? r1);

  // Check installments count per section
  const r2 = await db.execute(sql`SELECT section, COUNT(*) as cnt FROM installments GROUP BY section`);
  console.log("installments per section:", (r2 as any)[0] ?? r2);

  // Check payment_transactions count per section
  const r3 = await db.execute(sql`SELECT section, COUNT(*) as cnt FROM payment_transactions GROUP BY section`);
  console.log("payment_transactions per section:", (r3 as any)[0] ?? r3);

  process.exit(0);
}
main();

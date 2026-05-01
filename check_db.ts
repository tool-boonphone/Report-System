import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) { console.log("No DB"); process.exit(1); }

  const r1 = await db.execute(sql`SELECT COUNT(DISTINCT contract_external_id) as cnt FROM debt_target_cache WHERE section = 'Boonphone'`);
  console.log("debt_target_cache distinct (Boonphone):", (r1 as any)[0][0]?.cnt);

  const r2 = await db.execute(sql`SELECT COUNT(DISTINCT external_id) as cnt FROM contracts WHERE section = 'Boonphone' AND (status IS NULL OR status != 'ยกเลิกสัญญา')`);
  console.log("contracts non-cancelled (Boonphone):", (r2 as any)[0][0]?.cnt);

  const r3 = await db.execute(sql`SELECT COUNT(DISTINCT external_id) as cnt FROM contracts WHERE section = 'Boonphone'`);
  console.log("contracts all (Boonphone):", (r3 as any)[0][0]?.cnt);

  const r4 = await db.execute(sql`SELECT COUNT(DISTINCT external_id) as cnt FROM contracts WHERE section = 'Boonphone' AND status = 'ยกเลิกสัญญา'`);
  console.log("contracts cancelled (Boonphone):", (r4 as any)[0][0]?.cnt);

  process.exit(0);
}
main().catch(console.error);

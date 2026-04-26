import { getDb } from './server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) { console.log('No DB'); process.exit(1); }

  // Check total payment count
  const r1 = await db.execute(sql`SELECT COUNT(*) as cnt FROM payment_transactions WHERE section = 'Fastfone365'`);
  const cnt = (r1 as any)[0]?.[0]?.cnt ?? (r1 as any)[0]?.cnt;
  console.log('FF365 payment count:', cnt);

  // Check contracts
  const r2 = await db.execute(sql`SELECT COUNT(*) as cnt FROM contracts WHERE section = 'Fastfone365'`);
  const cCnt = (r2 as any)[0]?.[0]?.cnt ?? (r2 as any)[0]?.cnt;
  console.log('FF365 contract count:', cCnt);

  // Check specific contract
  const r3 = await db.execute(sql`
    SELECT external_id, contract_no FROM contracts 
    WHERE section = 'Fastfone365' AND contract_no LIKE '%15462%'
    LIMIT 5
  `);
  const rows3: any[] = (r3 as any)[0] ?? r3;
  console.log('Contracts matching 15462:', rows3.map((r: any) => `${r.external_id} / ${r.contract_no}`));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

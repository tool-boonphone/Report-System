import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.error('No DB connection'); process.exit(1); }

// หาสัญญาที่มี overpaid_amount > 0
const rows = await db.execute(sql`
  SELECT 
    c.contract_no,
    c.section,
    c.status,
    c.bad_debt_amount,
    pt.external_id,
    pt.paid_at,
    JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') as overpaid_amount,
    JSON_EXTRACT(pt.raw_json, '$.total_paid_amount') as total_paid,
    JSON_EXTRACT(pt.raw_json, '$.receipt_no') as receipt_no
  FROM payment_transactions pt
  JOIN contracts c ON c.external_id = pt.contract_external_id AND c.section = pt.section
  WHERE JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') > 0
  ORDER BY CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') AS DECIMAL) DESC
  LIMIT 20
`);

console.log('=== Contracts with overpaid_amount > 0 ===');
for (const r of rows[0] as any[]) {
  console.log(`${r.contract_no} [${r.section}] | status=${r.status} | bad_debt=${r.bad_debt_amount} | overpaid=${r.overpaid_amount} | total_paid=${r.total_paid} | receipt=${r.receipt_no} | paid_at=${r.paid_at}`);
}

process.exit(0);

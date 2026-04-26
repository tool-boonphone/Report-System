/**
 * test-p63g.ts — ตรวจสอบ raw payment data จาก DB สำหรับ CT0925-PKN001-15462-01 (external_id=16464)
 */
import { getDb } from './server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) { 
    console.log('No DB');
    process.exit(1); 
  }

  console.log('DB connected ✅');

  // ใช้ external_id = 16464 (contract_no = CT0925-PKN001-15462-01)
  const result = await db.execute(sql`
    SELECT external_id, paid_at, amount, raw_json
    FROM payment_transactions
    WHERE section = 'Fastfone365'
      AND contract_external_id = '16464'
    ORDER BY paid_at, external_id
    LIMIT 15
  `);

  const rows: any[] = (result as any)[0] ?? result;
  console.log('Row count:', rows.length);
  for (const r of rows) {
    const rj = typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json;
    const pif = Number(rj?.principal_paid??0)+Number(rj?.interest_paid??0)+Number(rj?.fee_paid??0);
    console.log(`  ${r.paid_at} | receipt=${rj?.receipt_no} | amount=${r.amount} | overpaid=${rj?.overpaid_amount} | pif=${pif}`);
  }

  // Check installments
  const instResult = await db.execute(sql`
    SELECT period, due_date, amount, paid_amount, status
    FROM installments
    WHERE section = 'Fastfone365'
      AND contract_external_id = '16464'
    ORDER BY period
  `);
  const instRows: any[] = (instResult as any)[0] ?? instResult;
  console.log('\n=== Installments ===');
  for (const r of instRows) {
    console.log(`  period=${r.period} | due=${r.due_date} | amount=${r.amount} | paid=${r.paid_amount} | status=${r.status}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

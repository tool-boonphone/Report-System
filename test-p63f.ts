/**
 * test-p63f.ts — ตรวจสอบ raw payment data จาก DB สำหรับ CT0925-PKN001-15462-01
 * ใช้ process.env ที่ถูก inject โดย tsx
 */
import { getDb } from './server/db';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { 
  console.log('No DB - DATABASE_URL:', process.env.DATABASE_URL?.slice(0, 30));
  process.exit(1); 
}

console.log('DB connected ✅');

// Get raw payments for this contract
const result = await db.execute(sql`
  SELECT external_id, paid_at, amount,
    JSON_EXTRACT(raw_json, '$.receipt_no') AS receipt_no,
    JSON_EXTRACT(raw_json, '$.overpaid_amount') AS overpaid_amount,
    JSON_EXTRACT(raw_json, '$.principal_paid') AS principal_paid,
    JSON_EXTRACT(raw_json, '$.interest_paid') AS interest_paid,
    JSON_EXTRACT(raw_json, '$.fee_paid') AS fee_paid,
    JSON_EXTRACT(raw_json, '$.close_installment_amount') AS close_installment_amount,
    JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.payment_id')) AS payment_id
  FROM payment_transactions
  WHERE section = 'Fastfone365'
    AND contract_external_id = 'CT0925-PKN001-15462-01'
  ORDER BY paid_at, external_id
`);

const rows: any[] = (result as any)[0] ?? result;
console.log('\n=== Raw Payments for CT0925-PKN001-15462-01 ===');
for (const r of rows) {
  const pif = Number(r.principal_paid??0)+Number(r.interest_paid??0)+Number(r.fee_paid??0);
  console.log(`  ${r.paid_at} | receipt=${r.receipt_no} | amount=${r.amount} | overpaid=${r.overpaid_amount} | pif=${pif}`);
}

// Get installments
const instResult = await db.execute(sql`
  SELECT period, due_date, amount, paid_amount, status
  FROM installments
  WHERE section = 'Fastfone365'
    AND contract_external_id = 'CT0925-PKN001-15462-01'
  ORDER BY period
`);
const instRows: any[] = (instResult as any)[0] ?? instResult;
console.log('\n=== Installments ===');
for (const r of instRows) {
  console.log(`  period=${r.period} | due=${r.due_date} | amount=${r.amount} | paid=${r.paid_amount} | status=${r.status}`);
}

process.exit(0);

import { config } from 'dotenv';
config({ path: '/home/ubuntu/report-system/.env' });

const { getDb } = await import('/home/ubuntu/report-system/server/db.ts');
const { sql } = await import('drizzle-orm');

const db = await getDb();
if (!db) { console.log('No DB'); process.exit(1); }

// Get raw payments for this contract
const result = await db.execute(sql`
  SELECT external_id, paid_at, amount,
    JSON_EXTRACT(raw_json, '$.receipt_no') AS receipt_no,
    JSON_EXTRACT(raw_json, '$.overpaid_amount') AS overpaid_amount,
    JSON_EXTRACT(raw_json, '$.principal_paid') AS principal_paid,
    JSON_EXTRACT(raw_json, '$.interest_paid') AS interest_paid,
    JSON_EXTRACT(raw_json, '$.fee_paid') AS fee_paid
  FROM payment_transactions
  WHERE section = 'Fastfone365'
    AND contract_external_id = 'CT0925-PKN001-15462-01'
  ORDER BY paid_at, external_id
`);

const rows = (result as any)[0] ?? result;
console.log('=== Raw Payments for CT0925-PKN001-15462-01 ===');
for (const r of rows) {
  console.log(`  ${r.paid_at} | receipt=${r.receipt_no} | amount=${r.amount} | overpaid=${r.overpaid_amount} | pif=${Number(r.principal_paid??0)+Number(r.interest_paid??0)+Number(r.fee_paid??0)}`);
}

// Get installments
const instResult = await db.execute(sql`
  SELECT period, due_date, amount, paid_amount, status
  FROM installments
  WHERE section = 'Fastfone365'
    AND contract_external_id = 'CT0925-PKN001-15462-01'
  ORDER BY period
`);
const instRows = (instResult as any)[0] ?? instResult;
console.log('\n=== Installments ===');
for (const r of instRows) {
  console.log(`  period=${r.period} | due=${r.due_date} | amount=${r.amount} | paid=${r.paid_amount} | status=${r.status}`);
}

process.exit(0);

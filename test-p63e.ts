import { config } from 'dotenv';
config({ path: '/home/ubuntu/report-system/.env' });

import { getDb } from './server/db';
import { sql } from 'drizzle-orm';
import { assignPayPeriods } from './server/debtDb';

const db = await getDb();
if (!db) { console.log('No DB'); process.exit(1); }

// Get raw payments for this contract
const result = await db.execute(sql`
  SELECT external_id, paid_at, amount,
    JSON_EXTRACT(raw_json, '$.receipt_no') AS receipt_no,
    JSON_EXTRACT(raw_json, '$.overpaid_amount') AS overpaid_amount,
    JSON_EXTRACT(raw_json, '$.principal_paid') AS principal_paid,
    JSON_EXTRACT(raw_json, '$.interest_paid') AS interest_paid,
    JSON_EXTRACT(raw_json, '$.fee_paid') AS fee_paid,
    JSON_EXTRACT(raw_json, '$.close_installment_amount') AS close_installment_amount,
    JSON_EXTRACT(raw_json, '$.payment_id') AS payment_id
  FROM payment_transactions
  WHERE section = 'Fastfone365'
    AND contract_external_id = 'CT0925-PKN001-15462-01'
  ORDER BY paid_at, external_id
`);

const rows: any[] = (result as any)[0] ?? result;
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
const instRows: any[] = (instResult as any)[0] ?? instResult;
console.log('\n=== Installments ===');
for (const r of instRows) {
  console.log(`  period=${r.period} | due=${r.due_date} | amount=${r.amount} | paid=${r.paid_amount} | status=${r.status}`);
}

// Test assignPayPeriods
console.log('\n=== assignPayPeriods test ===');
const payments = rows.map(r => ({
  contract_external_id: 'CT0925-PKN001-15462-01',
  period: null,
  payment_external_id: String(r.external_id ?? ''),
  paid_at: r.paid_at ?? null,
  total_paid_amount: r.amount != null ? Number(r.amount) : null,
  principal_paid: r.principal_paid != null ? Number(r.principal_paid) : null,
  interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
  fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
  penalty_paid: null,
  unlock_fee_paid: null,
  discount_amount: null,
  overpaid_amount: r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
  close_installment_amount: r.close_installment_amount != null ? Number(r.close_installment_amount) : null,
  bad_debt_amount: null,
  payment_id: r.payment_id != null ? Number(r.payment_id) : null,
  receipt_no: r.receipt_no ?? null,
  remark: null,
  ff_status: null,
}));

const installmentList = instRows.map(r => ({
  period: r.period != null ? Number(r.period) : null,
  amount: r.amount != null ? Number(r.amount) : 0,
}));

const assigned = assignPayPeriods(payments as any, installmentList);
for (const p of assigned) {
  console.log(`  period=${p.period} | receipt=${p.receipt_no} | total=${p.total_paid_amount} | overpaid=${p.overpaid_amount} | isClose=${p.isCloseRow}`);
}

process.exit(0);

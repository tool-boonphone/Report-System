import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Find contract
const [contracts] = await conn.execute(
  `SELECT id, external_id, status, installment_amount, installment_count, finance_amount
   FROM contracts WHERE external_id = 'CT0925-PKN001-15462-01' LIMIT 1`
);
console.log('Contract:', JSON.stringify(contracts[0], null, 2));

const contractId = contracts[0]?.id;
if (!contractId) { console.log('Not found'); process.exit(1); }

// Get installments with amount and paid_amount
const [installments] = await conn.execute(
  `SELECT period, due_date, amount, paid_amount, principal_due, interest_due, fee_due,
          installment_status_code
   FROM installments WHERE contract_id = ? ORDER BY period`,
  [contractId]
);
console.log('\nInstallments:');
for (const r of installments) {
  console.log(`  Period ${r.period}: amount=${r.amount}, paid=${r.paid_amount}, status=${r.installment_status_code}`);
}

// Get payments with overpaid_amount
const [payments] = await conn.execute(
  `SELECT id, receipt_no, amount, 
          CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) as overpaid_amount,
          paid_at
   FROM payment_transactions WHERE contract_id = ? ORDER BY paid_at`,
  [contractId]
);
console.log('\nPayments:');
for (const p of payments) {
  console.log(`  receipt=${p.receipt_no}, amount=${p.amount}, overpaid=${p.overpaid_amount}, paid_at=${p.paid_at}`);
}

await conn.end();

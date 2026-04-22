import 'dotenv/config';
import mysql from 'mysql2/promise';

const c = await mysql.createConnection(process.env.DATABASE_URL);

// Look at a specific contract with overpaid to see the sequence:
//   - period P: payment with overpaid_amount = X
//   - period P+1: installment amount = baseline - X ? or baseline ?
// If the latter, the overpaid is still "in the customer's bucket" and will
// be allocated by a future payment.

console.log('--- Contracts with total overpaid in range 100-1000 (not huge), up to 5 samples ---');
const [rows] = await c.execute(`
  SELECT p.contract_external_id,
         MAX(CAST(JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS DECIMAL(18,2))) AS per_payment_overpaid
    FROM payment_transactions p
   WHERE p.section='Boonphone'
     AND CAST(JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) > 100
     AND CAST(JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) < 1000
   GROUP BY p.contract_external_id
   LIMIT 5
`);
for (const row of rows) {
  const ext = row.contract_external_id;
  console.log(`\n===== Contract ${ext} (max overpaid/pay = ${row.per_payment_overpaid}) =====`);

  const [contract] = await c.execute(`
    SELECT external_id, installment_amount FROM contracts
     WHERE section='Boonphone' AND external_id=? LIMIT 1
  `, [ext]);
  console.log('baseline installment_amount:', contract[0]?.installment_amount);

  const [insts] = await c.execute(`
    SELECT period, due_date, amount, paid_amount, status
      FROM installments
     WHERE section='Boonphone' AND contract_external_id=?
     ORDER BY period
  `, [ext]);
  console.log('installments:');
  console.table(insts.map(i => ({
    p: i.period, due: i.due_date, amt: i.amount, paid: i.paid_amount, st: i.status,
  })));

  const [pays] = await c.execute(`
    SELECT paid_at,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           CAST(amount AS DECIMAL(18,2)) AS total,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid,
           CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt
      FROM payment_transactions
     WHERE section='Boonphone' AND contract_external_id=?
     ORDER BY paid_at
  `, [ext]);
  console.log('payments:');
  console.table(pays.map(p => ({
    at: p.paid_at, rcp: p.receipt_no, total: p.total, overpaid: p.overpaid, close: p.close_amt,
  })));
}

await c.end();

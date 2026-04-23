import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: url.username, password: url.password,
  database: url.pathname.slice(1), ssl: { rejectUnauthorized: true }
});

// The UI shows period 2 with: principal=331.58, interest=431.05, fee=47.37, amount=810
// These are scaled values. baseline for period 2 would be around 1710 (700+910+100)
// The scaling suggests overpaid carry from period 1 reduced period 2 amount to 810
// overpaid = 1710 - 810 = 900

// Find contracts where period 1 has overpaid_amount ~900 and period 1 amount=1710
const [rows] = await conn.execute(`
  SELECT i.contract_external_id, i.period, i.due_date, i.amount, i.paid_amount,
         JSON_EXTRACT(i.raw_json, '$.principal_due') as principal_due,
         JSON_EXTRACT(i.raw_json, '$.interest_due') as interest_due,
         JSON_EXTRACT(i.raw_json, '$.fee_due') as fee_due,
         JSON_EXTRACT(i.raw_json, '$.penalty_due') as penalty_due,
         JSON_EXTRACT(i.raw_json, '$.overpaid_amount') as overpaid_amount,
         c.finance_amount, c.installment_count
  FROM installments i
  JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
  WHERE i.section = 'Boonphone' 
    AND i.period = 1
    AND ABS(i.amount - 1710) < 5
    AND CAST(JSON_EXTRACT(i.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) > 800
  LIMIT 5
`);

console.log('Contracts with period 1 amount~1710 and overpaid~900:');
for (const r of rows) {
  console.log('Contract', r.contract_external_id, 'P1:', JSON.stringify(r));
  // Also get period 2
  const [p2rows] = await conn.execute(`
    SELECT i.period, i.due_date, i.amount, i.paid_amount,
           JSON_EXTRACT(i.raw_json, '$.principal_due') as principal_due,
           JSON_EXTRACT(i.raw_json, '$.interest_due') as interest_due,
           JSON_EXTRACT(i.raw_json, '$.fee_due') as fee_due,
           JSON_EXTRACT(i.raw_json, '$.overpaid_amount') as overpaid_amount
    FROM installments i
    WHERE i.section = 'Boonphone' AND i.contract_external_id = ? AND i.period = 2
  `, [r.contract_external_id]);
  if (p2rows.length > 0) console.log('  P2:', JSON.stringify(p2rows[0]));
}

// Also investigate: why does period 1 show amount=0 in the UI?
// Find contracts where period 1 amount=1710 but paid=1710 (paid in full)
const [paidRows] = await conn.execute(`
  SELECT i.contract_external_id, i.period, i.due_date, i.amount, i.paid_amount,
         JSON_EXTRACT(i.raw_json, '$.principal_due') as principal_due,
         JSON_EXTRACT(i.raw_json, '$.interest_due') as interest_due,
         JSON_EXTRACT(i.raw_json, '$.fee_due') as fee_due,
         JSON_EXTRACT(i.raw_json, '$.overpaid_amount') as overpaid_amount
  FROM installments i
  WHERE i.section = 'Boonphone' 
    AND i.period = 1
    AND i.due_date = '2026-03-16'
    AND ABS(i.amount - 1710) < 5
    AND i.paid_amount >= 1700
  LIMIT 5
`);
console.log('\nContracts with period 1 amount~1710 due 2026-03-16 PAID:');
paidRows.forEach(r => console.log(JSON.stringify(r)));

await conn.end();

import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: url.username, password: url.password,
  database: url.pathname.slice(1), ssl: { rejectUnauthorized: true }
});

// The UI row shows: period 2, due 2026-04-16, principal=331.58, interest=431.05, fee=47.37, amount=810
// 331.58+431.05+47.37 = 810.00 exactly → this is NOT a scaling issue, the sub-fields sum to amount
// So the API actually sent amount=810 for this period
// The issue is: period 1 (due 2026-03-16) shows amount=1710 (700+910+100) in the UI
// But in the screenshot, period 1 shows amount=0 (blank/zero)

// Let's find contracts where period 2 due 2026-04-16 has principal~331, interest~431, fee~47
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
    AND i.period = 2
    AND i.due_date = '2026-04-16'
  LIMIT 20
`);

console.log('All period 2 due 2026-04-16 contracts:');
for (const r of rows) {
  const p = Number(r.principal_due ?? 0);
  const i2 = Number(r.interest_due ?? 0);
  const f = Number(r.fee_due ?? 0);
  console.log(`Contract ${r.contract_external_id}: amount=${r.amount} paid=${r.paid_amount} principal=${p} interest=${i2} fee=${f} overpaid=${r.overpaid_amount} finance=${r.finance_amount} count=${r.installment_count}`);
}

// Also check: what does the row with period 1 due 2026-03-16 amount=1710 look like?
// From the screenshot: period 1 shows 700+910+100=1710 in the UI
// Let's find contracts where period 1 due 2026-03-16 amount=1710
const [p1rows] = await conn.execute(`
  SELECT i.contract_external_id, i.period, i.due_date, i.amount, i.paid_amount,
         JSON_EXTRACT(i.raw_json, '$.principal_due') as principal_due,
         JSON_EXTRACT(i.raw_json, '$.interest_due') as interest_due,
         JSON_EXTRACT(i.raw_json, '$.fee_due') as fee_due,
         JSON_EXTRACT(i.raw_json, '$.overpaid_amount') as overpaid_amount,
         c.finance_amount, c.installment_count
  FROM installments i
  JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
  WHERE i.section = 'Boonphone' 
    AND i.period = 1
    AND i.due_date = '2026-03-16'
    AND ABS(i.amount - 1710) < 10
  LIMIT 10
`);

console.log('\nPeriod 1 due 2026-03-16 amount~1710:');
for (const r of p1rows) {
  console.log(`Contract ${r.contract_external_id}: amount=${r.amount} paid=${r.paid_amount} principal=${r.principal_due} interest=${r.interest_due} fee=${r.fee_due} overpaid=${r.overpaid_amount} finance=${r.finance_amount} count=${r.installment_count}`);
}

await conn.end();

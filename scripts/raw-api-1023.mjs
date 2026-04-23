import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: url.username, password: url.password,
  database: url.pathname.slice(1), ssl: { rejectUnauthorized: true }
});

// Get all installments with full raw_json for this contract
const [rows] = await conn.execute(`
  SELECT
    i.period,
    i.due_date,
    CAST(i.amount AS DECIMAL(18,2)) AS amount,
    CAST(i.paid_amount AS DECIMAL(18,2)) AS paid_amount,
    JSON_EXTRACT(i.raw_json, '$.principal_due')    AS principal_due,
    JSON_EXTRACT(i.raw_json, '$.interest_due')     AS interest_due,
    JSON_EXTRACT(i.raw_json, '$.fee_due')          AS fee_due,
    JSON_EXTRACT(i.raw_json, '$.penalty_due')      AS penalty_due,
    JSON_EXTRACT(i.raw_json, '$.unlock_fee_due')   AS unlock_fee_due,
    JSON_EXTRACT(i.raw_json, '$.overpaid_amount')  AS overpaid_amount,
    JSON_EXTRACT(i.raw_json, '$.close_installment_amount') AS close_installment_amount,
    JSON_EXTRACT(i.raw_json, '$.discount_amount')  AS discount_amount,
    JSON_EXTRACT(i.raw_json, '$.status')           AS status
  FROM installments i
  WHERE i.section = 'Boonphone'
    AND i.contract_external_id = 1075
  ORDER BY i.period
`);

console.log('=== CT0226-SRI004-1023-01 (ID: 1075) — ข้อมูล API ทุกงวด ===\n');

for (const r of rows) {
  console.log(`--- งวดที่ ${r.period} (due: ${r.due_date}) ---`);
  console.log(`  amount (ยอดงวด)          : ${r.amount}`);
  console.log(`  paid_amount (ชำระแล้ว)  : ${r.paid_amount}`);
  console.log(`  principal_due (เงินต้น)  : ${r.principal_due}`);
  console.log(`  interest_due (ดอกเบี้ย) : ${r.interest_due}`);
  console.log(`  fee_due (ค่าดำเนินการ)  : ${r.fee_due}`);
  console.log(`  penalty_due (ค่าปรับ)   : ${r.penalty_due}`);
  console.log(`  unlock_fee_due (ค่าปลดล็อก): ${r.unlock_fee_due}`);
  console.log(`  overpaid_amount (ชำระเกิน): ${r.overpaid_amount}`);
  console.log(`  close_installment_amount : ${r.close_installment_amount}`);
  console.log(`  discount_amount          : ${r.discount_amount}`);
  console.log(`  status                   : ${r.status}`);
  console.log('');
}

// Also show payment transactions
const [payments] = await conn.execute(`
  SELECT
    receipt_no,
    CAST(amount AS DECIMAL(18,2)) AS amount,
    paid_at,
    JSON_EXTRACT(raw_json, '$.overpaid_amount') AS overpaid_amount,
    JSON_EXTRACT(raw_json, '$.period') AS period_in_receipt
  FROM payment_transactions
  WHERE section = 'Boonphone'
    AND contract_external_id = 1075
  ORDER BY paid_at, receipt_no
`);

console.log('=== Payment Transactions ===\n');
for (const p of payments) {
  console.log(`  receipt: ${p.receipt_no}`);
  console.log(`  amount: ${p.amount}, paid_at: ${p.paid_at}`);
  console.log(`  overpaid_amount: ${p.overpaid_amount}`);
  console.log(`  period_in_receipt: ${p.period_in_receipt}`);
  console.log('');
}

await conn.end();

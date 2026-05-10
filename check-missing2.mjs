import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ตรวจสอบว่า 186 rows ที่หายไปมียอดรวมเท่าไหร่
const [missing] = await conn.query(`
  SELECT COUNT(*) as cnt, SUM(pt.amount) as total_amount
  FROM payment_transactions pt
  LEFT JOIN debt_collected_cache dcc ON dcc.payment_external_id = pt.external_id AND dcc.section = pt.section
  WHERE pt.section = 'Fastfone365' AND dcc.id IS NULL
`);
console.log(`=== payment_transactions ที่ไม่มีใน cache ===`);
console.log(`  count: ${missing[0].cnt}, total: ${Number(missing[0].total_amount).toFixed(2)}`);

// ตรวจสอบ rows ที่ total_amount = 0 แต่ breakdown > 0 (bad_debt rows)
const [zeroTotal] = await conn.query(`
  SELECT COUNT(*) as cnt, 
    SUM(principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) as breakdown_sum,
    SUM(bad_debt) as bad_debt_sum,
    SUM(discount) as discount_sum
  FROM debt_collected_cache
  WHERE section = 'Fastfone365' AND total_amount = 0
`);
console.log(`\n=== rows ที่ total_amount = 0 ===`);
console.log(`  count: ${zeroTotal[0].cnt}, breakdown: ${Number(zeroTotal[0].breakdown_sum).toFixed(2)}, bad_debt: ${Number(zeroTotal[0].bad_debt_sum).toFixed(2)}, discount: ${Number(zeroTotal[0].discount_sum).toFixed(2)}`);

// ตรวจสอบว่า rows ที่ total_amount = 0 มี is_bad_debt_row = true หรือไม่
const [badDebtRows] = await conn.query(`
  SELECT is_bad_debt_row, is_close_row, COUNT(*) as cnt, SUM(total_amount) as total, SUM(bad_debt) as bad_debt_sum
  FROM debt_collected_cache
  WHERE section = 'Fastfone365' AND total_amount = 0
  GROUP BY is_bad_debt_row, is_close_row
`);
console.log(`\n=== rows ที่ total_amount = 0 แยกตาม is_bad_debt_row/is_close_row ===`);
for (const r of badDebtRows) {
  console.log(`  is_bad_debt=${r.is_bad_debt_row}, is_close=${r.is_close_row}: cnt=${r.cnt}, total=${Number(r.total).toFixed(2)}, bad_debt=${Number(r.bad_debt_sum).toFixed(2)}`);
}

// ดูตัวอย่าง rows ที่ total_amount = 0 แต่ breakdown > 0
const [sample] = await conn.query(`
  SELECT payment_external_id, contract_external_id, period, paid_at, 
    principal, interest, fee, penalty, unlock_fee, overpaid, bad_debt, discount, total_amount, payment_tx_amount,
    is_bad_debt_row, is_close_row
  FROM debt_collected_cache
  WHERE section = 'Fastfone365' AND total_amount = 0 AND bad_debt > 0
  LIMIT 5
`);
console.log(`\n=== ตัวอย่าง rows ที่ total_amount = 0 และ bad_debt > 0 ===`);
for (const r of sample) {
  console.log(`  ${r.payment_external_id} (${r.paid_at}): bad_debt=${Number(r.bad_debt).toFixed(2)}, total=${Number(r.total_amount).toFixed(2)}, is_bad_debt=${r.is_bad_debt_row}`);
}

// ตรวจสอบว่า payment_tx_amount ใน cache ตรงกับ payment_transactions.amount หรือไม่
const [ptCheck] = await conn.query(`
  SELECT COUNT(*) as cnt, SUM(dcc.payment_tx_amount) as cache_total, SUM(pt.amount) as pt_total
  FROM debt_collected_cache dcc
  JOIN payment_transactions pt ON pt.external_id = dcc.payment_external_id AND pt.section = dcc.section
  WHERE dcc.section = 'Fastfone365'
`);
console.log(`\n=== payment_tx_amount ใน cache vs payment_transactions.amount ===`);
console.log(`  count: ${ptCheck[0].cnt}, cache_total: ${Number(ptCheck[0].cache_total).toFixed(2)}, pt_total: ${Number(ptCheck[0].pt_total).toFixed(2)}`);

await conn.end();

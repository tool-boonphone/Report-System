import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// หา payment_transactions ที่ไม่มีใน debt_collected_cache
const [missing] = await conn.query(`
  SELECT pt.external_id, pt.contract_external_id, pt.paid_at, pt.amount, pt.section
  FROM payment_transactions pt
  LEFT JOIN debt_collected_cache dcc ON dcc.payment_external_id = pt.external_id AND dcc.section = pt.section
  WHERE pt.section = 'Fastfone365' AND dcc.id IS NULL
  ORDER BY pt.paid_at DESC
  LIMIT 20
`);
console.log(`=== ${missing.length} payment_transactions ที่ไม่มีใน cache (top 20) ===`);
for (const r of missing) {
  console.log(`  ${r.external_id} contract=${r.contract_external_id} paid=${r.paid_at} amount=${Number(r.amount).toFixed(2)}`);
}

// นับทั้งหมด
const [cnt] = await conn.query(`
  SELECT COUNT(*) as cnt, SUM(pt.amount) as total_amount
  FROM payment_transactions pt
  LEFT JOIN debt_collected_cache dcc ON dcc.payment_external_id = pt.external_id AND dcc.section = pt.section
  WHERE pt.section = 'Fastfone365' AND dcc.id IS NULL
`);
console.log(`\n=== ยอดรวม payment_transactions ที่ไม่มีใน cache ===`);
console.log(`  count: ${cnt[0].cnt}, total: ${Number(cnt[0].total_amount).toFixed(2)}`);

// ตรวจสอบ breakdown vs total_amount ใน cache
const [diff] = await conn.query(`
  SELECT 
    SUM(principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) as breakdown_sum,
    SUM(total_amount) as total_amount_sum,
    SUM(payment_tx_amount) as payment_tx_sum,
    SUM(principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) - SUM(total_amount) as diff
  FROM debt_collected_cache
  WHERE section = 'Fastfone365'
`);
const d = diff[0];
console.log(`\n=== breakdown vs total_amount ใน cache (Fastfone365) ===`);
console.log(`  breakdown: ${Number(d.breakdown_sum).toFixed(2)}`);
console.log(`  total_amount: ${Number(d.total_amount_sum).toFixed(2)}`);
console.log(`  payment_tx_amount: ${Number(d.payment_tx_sum).toFixed(2)}`);
console.log(`  diff (breakdown - total_amount): ${Number(d.diff).toFixed(2)}`);

// ดู rows ที่ breakdown != total_amount
const [diffRows] = await conn.query(`
  SELECT * FROM (
    SELECT 
      payment_external_id, contract_external_id, period, paid_at,
      principal, interest, fee, penalty, unlock_fee, overpaid, bad_debt, discount,
      total_amount, payment_tx_amount,
      (principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) as breakdown_sum
    FROM debt_collected_cache
    WHERE section = 'Fastfone365'
  ) sub
  WHERE ABS(sub.breakdown_sum - sub.total_amount) > 0.01
  LIMIT 10
`);
console.log(`\n=== rows ที่ breakdown != total_amount (top 10) ===`);
for (const r of diffRows) {
  const diff2 = Number(r.breakdown_sum) - Number(r.total_amount);
  console.log(`  ${r.payment_external_id} (${r.paid_at}): breakdown=${Number(r.breakdown_sum).toFixed(2)}, total=${Number(r.total_amount).toFixed(2)}, diff=${diff2.toFixed(2)}, discount=${Number(r.discount).toFixed(2)}`);
}

await conn.end();

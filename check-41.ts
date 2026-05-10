import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL!);

// debt_collected_cache columns: principal, interest, fee, penalty, unlock_fee, overpaid, bad_debt, discount, total_amount, payment_tx_amount
// ไม่ใช่ principal_amount, interest_amount ฯลฯ

// ดู 41 สัญญาที่ breakdown ไม่ตรงกับ payment_transactions.amount
const [rows] = await conn.query(`
  SELECT * FROM (
    SELECT 
      c.contract_external_id,
      c.section,
      SUM(c.principal + c.interest + c.fee + c.penalty + c.unlock_fee + c.overpaid + c.bad_debt) as breakdown_sum,
      SUM(c.total_amount) as total_amount_sum,
      SUM(c.payment_tx_amount) as payment_tx_sum,
      SUM(pt.amount) as pt_sum,
      COUNT(*) as row_cnt
    FROM debt_collected_cache c
    LEFT JOIN payment_transactions pt ON pt.contract_external_id = c.contract_external_id AND pt.section = 'ff365'
    WHERE c.section = 'ff365'
    GROUP BY c.contract_external_id, c.section
  ) sub
  WHERE ABS(sub.breakdown_sum - sub.pt_sum) > 0.01
  ORDER BY ABS(sub.breakdown_sum - sub.pt_sum) DESC
  LIMIT 20
`) as any;

const rowArr = rows as any[];
console.log(`=== ${rowArr.length} สัญญาที่ breakdown ไม่ตรงกับ payment_transactions ===`);
for (const r of rowArr) {
  const diff = Number(r.breakdown_sum) - Number(r.pt_sum);
  console.log(`  ${r.contract_external_id}: breakdown=${Number(r.breakdown_sum).toFixed(2)}, total_amount=${Number(r.total_amount_sum).toFixed(2)}, payment_tx=${Number(r.payment_tx_sum).toFixed(2)}, pt=${Number(r.pt_sum).toFixed(2)}, diff=${diff.toFixed(2)}`);
}

// ดู payment rows ของสัญญาแรกที่ไม่ตรง
if (rowArr.length > 0) {
  const contractId = rowArr[0].contract_external_id;
  console.log(`\n=== Payment rows ของสัญญา ${contractId} ===`);
  const [detail] = await conn.query(`
    SELECT 
      c.period,
      c.paid_at,
      c.principal, c.interest, c.fee, c.penalty, 
      c.unlock_fee, c.overpaid, c.bad_debt, c.discount,
      c.total_amount,
      c.payment_tx_amount,
      (c.principal + c.interest + c.fee + c.penalty + c.unlock_fee + c.overpaid + c.bad_debt) as breakdown_sum
    FROM debt_collected_cache c
    WHERE c.contract_external_id = ?
    ORDER BY c.period
  `, [contractId]) as any;
  for (const d of detail as any[]) {
    console.log(`  งวด ${d.period} (${d.paid_at}): breakdown=${Number(d.breakdown_sum).toFixed(2)}, total_amount=${Number(d.total_amount).toFixed(2)}, payment_tx=${Number(d.payment_tx_amount).toFixed(2)}, discount=${Number(d.discount).toFixed(2)}`);
  }

  // ดู payment_transactions ของสัญญานั้น
  console.log(`\n=== payment_transactions ของสัญญา ${contractId} ===`);
  const [pt] = await conn.query(`
    SELECT paid_at, amount, section, period_no FROM payment_transactions 
    WHERE contract_external_id = ? AND section = 'ff365'
    ORDER BY paid_at
  `, [contractId]) as any;
  for (const p of pt as any[]) {
    console.log(`  ${p.paid_at} period=${p.period_no}: amount=${Number(p.amount).toFixed(2)}`);
  }
}

// ตรวจสอบยอดรวมทั้งหมด
console.log("\n=== ยอดรวมทั้งหมด ===");
const [totals] = await conn.query(`
  SELECT 
    SUM(c.principal + c.interest + c.fee + c.penalty + c.unlock_fee + c.overpaid + c.bad_debt) as total_breakdown,
    SUM(c.total_amount) as total_cache,
    SUM(c.payment_tx_amount) as total_payment_tx
  FROM debt_collected_cache c
  WHERE c.section = 'ff365'
`) as any;
const t = (totals as any[])[0];
console.log(`  breakdown sum (ff365): ${Number(t.total_breakdown).toFixed(2)}`);
console.log(`  cache total_amount sum (ff365): ${Number(t.total_cache).toFixed(2)}`);
console.log(`  cache payment_tx_amount sum (ff365): ${Number(t.total_payment_tx).toFixed(2)}`);

// ยอดรวม payment_transactions ทั้งหมด (ทุก section)
const [ptAll] = await conn.query(`
  SELECT section, SUM(amount) as total_pt FROM payment_transactions GROUP BY section
`) as any;
for (const p of ptAll as any[]) {
  console.log(`  payment_transactions sum (${p.section}): ${Number(p.total_pt).toFixed(2)}`);
}

// ยอดรวม breakdown ทุก section
const [cacheAll] = await conn.query(`
  SELECT section, 
    SUM(principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) as breakdown_sum,
    SUM(total_amount) as total_amount_sum,
    SUM(payment_tx_amount) as payment_tx_sum
  FROM debt_collected_cache 
  GROUP BY section
`) as any;
for (const c of cacheAll as any[]) {
  console.log(`  cache breakdown sum (${c.section}): ${Number(c.breakdown_sum).toFixed(2)}, total_amount: ${Number(c.total_amount_sum).toFixed(2)}, payment_tx: ${Number(c.payment_tx_sum).toFixed(2)}`);
}

await conn.end();
process.exit(0);

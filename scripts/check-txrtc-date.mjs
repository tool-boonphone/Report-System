import mysql from "mysql2/promise";
const pool = mysql.createPool(process.env.DATABASE_URL);

// ดึงวันที่ชำระ TXRTC ทั้งหมด
const [txrtc] = await pool.execute(`
  SELECT 
    JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
    amount,
    CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_inst,
    DATE_FORMAT(paid_at, '%Y-%m-%d') AS paid_date
  FROM payment_transactions
  WHERE contract_external_id = '20980'
    AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRTC%'
  ORDER BY paid_at ASC
`);

console.log("=== TXRTC Payments ===");
for (const r of txrtc) {
  console.log(`  ${r.receipt_no}: amount=${r.amount}, close_inst=${r.close_inst}, paid_date=${r.paid_date}`);
}

// ดึงวันดิวของแต่ละงวด (installments)
const [insts] = await pool.execute(`
  SELECT period, MAX(amount) AS amount, MIN(due_date) AS due_date
  FROM installments
  WHERE contract_external_id = '20980'
  GROUP BY period
  ORDER BY period ASC
`);

console.log("\n=== Installments due dates ===");
for (const r of insts) {
  console.log(`  Period ${r.period}: amount=${r.amount}, due_date=${r.due_date}`);
}

await pool.end();

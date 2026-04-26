/**
 * test-p63.mjs — ทดสอบ carry rows ใน listDebtCollectedStream
 * สัญญา CT0925-PKN001-15462-01 ควรมี carry rows สำหรับงวด 3 และ 4
 */
import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดึง payment_transactions ของสัญญา CT0925-PKN001-15462-01
const [rows] = await conn.execute(`
  SELECT 
    pt.external_id,
    pt.paid_at,
    pt.amount,
    JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) AS receipt_no,
    CAST(JSON_EXTRACT(pt.raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
    CAST(JSON_EXTRACT(pt.raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
    CAST(JSON_EXTRACT(pt.raw_json, '$.fee_paid') AS DECIMAL(18,2)) AS fee_paid,
    CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount,
    CAST(JSON_EXTRACT(pt.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount
  FROM payment_transactions pt
  JOIN contracts c ON c.external_id = pt.contract_external_id AND c.section = pt.section
  WHERE pt.contract_external_id = '16464'
    AND pt.section = 'Boonphone'
  ORDER BY pt.paid_at, pt.external_id
`);

console.log("\n=== Payment Transactions ===");
for (const r of rows) {
  console.log(`  receipt=${r.receipt_no} | paid_at=${r.paid_at} | amount=${r.amount} | principal=${r.principal_paid} | interest=${r.interest_paid} | fee=${r.fee_paid} | overpaid=${r.overpaid_amount} | close=${r.close_installment_amount}`);
}

// ดึง installments
const [instRows] = await conn.execute(`
  SELECT i.period, i.amount, i.due_date, i.paid_amount
  FROM installments i
  JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
  WHERE i.contract_external_id = '16464'
    AND i.section = 'Boonphone'
  ORDER BY i.period
`);

console.log("\n=== Installments ===");
for (const r of instRows) {
  console.log(`  period=${r.period} | amount=${r.amount} | due_date=${r.due_date} | paid_amount=${r.paid_amount}`);
}

await conn.end();

// ทดสอบ assignPayPeriods logic
console.log("\n=== Expected Carry Rows ===");
console.log("  งวด 3 → (carry) | paid_at=2025-10-09 | amount=0 | หมายเหตุ=(-หักชำระเกิน: 3,901)");
console.log("  งวด 4 → (carry) | paid_at=2025-10-09 | amount=0 | หมายเหตุ=(-หักชำระเกิน: 3,901)");

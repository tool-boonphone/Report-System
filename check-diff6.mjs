import mysql from 'mysql2/promise';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await mysql.createConnection(DB_URL);

// เปรียบเทียบ c.status = 'หนี้เสีย' vs c.bad_debt_date IS NOT NULL
const [statusVsDate] = await conn.query(`
  SELECT 
    SUM(CASE WHEN c.status = 'หนี้เสีย' THEN 1 ELSE 0 END) AS status_bad_debt,
    SUM(CASE WHEN c.bad_debt_date IS NOT NULL THEN 1 ELSE 0 END) AS has_bad_debt_date,
    SUM(CASE WHEN c.status = 'หนี้เสีย' AND c.bad_debt_date IS NULL THEN 1 ELSE 0 END) AS status_but_no_date,
    SUM(CASE WHEN c.status != 'หนี้เสีย' AND c.bad_debt_date IS NOT NULL THEN 1 ELSE 0 END) AS date_but_not_status
  FROM contracts
  WHERE section = 'Fastfone365'
`);
console.log('status หนี้เสีย vs bad_debt_date:', JSON.stringify(statusVsDate[0]));

// ยอดขายเครื่องจาก PT_INCOME_TYPE_CASE (ใช้ c.status = 'หนี้เสีย')
const [ptByStatus] = await conn.query(`
  SELECT SUM(pt.amount) AS total
  FROM payment_transactions pt
  JOIN (
    SELECT inner_q.contract_no, inner_q.last_paid_date, inner_q.last_created_at
    FROM (
      SELECT pt2.contract_no, DATE(pt2.paid_at) AS last_paid_date, pt2.created_at AS last_created_at,
             ROW_NUMBER() OVER (PARTITION BY pt2.contract_no, pt2.section ORDER BY pt2.paid_at DESC, pt2.created_at DESC) AS rn
      FROM payment_transactions pt2
      WHERE pt2.section = 'Fastfone365' AND JSON_EXTRACT(pt2.raw_json, '$.source') IS NULL
    ) inner_q WHERE inner_q.rn = 1
  ) bdl ON pt.contract_no = bdl.contract_no AND DATE(pt.paid_at) = bdl.last_paid_date AND pt.created_at = bdl.last_created_at
  JOIN contracts c ON c.external_id = pt.contract_external_id AND c.section = 'Fastfone365'
  WHERE pt.section = 'Fastfone365'
    AND c.status = 'หนี้เสีย'
    AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
`);
console.log('PT_INCOME_TYPE_CASE (c.status = หนี้เสีย):', ptByStatus[0].total);

// ยอดขายเครื่องจาก runner.ts (ทุก payment วันสุดท้าย, ใช้ c.status = 'หนี้เสีย')
const [runnerByStatus] = await conn.query(`
  SELECT SUM(pt.amount) AS total
  FROM payment_transactions pt
  JOIN (
    SELECT pt2.contract_external_id, MAX(DATE(pt2.paid_at)) AS max_date
    FROM payment_transactions pt2
    JOIN contracts c2 ON c2.external_id = pt2.contract_external_id AND c2.section = 'Fastfone365'
    WHERE pt2.section = 'Fastfone365' AND c2.status = 'หนี้เสีย'
      AND JSON_EXTRACT(pt2.raw_json, '$.source') IS NULL
    GROUP BY pt2.contract_external_id
  ) ld ON pt.contract_external_id = ld.contract_external_id AND DATE(pt.paid_at) = ld.max_date
  WHERE pt.section = 'Fastfone365' AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
`);
console.log('Runner.ts (c.status = หนี้เสีย, ทุก payment วันสุดท้าย):', runnerByStatus[0].total);

// ผลต่าง
const pt = Number(ptByStatus[0].total);
const runner = Number(runnerByStatus[0].total);
console.log(`\nผลต่าง: ${(runner - pt).toFixed(2)}`);

await conn.end();

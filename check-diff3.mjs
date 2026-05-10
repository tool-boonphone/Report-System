import mysql from 'mysql2/promise';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await mysql.createConnection(DB_URL);

// ตรวจสอบ bad_debt contracts ก่อน
const [bdCount] = await conn.query(`
  SELECT COUNT(*) as cnt, SUM(bad_debt_amount) as total_bad_debt
  FROM contracts
  WHERE section = 'Fastfone365' AND bad_debt_date IS NOT NULL
`);
console.log('Bad debt contracts:', JSON.stringify(bdCount[0]));

// ยอดรวมจาก PT_INCOME_TYPE_CASE logic (ใช้ subquery)
const [ptTotal] = await conn.query(`
  SELECT SUM(pt.amount) AS total
  FROM payment_transactions pt
  JOIN (
    SELECT contract_external_id,
           MAX(DATE(paid_at)) AS last_paid_date,
           MAX(created_at) AS last_created_at
    FROM payment_transactions
    WHERE section = 'Fastfone365'
    GROUP BY contract_external_id
  ) lb ON pt.contract_external_id = lb.contract_external_id
    AND DATE(pt.paid_at) = lb.last_paid_date
    AND pt.created_at = lb.last_created_at
  JOIN contracts c ON c.external_id = pt.contract_external_id AND c.section = 'Fastfone365'
  WHERE pt.section = 'Fastfone365'
    AND c.bad_debt_date IS NOT NULL
`);
console.log('PT_INCOME_TYPE_CASE total:', ptTotal[0].total);

// ยอดรวมจาก runner.ts logic เดิม (วันสุดท้าย ทุก payment, ไม่กรอง pay-)
const [runnerTotal] = await conn.query(`
  SELECT SUM(pt.amount) AS total
  FROM payment_transactions pt
  JOIN (
    SELECT pt2.contract_external_id,
           MAX(DATE(pt2.paid_at)) AS last_paid_date
    FROM payment_transactions pt2
    JOIN contracts c2 ON c2.external_id = pt2.contract_external_id AND c2.section = 'Fastfone365'
    WHERE pt2.section = 'Fastfone365'
      AND c2.bad_debt_date IS NOT NULL
    GROUP BY pt2.contract_external_id
  ) ld ON pt.contract_external_id = ld.contract_external_id
    AND DATE(pt.paid_at) = ld.last_paid_date
  WHERE pt.section = 'Fastfone365'
`);
console.log('Runner.ts (เดิม, วันสุดท้ายทุก payment) total:', runnerTotal[0].total);

// ยอดรวมจาก runner.ts logic ใหม่ (วันสุดท้าย + MAX created_at)
const [runnerNewTotal] = await conn.query(`
  SELECT SUM(pt.amount) AS total
  FROM payment_transactions pt
  JOIN (
    SELECT pt2.contract_external_id,
           MAX(DATE(pt2.paid_at)) AS last_paid_date,
           MAX(pt2.created_at) AS last_created_at
    FROM payment_transactions pt2
    JOIN contracts c2 ON c2.external_id = pt2.contract_external_id AND c2.section = 'Fastfone365'
    WHERE pt2.section = 'Fastfone365'
      AND c2.bad_debt_date IS NOT NULL
    GROUP BY pt2.contract_external_id
  ) ld ON pt.contract_external_id = ld.contract_external_id
    AND DATE(pt.paid_at) = ld.last_paid_date
    AND pt.created_at = ld.last_created_at
  WHERE pt.section = 'Fastfone365'
`);
console.log('Runner.ts (ใหม่ + MAX created_at) total:', runnerNewTotal[0].total);

await conn.end();

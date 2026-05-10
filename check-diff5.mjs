import mysql from 'mysql2/promise';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await mysql.createConnection(DB_URL);

// หาสัญญาที่ payment วันสุดท้ายมี created_at ต่างกัน (หลาย batch ในวันเดียวกัน)
// สำหรับสัญญาหนี้เสีย
const [multiCreated] = await conn.query(`
  SELECT 
    pt.contract_external_id,
    DATE(pt.paid_at) AS last_date,
    COUNT(DISTINCT pt.created_at) AS distinct_created_at,
    COUNT(*) AS payment_count,
    SUM(pt.amount) AS total_all,
    MAX(pt.created_at) AS max_created_at
  FROM payment_transactions pt
  JOIN (
    SELECT pt2.contract_external_id, MAX(DATE(pt2.paid_at)) AS max_date
    FROM payment_transactions pt2
    JOIN contracts c2 ON c2.external_id = pt2.contract_external_id AND c2.section = 'Fastfone365'
    WHERE pt2.section = 'Fastfone365'
      AND c2.bad_debt_date IS NOT NULL
      AND JSON_EXTRACT(pt2.raw_json, '$.source') IS NULL
    GROUP BY pt2.contract_external_id
  ) ld ON pt.contract_external_id = ld.contract_external_id
    AND DATE(pt.paid_at) = ld.max_date
  WHERE pt.section = 'Fastfone365'
    AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
  GROUP BY pt.contract_external_id, DATE(pt.paid_at)
  HAVING COUNT(DISTINCT pt.created_at) > 1
  LIMIT 20
`);
console.log(`\nสัญญาที่มีหลาย created_at ในวันสุดท้าย: ${multiCreated.length} สัญญา`);
multiCreated.forEach(r => {
  console.log(`  ${r.contract_external_id}: last_date=${r.last_date}, distinct_created=${r.distinct_created_at}, count=${r.payment_count}, total=${r.total_all}`);
});

// คำนวณผลต่างระหว่าง runner.ts (ทุก payment วันสุดท้าย) vs PT_INCOME_TYPE_CASE (MAX created_at เท่านั้น)
const [diffTotal] = await conn.query(`
  SELECT 
    SUM(all_last_day.total_all) AS runner_total,
    SUM(max_batch.total_max_created) AS pt_total,
    SUM(all_last_day.total_all) - SUM(max_batch.total_max_created) AS diff
  FROM (
    SELECT pt.contract_external_id, SUM(pt.amount) AS total_all
    FROM payment_transactions pt
    JOIN (
      SELECT pt2.contract_external_id, MAX(DATE(pt2.paid_at)) AS max_date
      FROM payment_transactions pt2
      JOIN contracts c2 ON c2.external_id = pt2.contract_external_id AND c2.section = 'Fastfone365'
      WHERE pt2.section = 'Fastfone365' AND c2.bad_debt_date IS NOT NULL
        AND JSON_EXTRACT(pt2.raw_json, '$.source') IS NULL
      GROUP BY pt2.contract_external_id
    ) ld ON pt.contract_external_id = ld.contract_external_id AND DATE(pt.paid_at) = ld.max_date
    WHERE pt.section = 'Fastfone365' AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
    GROUP BY pt.contract_external_id
  ) all_last_day
  JOIN (
    SELECT pt.contract_external_id, SUM(pt.amount) AS total_max_created
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
    WHERE pt.section = 'Fastfone365' AND c.bad_debt_date IS NOT NULL
      AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
    GROUP BY pt.contract_external_id
  ) max_batch ON all_last_day.contract_external_id = max_batch.contract_external_id
`);
console.log('\nผลต่างรวม:', JSON.stringify(diffTotal[0]));

await conn.end();

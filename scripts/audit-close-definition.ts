import 'dotenv/config';
import mysql from 'mysql2/promise';

const c = await mysql.createConnection(process.env.DATABASE_URL);

// Distribution of close_installment_amount / baseline ratio.
console.log('--- Distribution of close/baseline ratio ---');
const [rows] = await c.execute(`
  SELECT
    CASE
      WHEN close_amt / base < 1.5 THEN 'single-period (close = 1x baseline)'
      WHEN close_amt / base < 2.5 THEN 'close 2 periods'
      WHEN close_amt / base < 4.5 THEN 'close 3-4 periods'
      WHEN close_amt / base < 10 THEN 'close 5-9 periods'
      ELSE 'close >=10 periods'
    END AS bucket,
    COUNT(*) AS cnt
  FROM (
    SELECT
      CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
      CAST(ct.installment_amount AS DECIMAL(18,2)) AS base
    FROM payment_transactions p
    JOIN contracts ct ON ct.external_id = p.contract_external_id AND ct.section = p.section
   WHERE p.section = 'Boonphone'
     AND CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
     AND CAST(ct.installment_amount AS DECIMAL(18,2)) > 0
  ) sub
  GROUP BY bucket
  ORDER BY cnt DESC
`);
console.log(rows);

console.log('\n--- Sample payments for each bucket ---');
const [samples] = await c.execute(`
  SELECT p.contract_external_id,
         CAST(ct.installment_amount AS DECIMAL(18,2)) AS baseline,
         CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
         ROUND(CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) /
               CAST(ct.installment_amount AS DECIMAL(18,2)), 2) AS ratio,
         JSON_UNQUOTE(JSON_EXTRACT(p.raw_json, '$.receipt_no')) AS receipt_no,
         p.paid_at
    FROM payment_transactions p
    JOIN contracts ct ON ct.external_id = p.contract_external_id AND ct.section = p.section
   WHERE p.section = 'Boonphone'
     AND CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
     AND CAST(ct.installment_amount AS DECIMAL(18,2)) > 0
   ORDER BY ratio DESC
   LIMIT 15
`);
console.table(samples);

await c.end();

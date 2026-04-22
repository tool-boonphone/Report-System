import 'dotenv/config';
import mysql from 'mysql2/promise';

const c = await mysql.createConnection(process.env.DATABASE_URL);

// Question 1: for installments with status = paid / paid_amount ~= original
//   but amount < contracts.installment_amount, how many? That would be
//   cases where API reduced the per-period amount (overpaid carry).
// Question 2: cases where an installment's amount = 0 AND no close_installment
//   exists for previous periods → is that ever a thing?

console.log('--- Q1: distribution of (installments.amount vs contracts.installment_amount) ---');
const [q1] = await c.execute(`
  SELECT
    CASE
      WHEN i.amount = 0 THEN 'amount=0'
      WHEN ABS(CAST(i.amount AS DECIMAL(18,2)) - CAST(c.installment_amount AS DECIMAL(18,2))) < 0.01 THEN 'amount=baseline'
      WHEN CAST(i.amount AS DECIMAL(18,2)) < CAST(c.installment_amount AS DECIMAL(18,2)) THEN 'amount<baseline (reduced)'
      ELSE 'amount>baseline (weird)'
    END AS kind,
    COUNT(*) AS cnt
  FROM installments i
  JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
  WHERE i.section = 'Boonphone'
  GROUP BY kind
  ORDER BY cnt DESC
`);
console.log(q1);

console.log('\n--- Q2: amount=0 cases — is there ANY close-out payment for this contract? ---');
const [q2] = await c.execute(`
  SELECT SUB.has_close AS has_close, COUNT(*) AS cnt
  FROM (
    SELECT
      i.contract_external_id,
      i.period,
      CASE WHEN EXISTS (
        SELECT 1 FROM payment_transactions p
        WHERE p.contract_external_id = i.contract_external_id
          AND p.section = 'Boonphone'
          AND CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
      ) THEN 1 ELSE 0 END AS has_close
    FROM installments i
    WHERE i.section = 'Boonphone'
      AND CAST(i.amount AS DECIMAL(18,2)) = 0
  ) SUB
  GROUP BY SUB.has_close
`);
console.log(q2);

console.log('\n--- Q3: sample 5 contracts where at least one installment is amount=0 AND NO close-out payment ---');
const [q3] = await c.execute(`
  SELECT i.contract_external_id, i.period, i.due_date, i.amount, i.paid_amount, i.status AS inst_status,
         c.installment_amount AS baseline
    FROM installments i
    JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
   WHERE i.section = 'Boonphone'
     AND CAST(i.amount AS DECIMAL(18,2)) = 0
     AND NOT EXISTS (
       SELECT 1 FROM payment_transactions p
       WHERE p.contract_external_id = i.contract_external_id
         AND p.section = 'Boonphone'
         AND CAST(JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
     )
   ORDER BY i.contract_external_id, i.period
   LIMIT 20
`);
console.log(q3);

console.log('\n--- Q4: sample contracts where amount<baseline (reduced) — how did it reduce? ---');
const [q4] = await c.execute(`
  SELECT i.contract_external_id, i.period, i.due_date, i.amount, i.paid_amount,
         c.installment_amount AS baseline,
         (c.installment_amount - i.amount) AS deduction
    FROM installments i
    JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
   WHERE i.section = 'Boonphone'
     AND CAST(i.amount AS DECIMAL(18,2)) > 0
     AND CAST(i.amount AS DECIMAL(18,2)) < CAST(c.installment_amount AS DECIMAL(18,2))
   ORDER BY i.contract_external_id, i.period
   LIMIT 15
`);
console.log(q4);

console.log('\n--- Q5: for each of those reduced-amount contracts, is there an overpaid_amount in PREVIOUS periods? ---');
const [q5] = await c.execute(`
  SELECT i.contract_external_id, i.period, i.amount, c.installment_amount AS baseline,
         (SELECT SUM(CAST(JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)))
            FROM payment_transactions p
           WHERE p.contract_external_id = i.contract_external_id
             AND p.section = 'Boonphone'
             AND CAST(JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) > 0
         ) AS total_overpaid
    FROM installments i
    JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
   WHERE i.section = 'Boonphone'
     AND CAST(i.amount AS DECIMAL(18,2)) > 0
     AND CAST(i.amount AS DECIMAL(18,2)) < CAST(c.installment_amount AS DECIMAL(18,2))
   ORDER BY i.contract_external_id, i.period
   LIMIT 15
`);
console.log(q5);

await c.end();

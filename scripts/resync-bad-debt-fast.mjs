/**
 * Re-sync bad_debt_amount for FF365 contracts using a single SQL UPDATE.
 * Uses the LATEST real payment (numeric external_id, highest paid_at) per contract.
 *
 * Run: node scripts/resync-bad-debt-fast.mjs
 */
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('=== Re-sync bad_debt_amount for Fastfone365 (fast batch) ===\n');

// Single UPDATE using a subquery that finds the latest real payment per contract
const [result] = await conn.execute(`
  UPDATE contracts c
  JOIN (
    -- For each bad-debt contract, find the latest real payment
    SELECT
      pt.contract_external_id,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) AS new_amount,
      DATE(pt.paid_at) AS new_date
    FROM payment_transactions pt
    WHERE pt.section = 'Fastfone365'
      AND pt.external_id REGEXP '^[0-9]+$'
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) > 0
      AND pt.contract_external_id IN (
        -- Only contracts that have a synthetic bad-debt trigger
        SELECT DISTINCT contract_external_id
        FROM payment_transactions
        WHERE section = 'Fastfone365'
          AND external_id LIKE 'pay-%'
          AND status = 'ยกเลิกสัญญา'
      )
      AND pt.paid_at = (
        -- Latest paid_at for this contract
        SELECT MAX(pt2.paid_at)
        FROM payment_transactions pt2
        WHERE pt2.section = 'Fastfone365'
          AND pt2.contract_external_id = pt.contract_external_id
          AND pt2.external_id REGEXP '^[0-9]+$'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(pt2.raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) > 0
      )
  ) latest ON c.external_id = latest.contract_external_id
  SET
    c.bad_debt_amount = latest.new_amount,
    c.bad_debt_date   = latest.new_date
  WHERE c.section = 'Fastfone365'
    AND c.status IN ('หนี้เสีย', 'ยกเลิกสัญญา')
`);

console.log(`Updated ${result.affectedRows} rows`);

// Verify CT0126-SRI001-21064-01
const [check] = await conn.execute(`
  SELECT contract_no, bad_debt_amount, bad_debt_date
  FROM contracts
  WHERE section = 'Fastfone365'
    AND contract_no = 'CT0126-SRI001-21064-01'
`);
if (check.length > 0) {
  console.log('\nVerification CT0126-SRI001-21064-01:');
  console.log(`  bad_debt_amount = ${check[0].bad_debt_amount}`);
  console.log(`  bad_debt_date   = ${check[0].bad_debt_date}`);
  const ok = Number(check[0].bad_debt_amount) === 8000;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL — expected 8000'}`);
}

await conn.end();
console.log('\n=== Done ===');

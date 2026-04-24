/**
 * Re-sync bad_debt_amount for FF365 contracts using the new logic:
 *   bad_debt_amount = total_paid_amount of the LATEST real payment
 *   bad_debt_date   = paid_at of the LATEST real payment
 *
 * Run: node scripts/resync-bad-debt.mjs
 */
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('=== Re-sync bad_debt_amount for Fastfone365 ===\n');

// 1) Get all FF365 bad-debt contracts
const [contracts] = await conn.execute(`
  SELECT external_id, contract_no, bad_debt_amount, bad_debt_date
  FROM contracts
  WHERE section = 'Fastfone365'
    AND status IN ('หนี้เสีย', 'ยกเลิกสัญญา')
`);

console.log(`Found ${contracts.length} bad-debt contracts\n`);

let updated = 0;
let skipped = 0;

for (const c of contracts) {
  const extId = String(c.external_id);

  // 2) Check if there's a synthetic bad-debt trigger
  const [syntheticRows] = await conn.execute(`
    SELECT COUNT(*) AS cnt
    FROM payment_transactions
    WHERE contract_external_id = ?
      AND section = 'Fastfone365'
      AND external_id LIKE 'pay-%'
      AND status = 'ยกเลิกสัญญา'
  `, [extId]);

  if (Number(syntheticRows[0].cnt) === 0) {
    skipped++;
    continue;
  }

  // 3) Get real payments (numeric external_id, total_paid_amount > 0)
  const [realPayments] = await conn.execute(`
    SELECT external_id,
           paid_at,
           CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) AS total_paid_amount
    FROM payment_transactions
    WHERE contract_external_id = ?
      AND section = 'Fastfone365'
      AND external_id REGEXP '^[0-9]+$'
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) > 0
    ORDER BY paid_at DESC
    LIMIT 1
  `, [extId]);

  if (realPayments.length === 0) {
    skipped++;
    continue;
  }

  const latestReal = realPayments[0];
  const newAmount = Number(latestReal.total_paid_amount);
  const newDate = String(latestReal.paid_at ?? '').substring(0, 10);

  const oldAmount = Number(c.bad_debt_amount ?? 0);
  const oldDate = c.bad_debt_date ?? '';

  if (Math.abs(newAmount - oldAmount) < 0.01 && newDate === oldDate) {
    // No change needed
    skipped++;
    continue;
  }

  console.log(`${c.contract_no}: ${oldAmount} → ${newAmount} | ${oldDate} → ${newDate}`);

  await conn.execute(`
    UPDATE contracts
    SET bad_debt_amount = ?,
        bad_debt_date   = ?
    WHERE section = 'Fastfone365'
      AND external_id = ?
  `, [newAmount, newDate || null, extId]);

  updated++;
}

console.log(`\n=== Done: ${updated} updated, ${skipped} skipped ===`);
await conn.end();

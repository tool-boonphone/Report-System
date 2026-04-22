/**
 * Compare two contracts:
 *   - ext=2187 (สุทธิดา จงใจ) — false positive (no real overpaid carry)
 *   - ext=1496 — genuine overpaid carry to period 2
 *
 * Goal: confirm we should derive `overpaidApplied` from the SUM of
 * `overpaid_amount` in payments of period (P-1), not from
 * (baseline - amount) of period P.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL!);

const TARGETS = ['2187', '1496', '1517'];

for (const ext of TARGETS) {
  const [contracts] = await conn.execute(
    `SELECT external_id, contract_no, customer_name, installment_amount
     FROM contracts WHERE section='Boonphone' AND external_id=? LIMIT 1`,
    [ext]
  );
  const c = (contracts as any[])[0];
  if (!c) { console.log(`ext=${ext} not found`); continue; }
  console.log(`\n=== ${c.contract_no} ${c.customer_name} (ext=${ext}, baseline=${c.installment_amount}) ===`);

  const [insts] = await conn.execute(
    `SELECT period, amount, paid_amount,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.principal_due')) AS p_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.interest_due')) AS i_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fee_due')) AS fee_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.penalty_due')) AS pen_due
     FROM installments WHERE section='Boonphone' AND contract_external_id=?
     ORDER BY period ASC LIMIT 4`,
    [ext]
  );
  console.log('Installments:');
  console.table(insts);

  const [pays] = await conn.execute(
    `SELECT paid_at, amount,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.overpaid_amount')) AS overpaid,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.close_installment_amount')) AS close_amt
     FROM payment_transactions WHERE section='Boonphone' AND contract_external_id=?
     ORDER BY paid_at ASC`,
    [ext]
  );
  console.log('Payments:');
  console.table(pays);
}

process.exit(0);

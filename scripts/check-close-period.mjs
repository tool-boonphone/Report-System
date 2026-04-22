/**
 * Investigate how Boonphone's close_installment_amount flows into the DB:
 *   - Which payments carry close_installment_amount > 0?
 *   - What's the receipt_no (gives us the period number it was paid for)?
 *   - What does the installments table look like for those contracts —
 *     does the API report amount = 0 for periods AFTER the close period?
 *
 * The UI rule we're about to implement (per user feedback):
 *   "ปิดค่างวดแล้ว" must ONLY show on periods strictly AFTER the period where
 *   the customer paid the close-out lump sum. That period and all previous
 *   ones must show real amounts.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const [rows] = await conn.execute(`
    SELECT pt.contract_external_id,
           pt.paid_at,
           pt.section,
           JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) AS receipt_no,
           CAST(JSON_EXTRACT(pt.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
           CAST(JSON_EXTRACT(pt.raw_json, '$.total_paid_amount')        AS DECIMAL(18,2)) AS total_paid,
           CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount')          AS DECIMAL(18,2)) AS overpaid
      FROM payment_transactions pt
     WHERE pt.section = 'Boonphone'
       AND CAST(JSON_EXTRACT(pt.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
     ORDER BY pt.contract_external_id
     LIMIT 20
  `);
  console.log(`\n== Payments with close_installment_amount > 0 (first 20) ==`);
  console.log(`Total found: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `ext=${r.contract_external_id} paid_at=${r.paid_at} receipt=${r.receipt_no} close=${r.close_amt} total_paid=${r.total_paid} overpaid=${r.overpaid}`,
    );
  }

  if (rows.length === 0) {
    console.log("  (no closing payments found)");
    process.exit(0);
  }

  // Pick the first 3 contracts and show their installment schedule.
  const sampled = [...new Set(rows.map((r) => r.contract_external_id))].slice(0, 3);
  for (const extId of sampled) {
    console.log(`\n== Contract external_id = ${extId} ==`);
    const [contracts] = await conn.execute(
      `SELECT external_id, contract_no, installment_amount, installment_count, status
         FROM contracts WHERE external_id = ? LIMIT 1`,
      [extId],
    );
    console.log("contract:", contracts[0]);
    const [insts] = await conn.execute(
      `SELECT period, due_date, amount, paid_amount,
              CAST(JSON_EXTRACT(raw_json, '$.principal_due') AS DECIMAL(18,2)) AS principal_due,
              CAST(JSON_EXTRACT(raw_json, '$.interest_due')  AS DECIMAL(18,2)) AS interest_due,
              CAST(JSON_EXTRACT(raw_json, '$.fee_due')       AS DECIMAL(18,2)) AS fee_due
         FROM installments WHERE contract_external_id = ?
         ORDER BY period`,
      [extId],
    );
    console.log("installments:");
    for (const i of insts) {
      console.log(
        `  p=${i.period}  due=${i.due_date}  amount=${i.amount}  principal=${i.principal_due}  interest=${i.interest_due}  fee=${i.fee_due}  paid=${i.paid_amount}`,
      );
    }
    const [pays] = await conn.execute(
      `SELECT paid_at,
              JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
              CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
              CAST(JSON_EXTRACT(raw_json, '$.total_paid_amount')        AS DECIMAL(18,2)) AS total_paid
         FROM payment_transactions
        WHERE contract_external_id = ? AND section='Boonphone'
        ORDER BY paid_at`,
      [extId],
    );
    console.log("payments:");
    for (const p of pays) {
      console.log(
        `  paid_at=${p.paid_at}  receipt=${p.receipt_no}  close=${p.close_amt}  total_paid=${p.total_paid}`,
      );
    }
  }
} finally {
  await conn.end();
}

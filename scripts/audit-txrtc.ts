import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const c = await mysql.createConnection(process.env.DATABASE_URL as string);

  console.log('--- TXRTC vs TXRT count ---');
  const [rows]: any = await c.execute(`
    SELECT
      CASE
        WHEN JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRTC%' THEN 'TXRTC (close-contract?)'
        WHEN JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRT%' THEN 'TXRT (single-period)'
        ELSE 'OTHER'
      END AS prefix,
      COUNT(*) AS cnt
    FROM payment_transactions
    WHERE section = 'Boonphone'
    GROUP BY prefix
  `);
  console.table(rows);

  console.log('\n--- Sample TXRTC payments with remark ---');
  const [samples]: any = await c.execute(`
    SELECT contract_external_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.receipt_no')) AS receipt,
           JSON_EXTRACT(raw_json,'$.close_installment_amount') AS close_amt,
           JSON_EXTRACT(raw_json,'$.discount_amount') AS discount,
           JSON_EXTRACT(raw_json,'$.total_paid_amount') AS total_paid,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.remark')) AS remark,
           paid_at
    FROM payment_transactions
    WHERE section='Boonphone'
      AND JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.receipt_no')) LIKE 'TXRTC%'
    ORDER BY paid_at DESC
    LIMIT 10
  `);
  for (const r of samples) {
    console.log(r);
  }

  // For each contract that has a TXRTC payment, find what the max paid period was AFTER that payment.
  // If TXRTC is the close-contract marker, all installments except the one closed should be considered closed.
  console.log('\n--- Installments for one TXRTC contract ---');
  const [contract]: any = await c.execute(`
    SELECT contract_external_id
      FROM payment_transactions
     WHERE section='Boonphone' AND JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.receipt_no')) LIKE 'TXRTC%'
     LIMIT 1
  `);
  if (contract[0]) {
    const ext = contract[0].contract_external_id;
    console.log('contract ext:', ext);
    const [ins]: any = await c.execute(`
      SELECT period, amount, paid_amount, due_date
        FROM installments WHERE contract_external_id = ? AND section='Boonphone'
        ORDER BY period
    `, [ext]);
    console.table(ins);

    const [pays]: any = await c.execute(`
      SELECT JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.receipt_no')) AS receipt,
             amount,
             JSON_EXTRACT(raw_json,'$.close_installment_amount') AS close_amt,
             paid_at
        FROM payment_transactions WHERE contract_external_id = ? AND section='Boonphone'
        ORDER BY paid_at
    `, [ext]);
    console.table(pays);
  }

  await c.end();
}
main().catch(console.error);

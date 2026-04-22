import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL!);

const [contracts] = await conn.execute(
  `SELECT id, external_id, contract_no, customer_name, installment_amount
   FROM contracts
   WHERE section='Boonphone' AND customer_name LIKE '%สุทธิดา%จงใจ%'
   LIMIT 5`
);
console.log('Contracts:', JSON.stringify(contracts, null, 2));

for (const c of contracts as any[]) {
  console.log(`\n=== ${c.contract_no} (ext=${c.external_id}, baseline=${c.installment_amount}) ===`);

  const [insts] = await conn.execute(
    `SELECT period, amount, paid_amount,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.principal_due')) AS p_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.interest_due')) AS i_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fee_due')) AS fee_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.penalty_due')) AS pen_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.total_due_amount')) AS total_due,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS status
     FROM installments
     WHERE section='Boonphone' AND contract_external_id = ?
     ORDER BY period ASC LIMIT 5`,
    [c.external_id]
  );
  console.log('Installments (first 5):');
  console.table(insts);

  const [pays] = await conn.execute(
    `SELECT external_id, paid_at, amount, status,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_period')) AS period,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.overpaid_amount')) AS overpaid,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.close_installment_amount')) AS close_amt,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.principal_paid')) AS p_paid,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.interest_paid')) AS i_paid,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.discount_amount')) AS discount,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.penalty_paid')) AS pen_paid,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')) AS unlock_fee
     FROM payment_transactions
     WHERE section='Boonphone' AND contract_external_id = ?
     ORDER BY paid_at ASC`,
    [c.external_id]
  );
  console.log('Payments:');
  console.table(pays);
}

process.exit(0);

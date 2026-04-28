import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);

const [rows] = await pool.execute(
  `SELECT external_id, amount, status,
          JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
          CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
          CAST(JSON_EXTRACT(raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
          CAST(JSON_EXTRACT(raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
          CAST(JSON_EXTRACT(raw_json, '$.fee_paid') AS DECIMAL(18,2)) AS fee_paid,
          CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount
   FROM payment_transactions
   WHERE contract_external_id = '20980'
     AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRT%'
   ORDER BY JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no'))`,
  []
);

for (const r of rows) {
  console.log(JSON.stringify(r));
}

await pool.end();

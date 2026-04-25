import mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดู payments ทั้งหมดของสัญญา CT1224-NRT001-5648-01 (external_id=6140)
const [rows] = await conn.execute(`
  SELECT id, contract_external_id,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.amount')) AS amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.principal_paid')) AS principal_paid,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.interest_paid')) AS interest_paid,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fee_paid')) AS fee_paid,
         paid_at
  FROM payment_transactions
  WHERE contract_external_id = '6140'
    AND section = 'Fastfone365'
  ORDER BY paid_at
`);
console.log('Payments of CT1224-NRT001-5648-01 (external_id=6140):');
console.log(JSON.stringify(rows, null, 2));

await conn.end();

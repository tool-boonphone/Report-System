import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL!);
const [rows] = await conn.execute(`
  SELECT 
    c.external_id,
    c.bad_debt_amount,
    c.bad_debt_date,
    c.status,
    JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) as receipt_no,
    pt.paid_at,
    JSON_EXTRACT(pt.raw_json, '$.total_paid_amount') as total_paid,
    JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') as overpaid
  FROM contracts c
  JOIN payment_transactions pt ON pt.contract_external_id = c.external_id
  WHERE c.external_id = (SELECT external_id FROM contracts WHERE contract_no = 'CT0126-CBI041-22273-01' LIMIT 1)
  ORDER BY pt.paid_at
`);
console.log(JSON.stringify(rows, null, 2));
await conn.end();
process.exit(0);

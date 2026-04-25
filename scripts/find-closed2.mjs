import mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// หาสัญญาสิ้นสุดสัญญา Fastfone365 ที่มี TXRTC receipt
const [rows] = await conn.execute(`
  SELECT c.contract_no, c.external_id, c.installment_count
  FROM contracts c
  JOIN payment_transactions pt ON pt.contract_external_id = c.external_id AND pt.section = c.section
  WHERE c.section = 'Fastfone365'
    AND c.status = 'สิ้นสุดสัญญา'
    AND JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) LIKE 'TXRTC%'
  GROUP BY c.contract_no, c.external_id, c.installment_count
  LIMIT 5
`);
console.log('FF365 สิ้นสุดสัญญา + TXRTC:');
console.log(JSON.stringify(rows, null, 2));

// หาสัญญาสิ้นสุดสัญญา Boonphone ที่มี TXRTC receipt
const [rows2] = await conn.execute(`
  SELECT c.contract_no, c.external_id, c.installment_count
  FROM contracts c
  JOIN payment_transactions pt ON pt.contract_external_id = c.external_id AND pt.section = c.section
  WHERE c.section = 'Boonphone'
    AND c.status = 'สิ้นสุดสัญญา'
    AND JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) LIKE 'TXRTC%'
  GROUP BY c.contract_no, c.external_id, c.installment_count
  LIMIT 5
`);
console.log('\nBoonphone สิ้นสุดสัญญา + TXRTC:');
console.log(JSON.stringify(rows2, null, 2));

await conn.end();

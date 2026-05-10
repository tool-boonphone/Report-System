import mysql from 'mysql2/promise';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await mysql.createConnection(DB_URL);

// ตรวจสอบว่า source IS NULL vs external_id NOT LIKE 'pay-%' ต่างกันอย่างไร
const [diff1] = await conn.query(`
  SELECT 
    SUM(CASE WHEN JSON_EXTRACT(raw_json, '$.source') IS NULL THEN 1 ELSE 0 END) as source_null_count,
    SUM(CASE WHEN external_id NOT LIKE 'pay-%' THEN 1 ELSE 0 END) as not_pay_count,
    SUM(CASE WHEN JSON_EXTRACT(raw_json, '$.source') IS NULL AND external_id LIKE 'pay-%' THEN 1 ELSE 0 END) as source_null_but_pay,
    SUM(CASE WHEN JSON_EXTRACT(raw_json, '$.source') IS NOT NULL AND external_id NOT LIKE 'pay-%' THEN 1 ELSE 0 END) as has_source_not_pay
  FROM payment_transactions
  WHERE section = 'Fastfone365'
`);
console.log('source IS NULL vs NOT LIKE pay-%:', JSON.stringify(diff1[0]));

// ดูตัวอย่าง payment ที่ source IS NULL แต่ external_id LIKE 'pay-%'
const [sample1] = await conn.query(`
  SELECT external_id, contract_external_id, paid_at, created_at, amount, JSON_EXTRACT(raw_json, '$.source') as source
  FROM payment_transactions
  WHERE section = 'Fastfone365'
    AND JSON_EXTRACT(raw_json, '$.source') IS NULL
    AND external_id LIKE 'pay-%'
  LIMIT 5
`);
console.log('\nSample source IS NULL + pay-:', sample1);

// ดูตัวอย่าง payment ที่ source IS NOT NULL แต่ external_id NOT LIKE 'pay-%'
const [sample2] = await conn.query(`
  SELECT external_id, contract_external_id, paid_at, created_at, amount, JSON_EXTRACT(raw_json, '$.source') as source
  FROM payment_transactions
  WHERE section = 'Fastfone365'
    AND JSON_EXTRACT(raw_json, '$.source') IS NOT NULL
    AND external_id NOT LIKE 'pay-%'
  LIMIT 5
`);
console.log('\nSample has source + NOT pay-:', sample2);

await conn.end();

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const url = process.env.DATABASE_URL;
const urlObj = new URL(url);
const conn = await mysql.createConnection({
  host: urlObj.hostname,
  port: parseInt(urlObj.port) || 3306,
  user: decodeURIComponent(urlObj.username),
  password: decodeURIComponent(urlObj.password),
  database: urlObj.pathname.replace(/^\//, ''),
  ssl: { rejectUnauthorized: false }
});

// หาสัญญาหนี้เสียที่มี payment จริง
const [contracts] = await conn.execute(`
  SELECT c.contract_no, c.section, c.bad_debt_date, c.bad_debt_amount
  FROM contracts c
  WHERE c.status = 'หนี้เสีย'
    AND c.section = 'fastfone365'
  ORDER BY c.contract_no DESC
  LIMIT 3
`);

console.log('Sample bad_debt contracts:', JSON.stringify(contracts, null, 2));

// ดู payments ของสัญญาแรก
if (contracts.length > 0) {
  const c = contracts[0];
  const [payments] = await conn.execute(`
    SELECT pt.id, pt.amount, DATE(pt.paid_at) as paid_date, pt.paid_at, 
           pt.created_at, pt.updated_by, pt.updated_at,
           JSON_EXTRACT(pt.raw_json, '$.source') as source
    FROM payment_transactions pt
    WHERE pt.contract_no = ? AND pt.section = ?
      AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
    ORDER BY pt.paid_at DESC, pt.created_at DESC
    LIMIT 15
  `, [c.contract_no, c.section]);
  
  console.log(`\nPayments for contract ${c.contract_no}:`);
  console.log(JSON.stringify(payments, null, 2));
}

await conn.end();
process.exit(0);

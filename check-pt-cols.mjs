import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const url = process.env.DATABASE_URL;
// Parse URL including query params
const urlObj = new URL(url);
const host = urlObj.hostname;
const port = parseInt(urlObj.port) || 3306;
const user = decodeURIComponent(urlObj.username);
const password = decodeURIComponent(urlObj.password);
const database = urlObj.pathname.replace(/^\//, '');

const conn = await mysql.createConnection({
  host, port, user, password, database,
  ssl: { rejectUnauthorized: false }
});

const [cols] = await conn.execute('SHOW COLUMNS FROM payment_transactions');
console.log('PT columns:', cols.map(c=>c.Field).join(', '));

const hasBY = cols.some(c => c.Field === 'updated_by');
console.log('has updated_by:', hasBY);

// ดูตัวอย่าง updated_by ใน payment_transactions สำหรับสัญญาหนี้เสีย
const [rows] = await conn.execute(`
  SELECT pt.updated_by, pt.created_at, DATE(pt.paid_at) as paid_date, pt.amount
  FROM payment_transactions pt
  JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
  WHERE pt.section = 'fastfone365' 
    AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
    AND c.status = 'หนี้เสีย'
  ORDER BY pt.paid_at DESC, pt.created_at DESC
  LIMIT 10
`);
console.log('sample bad_debt payments:', JSON.stringify(rows, null, 2));

await conn.end();
process.exit(0);

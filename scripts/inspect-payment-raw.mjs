import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
const [rows] = await conn.query("SELECT raw_json FROM payment_transactions WHERE section=? LIMIT 3",['boonphone']);
for (const r of rows) {
  const obj = typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json;
  console.log(JSON.stringify(obj, null, 2).slice(0, 1200));
  console.log('---');
}
await conn.end();

import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
const [c] = await conn.query("SELECT COUNT(*) AS n FROM payment_transactions WHERE section='boonphone'");
console.log('payments count:', c[0].n);
const [s] = await conn.query("SELECT raw_json FROM payment_transactions WHERE section='boonphone' LIMIT 1");
console.log('sample:', s.length, s[0] ? Object.keys(s[0]) : 'none');
if (s[0]) {
  const raw = s[0].raw_json;
  console.log('type:', typeof raw);
  console.log('value preview:', String(raw).slice(0, 400));
}
await conn.end();

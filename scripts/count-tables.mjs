import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
const [tables] = await conn.query("SHOW TABLES");
console.log('tables:', tables.map(t => Object.values(t)[0]));
for (const t of ['payment_transactions','installments','contracts','customers']) {
  try {
    const [r] = await conn.query(`SELECT section, COUNT(*) as n FROM ${t} GROUP BY section`);
    console.log(t, r);
  } catch (e) { console.log(t, 'err:', e.message); }
}
await conn.end();

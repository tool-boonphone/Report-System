import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
for (const t of ['contracts','installments','payment_transactions']) {
  const [r] = await conn.query(`SELECT section, COUNT(*) AS n FROM ${t} GROUP BY section`);
  console.log(t, JSON.stringify(r));
}
await conn.end();

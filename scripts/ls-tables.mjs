import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
const [tables] = await conn.query("SHOW TABLES");
console.log('tables count:', tables.length);
for (const t of tables) console.log(' -', Object.values(t)[0]);
await conn.end();

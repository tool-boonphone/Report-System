/**
 * Script: เปรียบเทียบ contract list ใน DB กับไฟล์ Super Report XLS
 * Usage: node scripts/compare_contracts.mjs
 */
import mysql from 'mysql2/promise';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL not set');
  process.exit(1);
}

// Parse DATABASE_URL: mysql://user:pass@host:port/dbname?ssl=...
const url = new URL(DB_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port || '3306'),
  user: url.username,
  password: url.password,
  database: url.pathname.replace('/', ''),
  ssl: { rejectUnauthorized: false },
});

console.log('Connected to DB');

// ดึง contract_no ทั้งหมด (ยกเว้นยกเลิกสัญญา)
const [rows] = await conn.execute(
  `SELECT contract_no FROM contracts WHERE section = 'Fastfone365' AND status != 'ยกเลิกสัญญา' ORDER BY contract_no`
);
await conn.end();

const dbContracts = new Set(rows.map(r => r.contract_no));
console.log(`DB contracts (non-cancelled): ${dbContracts.size}`);

// บันทึก DB list ไว้
fs.writeFileSync('/tmp/db_contracts_list.txt', [...dbContracts].sort().join('\n'));
console.log('Saved DB list to /tmp/db_contracts_list.txt');

import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';
let envStr = '';
try { envStr = readFileSync('/home/ubuntu/report-system/.env', 'utf-8'); } catch {}
envStr.split('\n').forEach((line) => {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
});
const conn = await createConnection(process.env.DATABASE_URL);

// Count installments for Boonphone
const [[bbInst]] = await conn.execute('SELECT COUNT(*) as cnt FROM installments WHERE section = "Boonphone"');
console.log('BB installments total:', bbInst.cnt);

// Count contracts with null updated_by
const [[bbNull]] = await conn.execute('SELECT COUNT(DISTINCT contract_external_id) as cnt FROM installments WHERE section = "Boonphone" AND updated_by IS NULL');
console.log('BB contracts with null updated_by:', bbNull.cnt);

// FF365 installments
const [[ffInst]] = await conn.execute('SELECT COUNT(*) as cnt FROM installments WHERE section = "Fastfone365"');
console.log('FF365 installments total:', ffInst.cnt);

// FF365 contracts with null updated_by
const [[ffNull]] = await conn.execute('SELECT COUNT(DISTINCT contract_external_id) as cnt FROM installments WHERE section = "Fastfone365" AND updated_by IS NULL');
console.log('FF365 contracts with null updated_by:', ffNull.cnt);

await conn.end();

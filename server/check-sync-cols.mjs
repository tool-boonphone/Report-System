import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';
let envStr = '';
try { envStr = readFileSync('/home/ubuntu/report-system/.env', 'utf-8'); } catch {}
envStr.split('\n').forEach((line) => {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
});
const conn = await createConnection(process.env.DATABASE_URL);
const [cols] = await conn.execute('DESCRIBE sync_logs');
console.log('Columns:', cols.map(c => c.Field).join(', '));
const [rows] = await conn.execute('SELECT * FROM sync_logs ORDER BY started_at DESC LIMIT 10');
rows.forEach((r) => {
  console.log(JSON.stringify(r));
});
await conn.end();

import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';
let envStr = '';
try { envStr = readFileSync('/home/ubuntu/report-system/.env', 'utf-8'); } catch {}
envStr.split('\n').forEach((line) => {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
});
const conn = await createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute('SELECT id, section, stage, status, started_at, finished_at, error_message FROM sync_logs ORDER BY started_at DESC LIMIT 30');
rows.forEach((r) => {
  const err = r.error_message ? r.error_message.slice(0, 120) : '';
  const fin = r.finished_at ? r.finished_at.toISOString().slice(0,19) : 'still running';
  console.log(`[${r.section}] stage=${r.stage} status=${r.status} started=${r.started_at?.toISOString?.()?.slice(0,19)} finished=${fin}`);
  if (err) console.log(`  ERROR: ${err}`);
});
await conn.end();

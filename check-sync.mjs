import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute(
  'SELECT id, section, entity, status, row_count, error_message, started_at FROM sync_logs WHERE section="ff365" ORDER BY started_at DESC LIMIT 8'
);
console.log('=== FF365 sync_logs ===');
console.log(JSON.stringify(rows, null, 2));

const [pt] = await conn.execute(
  'SELECT section, COUNT(*) as cnt FROM payment_transactions GROUP BY section'
);
console.log('=== payment_transactions ===');
console.log(JSON.stringify(pt));

await conn.end();

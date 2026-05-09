import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Clear stuck in_progress sync_logs ที่เก่ากว่า 15 นาที
const [result] = await conn.execute(`
  UPDATE sync_logs 
  SET status = 'error', 
      error_message = 'Manually cleared: process was killed'
  WHERE status = 'in_progress' 
    AND started_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)
`);
console.log(`Cleared ${result.affectedRows} stuck sync_logs`);

// ดู sync_logs ล่าสุด
const [rows] = await conn.execute(
  'SELECT id, section, entity, status, row_count, started_at FROM sync_logs ORDER BY started_at DESC LIMIT 6'
);
console.log('=== Latest sync_logs ===');
console.log(JSON.stringify(rows, null, 2));

// ดู payment_transactions count
const [pt] = await conn.execute(
  'SELECT section, COUNT(*) as cnt FROM payment_transactions GROUP BY section'
);
console.log('=== payment_transactions ===');
console.log(JSON.stringify(pt));

await conn.end();

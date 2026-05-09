import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดู sync_logs ล่าสุดของ ff365
const [syncLogs] = await conn.execute(
  `SELECT id, section, entity, status, row_count, error_message, started_at 
   FROM sync_logs WHERE section='ff365' ORDER BY started_at DESC LIMIT 10`
);
console.log('=== FF365 sync_logs (latest) ===');
syncLogs.forEach(r => {
  const elapsed = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000);
  console.log(`  [${r.status}] ${r.entity} rows=${r.row_count} started=${elapsed}min ago ${r.error_message ? '❌ '+r.error_message : ''}`);
});

// ดู payment_transactions count ทั้ง 2 section
const [pt] = await conn.execute(
  `SELECT section, COUNT(*) as cnt, 
          SUM(CASE WHEN payment_time IS NOT NULL THEN 1 ELSE 0 END) as has_payment_time,
          SUM(CASE WHEN created_by IS NOT NULL THEN 1 ELSE 0 END) as has_created_by,
          SUM(CASE WHEN updated_by IS NOT NULL THEN 1 ELSE 0 END) as has_updated_by
   FROM payment_transactions GROUP BY section`
);
console.log('\n=== payment_transactions summary ===');
pt.forEach(r => {
  console.log(`  ${r.section}: total=${r.cnt} payment_time=${r.has_payment_time} created_by=${r.has_created_by} updated_by=${r.has_updated_by}`);
});

// ตัวอย่าง payment_transactions ของ ff365
const [sample] = await conn.execute(
  `SELECT payment_id, contract_code, payment_date, payment_time, 
          total_paid_amount, payment_method, created_by, updated_by, created_at, updated_at
   FROM payment_transactions WHERE section='ff365' LIMIT 3`
);
console.log('\n=== FF365 payment_transactions sample ===');
console.log(JSON.stringify(sample, null, 2));

await conn.end();

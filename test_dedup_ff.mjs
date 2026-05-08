// test_dedup_ff.mjs — ทดสอบ Dedup query FF เมษา 2569
import { createConnection } from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const db = await createConnection(url);

const [rows] = await db.execute(`
  SELECT 
    DATE(pt.paid_at) AS day,
    SUM(CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2))) AS total
  FROM payment_transactions pt
  WHERE pt.section = 'fastfone'
    AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
    AND pt.paid_at >= '2026-04-01'
    AND pt.paid_at < '2026-05-01'
    AND pt.id = (
      SELECT MIN(pt_d.id)
      FROM payment_transactions pt_d
      WHERE pt_d.section = pt.section
        AND pt_d.contract_no = pt.contract_no
        AND pt_d.paid_at = pt.paid_at
        AND pt_d.amount = pt.amount
        AND JSON_EXTRACT(pt_d.raw_json, '$.source') IS NULL
    )
  GROUP BY DATE(pt.paid_at)
  ORDER BY day
`);

let grandTotal = 0;
for (const r of rows) {
  grandTotal += Number(r.total);
  const dayStr = String(r.day).substring(0, 10);
  console.log(`${dayStr}: ${Number(r.total).toLocaleString('th-TH')}`);
}
console.log(`\nรวม: ${grandTotal.toLocaleString('th-TH')}`);
await db.end();

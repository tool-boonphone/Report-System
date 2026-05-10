import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ตรวจสอบว่า JSON_EXTRACT(raw_json, '$.source') IS NULL กรอง rows ออกกี่ rows
const [sourceCheck] = await conn.query(`
  SELECT 
    JSON_EXTRACT(raw_json, '$.source') AS source_val,
    COUNT(*) as cnt,
    SUM(amount) as total
  FROM payment_transactions
  WHERE section = 'Fastfone365'
  GROUP BY JSON_EXTRACT(raw_json, '$.source')
  ORDER BY cnt DESC
  LIMIT 10
`);
console.log("=== source values ใน payment_transactions ===");
for (const r of sourceCheck) {
  console.log(`  source='${r.source_val}': cnt=${r.cnt}, total=${Number(r.total).toFixed(2)}`);
}

// ยอดรวมที่ source IS NULL
const [nullSource] = await conn.query(`
  SELECT COUNT(*) as cnt, SUM(amount) as total
  FROM payment_transactions
  WHERE section = 'Fastfone365' AND JSON_EXTRACT(raw_json, '$.source') IS NULL
`);
console.log(`\n=== source IS NULL ===`);
console.log(`  count: ${nullSource[0].cnt}, total: ${Number(nullSource[0].total).toFixed(2)}`);

// ยอดรวมทั้งหมด
const [allRows] = await conn.query(`
  SELECT COUNT(*) as cnt, SUM(amount) as total
  FROM payment_transactions
  WHERE section = 'Fastfone365'
`);
console.log(`\n=== ทั้งหมด ===`);
console.log(`  count: ${allRows[0].cnt}, total: ${Number(allRows[0].total).toFixed(2)}`);

// ยอดรวม debt_collected_cache
const [cacheTotal] = await conn.query(`
  SELECT COUNT(*) as cnt, 
    SUM(total_amount) as total_amount,
    SUM(principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) as breakdown,
    SUM(CASE WHEN is_bad_debt_row = 0 THEN total_amount ELSE bad_debt END) as income_sum
  FROM debt_collected_cache
  WHERE section = 'Fastfone365'
`);
console.log(`\n=== debt_collected_cache ===`);
console.log(`  count: ${cacheTotal[0].cnt}`);
console.log(`  total_amount: ${Number(cacheTotal[0].total_amount).toFixed(2)}`);
console.log(`  breakdown: ${Number(cacheTotal[0].breakdown).toFixed(2)}`);
console.log(`  income_sum (total_amount + bad_debt): ${Number(cacheTotal[0].income_sum).toFixed(2)}`);

await conn.end();

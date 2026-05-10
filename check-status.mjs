import mysql from 'mysql2/promise';

const DB_URL = process.env.DATABASE_URL;
const conn = await mysql.createConnection(DB_URL);

// ดูค่า status ที่มีใน contracts
const [statuses] = await conn.query(`
  SELECT status, COUNT(*) as cnt
  FROM contracts
  WHERE section = 'Fastfone365'
  GROUP BY status
  ORDER BY cnt DESC
`);
console.log('Contract statuses:', statuses);

// เปรียบเทียบ status = 'หนี้เสีย' vs bad_debt_date IS NOT NULL
const [compare] = await conn.query(`
  SELECT 
    SUM(CASE WHEN status = 'หนี้เสีย' THEN 1 ELSE 0 END) AS status_bad_debt,
    SUM(CASE WHEN bad_debt_date IS NOT NULL THEN 1 ELSE 0 END) AS has_bad_debt_date,
    SUM(CASE WHEN status = 'หนี้เสีย' AND bad_debt_date IS NULL THEN 1 ELSE 0 END) AS status_but_no_date,
    SUM(CASE WHEN status != 'หนี้เสีย' AND bad_debt_date IS NOT NULL THEN 1 ELSE 0 END) AS date_but_not_status
  FROM contracts
  WHERE section = 'Fastfone365'
`);
console.log('\nCompare:', JSON.stringify(compare[0]));

await conn.end();

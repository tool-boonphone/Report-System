import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute(`
  SELECT contract_status, COUNT(DISTINCT contract_external_id) as cnt
  FROM debt_target_cache
  WHERE section = 'Fastfone365'
  GROUP BY contract_status
  ORDER BY cnt DESC
  LIMIT 20
`);
console.log("debt_target_cache contract_status distribution:");
console.log(JSON.stringify(rows, null, 2));

// ตรวจสอบว่า contracts table มี ยกเลิกสัญญา ไหม
const [rows2] = await conn.execute(`
  SELECT status, COUNT(*) as cnt
  FROM contracts
  WHERE section = 'Fastfone365' AND status = 'ยกเลิกสัญญา'
  LIMIT 5
`);
console.log("\ncontracts table ยกเลิกสัญญา count:");
console.log(JSON.stringify(rows2, null, 2));

await conn.end();
process.exit(0);

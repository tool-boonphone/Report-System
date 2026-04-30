// Migration: Add updated_at column to debt_collected_cache
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

try {
  // Check if column already exists
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_NAME = 'debt_collected_cache' AND COLUMN_NAME = 'updated_at'`
  );
  
  if (rows.length > 0) {
    console.log("Column updated_at already exists in debt_collected_cache — skipping");
  } else {
    await conn.query(`ALTER TABLE \`debt_collected_cache\` ADD \`updated_at\` varchar(32)`);
    console.log("✓ Added updated_at column to debt_collected_cache");
  }
} finally {
  await conn.end();
}

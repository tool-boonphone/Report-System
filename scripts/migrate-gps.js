/**
 * Migration Script: GPS Location Tracking
 * - เพิ่ม mdm_device_id column ใน contracts table
 * - สร้าง device_location_logs table ใหม่
 * รัน: node scripts/migrate-gps.js
 */
const pg = require("pg");
require("dotenv").config({ path: ".env" });

const BOONPHONE_URL = process.env.BOONPHONE_DATABASE_URL;
const FASTFONE_URL = process.env.FASTFONE_DATABASE_URL;

const MIGRATION_SQL = `
-- 1. เพิ่ม mdm_device_id column ใน contracts table (ถ้ายังไม่มี)
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS mdm_device_id INTEGER;

-- 2. สร้าง device_location_logs table (append-only GPS history)
CREATE TABLE IF NOT EXISTS device_location_logs (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section      VARCHAR(64)  NOT NULL,
  serial_no    VARCHAR(64)  NOT NULL,
  mdm_device_id INTEGER     NOT NULL,
  latitude     VARCHAR(32)  NOT NULL,
  longitude    VARCHAR(32)  NOT NULL,
  altitude     VARCHAR(32),
  speed        VARCHAR(32),
  recorded_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- 3. สร้าง index สำหรับ query
CREATE INDEX IF NOT EXISTS dll_section_serial_idx   ON device_location_logs(section, serial_no);
CREATE INDEX IF NOT EXISTS dll_section_recorded_idx ON device_location_logs(section, recorded_at);
`;

async function runMigration(name, url) {
  if (!url) {
    console.error(`[${name}] ERROR: DATABASE_URL not set`);
    return;
  }
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    console.log(`[${name}] Running migration...`);
    await pool.query(MIGRATION_SQL);
    console.log(`[${name}] Migration completed successfully`);
  } catch (err) {
    console.error(`[${name}] Migration failed:`, err.message);
  } finally {
    await pool.end();
  }
}

async function main() {
  await runMigration("Boonphone", BOONPHONE_URL);
  await runMigration("Fastfone365", FASTFONE_URL);
  console.log("All migrations done.");
}

main().catch(console.error);

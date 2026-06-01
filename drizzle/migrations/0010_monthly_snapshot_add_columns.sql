-- Migration 0010: เพิ่ม columns ใหม่ใน monthly_collection_snapshot
-- สำหรับฟีเจอร์ "รายเดือน" ที่ต้องการแสดง:
--   - financed_total: ยอดจัดฯ รวม (SUM financeAmount × installmentCount)
--   - overdue_total: ค้างชำระรวม (SUM ยอดค้างชำระทั้งหมดในเดือนนั้น)
--   - collected_sale: ยอดขายเครื่อง (income_type = 'ขายเครื่อง')
--
-- Run on BOTH databases:
--   psql $BOONPHONE_DATABASE_URL -f drizzle/migrations/0010_monthly_snapshot_add_columns.sql
--   psql $FASTFONE_DATABASE_URL  -f drizzle/migrations/0010_monthly_snapshot_add_columns.sql

ALTER TABLE "monthly_collection_snapshot"
  ADD COLUMN IF NOT EXISTS "financed_total"   DECIMAL(18,2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "overdue_total"    DECIMAL(18,2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "collected_sale"   DECIMAL(18,2) NOT NULL DEFAULT '0';

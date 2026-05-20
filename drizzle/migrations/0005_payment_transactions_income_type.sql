-- Migration 0005: Add income_type column to payment_transactions
-- เพิ่ม column income_type เพื่อเก็บประเภทรายรับที่ Populate ไว้ตอน Sync
-- ทำให้หน้ารายรับ mode รายการตามสลิป ดึงค่าตรงๆ โดยไม่ต้องคำนวณ Logic 2 ระดับซ้ำทุกครั้ง
--
-- Run: psql $BOONPHONE_DATABASE_URL -f drizzle/migrations/0005_payment_transactions_income_type.sql
--      psql $FASTFONE_DATABASE_URL   -f drizzle/migrations/0005_payment_transactions_income_type.sql

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS income_type VARCHAR(32) DEFAULT NULL;

-- Index เพื่อเพิ่มความเร็วในการ filter ตาม income_type
CREATE INDEX IF NOT EXISTS payments_section_income_type_idx
  ON payment_transactions (section, income_type);

COMMENT ON COLUMN payment_transactions.income_type IS
  'ประเภทรายรับที่ Populate ไว้ตอน Sync: ค่างวด | ขายเครื่อง | ปิดยอด | NULL (ยังไม่ได้ Populate)';

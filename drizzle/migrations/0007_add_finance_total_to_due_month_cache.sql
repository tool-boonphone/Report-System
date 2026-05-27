-- Migration 0007: Add finance_total column to monthly_summary_due_month_cache
-- สำหรับแสดง "ยอดจัดฯ" ใน Mode "เดือนที่ต้องชำระ" ของ /monthly-summary
-- Run on BOTH databases:
--   psql $BOONPHONE_DATABASE_URL -f drizzle/migrations/0007_add_finance_total_to_due_month_cache.sql
--   psql $FASTFONE_DATABASE_URL  -f drizzle/migrations/0007_add_finance_total_to_due_month_cache.sql

ALTER TABLE "monthly_summary_due_month_cache"
  ADD COLUMN IF NOT EXISTS "finance_total" DECIMAL(18,2) NOT NULL DEFAULT '0';

-- Migration 0006: Create monthly_summary_due_month_cache table
-- สำหรับ Mode "เดือนที่ต้องชำระ" ใน Combined Tab ของ /monthly-summary
-- Run on BOTH databases:
--   psql $BOONPHONE_DATABASE_URL -f drizzle/migrations/0006_monthly_summary_due_month_cache.sql
--   psql $FASTFONE_DATABASE_URL  -f drizzle/migrations/0006_monthly_summary_due_month_cache.sql

CREATE TABLE IF NOT EXISTS "monthly_summary_due_month_cache" (
  "id"                   INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "section"              VARCHAR(32)      NOT NULL,
  "query_type"           VARCHAR(32)      NOT NULL, -- count | target | due | notYetDue | installTotal
  "approve_month"        VARCHAR(7)       NOT NULL, -- YYYY-MM
  "due_month"            VARCHAR(7)       NOT NULL, -- YYYY-MM ของ due_date
  "product_type"         VARCHAR(64),               -- NULL = ทั้งหมด
  "device_family"        VARCHAR(16),               -- iOS | Android | NULL
  "contract_count"       INTEGER          NOT NULL DEFAULT 0,
  "principal"            DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "interest"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "fee"                  DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "penalty"              DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "unlock_fee"           DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "discount"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "overpaid"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "bad_debt"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "bad_debt_installment" DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "total_amount"         DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "updated_at"           TIMESTAMP        NOT NULL DEFAULT NOW()
);

-- Unique index: ใช้ COALESCE เพื่อให้ NULL values ทำงานกับ unique constraint ได้
CREATE UNIQUE INDEX IF NOT EXISTS "msdmc_unique_idx"
  ON "monthly_summary_due_month_cache" (
    "section",
    "query_type",
    "approve_month",
    "due_month",
    COALESCE("product_type", ''),
    COALESCE("device_family", '')
  );

CREATE INDEX IF NOT EXISTS "msdmc_section_query_idx"
  ON "monthly_summary_due_month_cache" ("section", "query_type");

CREATE INDEX IF NOT EXISTS "msdmc_section_approve_idx"
  ON "monthly_summary_due_month_cache" ("section", "approve_month");

CREATE INDEX IF NOT EXISTS "msdmc_section_due_idx"
  ON "monthly_summary_due_month_cache" ("section", "due_month");

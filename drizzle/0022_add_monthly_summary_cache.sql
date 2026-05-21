-- Migration: Add monthly_summary_cache table
-- Pre-aggregated monthly summary cache for fast loading of สรุปรายเดือน menu

CREATE TABLE IF NOT EXISTS "monthly_summary_cache" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "section" varchar(32) NOT NULL,
  "query_type" varchar(32) NOT NULL,
  "approve_month" varchar(7) NOT NULL,
  "bucket" varchar(32) NOT NULL,
  "product_type" varchar(64),
  "device_family" varchar(16),
  "date_month" varchar(7),
  "contract_count" integer NOT NULL DEFAULT 0,
  "principal" decimal(18,2) NOT NULL DEFAULT '0',
  "interest" decimal(18,2) NOT NULL DEFAULT '0',
  "fee" decimal(18,2) NOT NULL DEFAULT '0',
  "penalty" decimal(18,2) NOT NULL DEFAULT '0',
  "unlock_fee" decimal(18,2) NOT NULL DEFAULT '0',
  "discount" decimal(18,2) NOT NULL DEFAULT '0',
  "overpaid" decimal(18,2) NOT NULL DEFAULT '0',
  "bad_debt" decimal(18,2) NOT NULL DEFAULT '0',
  "bad_debt_installment" decimal(18,2) NOT NULL DEFAULT '0',
  "total_amount" decimal(18,2) NOT NULL DEFAULT '0',
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- ใช้ COALESCE เพื่อให้ unique index ทำงานกับ NULL values ได้ถูกต้องใน PostgreSQL
CREATE UNIQUE INDEX IF NOT EXISTS "msc_unique_idx"
  ON "monthly_summary_cache" (
    "section",
    "query_type",
    "approve_month",
    "bucket",
    COALESCE("product_type", ''),
    COALESCE("device_family", ''),
    COALESCE("date_month", '')
  );

CREATE INDEX IF NOT EXISTS "msc_section_query_idx"
  ON "monthly_summary_cache" ("section", "query_type");

CREATE INDEX IF NOT EXISTS "msc_section_month_idx"
  ON "monthly_summary_cache" ("section", "approve_month");

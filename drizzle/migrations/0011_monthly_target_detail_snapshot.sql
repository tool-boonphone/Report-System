-- Migration 0011: Create monthly_target_detail_snapshot table
-- เก็บ snapshot รายสัญญา ณ วันที่ 1 ของทุกเดือน (freeze ตลอด)
-- ใช้สำหรับ Lightbox "ยอดเก็บหนี้" ใน tab รายเดือน
--
-- Run on BOTH databases:
--   psql $BOONPHONE_DATABASE_URL  -f drizzle/migrations/0011_monthly_target_detail_snapshot.sql
--   psql $FASTFONE_DATABASE_URL   -f drizzle/migrations/0011_monthly_target_detail_snapshot.sql

CREATE TABLE IF NOT EXISTS "monthly_target_detail_snapshot" (
  "id"                    INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "section"               VARCHAR(32)      NOT NULL,
  "snapshot_month"        VARCHAR(7)       NOT NULL, -- YYYY-MM
  -- ข้อมูลสัญญา
  "contract_external_id"  VARCHAR(64)      NOT NULL,
  "contract_no"           VARCHAR(64),
  "customer_name"         VARCHAR(255),
  "partner_code"          VARCHAR(255),
  "partner_name"          VARCHAR(255),
  "approve_date"          VARCHAR(20),
  "product_type"          VARCHAR(64),
  "device"                VARCHAR(64),
  "model"                 VARCHAR(128),
  "finance_amount"        DECIMAL(12,2),
  "installment_count"     INTEGER,
  "baseline_amount"       DECIMAL(12,2)    NOT NULL DEFAULT '0',
  -- ข้อมูลงวด
  "period"                INTEGER,
  "due_date"              VARCHAR(20),
  "principal"             DECIMAL(12,2)    NOT NULL DEFAULT '0',
  "interest"              DECIMAL(12,2)    NOT NULL DEFAULT '0',
  "fee"                   DECIMAL(12,2)    NOT NULL DEFAULT '0',
  "penalty"               DECIMAL(12,2)    NOT NULL DEFAULT '0',
  "unlock_fee"            DECIMAL(12,2)    NOT NULL DEFAULT '0',
  "total_amount"          DECIMAL(12,2)    NOT NULL DEFAULT '0',
  "paid_amount"           DECIMAL(12,2)    NOT NULL DEFAULT '0',
  -- สถานะ
  "contract_status"       VARCHAR(32),
  "debt_range"            VARCHAR(32),
  "is_paid"               BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_arrears"            BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_bad_debt"           BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_closed"             BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_suspended"          BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_current_period"     BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_future_period"      BOOLEAN          NOT NULL DEFAULT FALSE,
  -- เวลาที่ populate
  "populated_at"          TIMESTAMP        NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS "mtds_section_month_idx"
  ON "monthly_target_detail_snapshot" ("section", "snapshot_month");

CREATE INDEX IF NOT EXISTS "mtds_section_month_contract_idx"
  ON "monthly_target_detail_snapshot" ("section", "snapshot_month", "contract_external_id");

CREATE INDEX IF NOT EXISTS "mtds_section_month_due_idx"
  ON "monthly_target_detail_snapshot" ("section", "snapshot_month", "due_date");

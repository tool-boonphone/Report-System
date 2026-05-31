-- Migration 0009: Create monthly_collection_snapshot table
-- สำหรับฟีเจอร์ "รายเดือน" ใน DebtReport (เป้า-ยอดเก็บหนี้)
--
-- ตาราง monthly_collection_snapshot เก็บ snapshot รายเดือน:
--   - target_amount: เป้าเก็บหนี้ (freeze วันที่ 1 ของเดือน)
--   - collected_amount: ยอดเก็บหนี้ (freeze หลังสิ้นเดือน)
--   - install_total: ยอดผ่อนรวมทั้งสัญญา (สำหรับคำนวณ % เทียบ)
--
-- Run on BOTH databases:
--   psql $BOONPHONE_DATABASE_URL -f drizzle/migrations/0009_monthly_collection_snapshot.sql
--   psql $FASTFONE_DATABASE_URL  -f drizzle/migrations/0009_monthly_collection_snapshot.sql

CREATE TABLE IF NOT EXISTS "monthly_collection_snapshot" (
  "id"                   INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "section"              VARCHAR(32)      NOT NULL,
  "collection_month"     VARCHAR(7)       NOT NULL, -- YYYY-MM (เดือนที่ snapshot นี้เป็นของ)

  -- เป้าเก็บหนี้ (frozen วันที่ 1 ของ collection_month)
  -- = SUM(GREATEST(total_amount - paid_amount, 0))
  -- WHERE due_date <= สิ้นเดือน collection_month AND is_closed IS NOT TRUE
  "target_amount"        DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "target_contract_count" INTEGER         NOT NULL DEFAULT 0,
  "target_frozen_at"     TIMESTAMP,                -- เวลาที่ freeze เป้าเก็บหนี้ (วันที่ 1 ของเดือน)

  -- ยอดเก็บหนี้ (frozen หลังสิ้นเดือน)
  -- = SUM(paid_amount) WHERE paid_at อยู่ใน collection_month
  "collected_amount"     DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_contract_count" INTEGER      NOT NULL DEFAULT 0,
  "collected_frozen_at"  TIMESTAMP,                -- เวลาที่ freeze ยอดเก็บหนี้ (หลังสิ้นเดือน)
  "collected_is_frozen"  BOOLEAN          NOT NULL DEFAULT FALSE, -- true = freeze แล้ว (เดือนผ่านไปแล้ว)

  -- ยอดผ่อนรวมทั้งสัญญา (สำหรับคำนวณ % เทียบ)
  "install_total"        DECIMAL(18,2)    NOT NULL DEFAULT '0',

  -- Breakdown ของเป้าเก็บหนี้ (principal, interest, fee, penalty, unlockFee)
  "target_principal"     DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "target_interest"      DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "target_fee"           DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "target_penalty"       DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "target_unlock_fee"    DECIMAL(18,2)    NOT NULL DEFAULT '0',

  -- Breakdown ของยอดเก็บหนี้ (principal, interest, fee, penalty, unlockFee, discount, overpaid, badDebt)
  "collected_principal"  DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_interest"   DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_fee"        DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_penalty"    DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_unlock_fee" DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_discount"   DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_overpaid"   DECIMAL(18,2)    NOT NULL DEFAULT '0',
  "collected_bad_debt"   DECIMAL(18,2)    NOT NULL DEFAULT '0',

  "created_at"           TIMESTAMP        NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMP        NOT NULL DEFAULT NOW()
);

-- Unique index: 1 row per section per collection_month
CREATE UNIQUE INDEX IF NOT EXISTS "mcs_section_month_idx"
  ON "monthly_collection_snapshot" ("section", "collection_month");

CREATE INDEX IF NOT EXISTS "mcs_section_idx"
  ON "monthly_collection_snapshot" ("section");

CREATE INDEX IF NOT EXISTS "mcs_collection_month_idx"
  ON "monthly_collection_snapshot" ("collection_month");

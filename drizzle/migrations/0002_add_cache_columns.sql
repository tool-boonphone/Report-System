-- Migration: Add missing columns to debt_target_cache and debt_collected_cache
-- Generated: 2026-05-15
-- Run this on the Render PostgreSQL database

-- ============================================================
-- debt_target_cache: add 26 missing columns
-- ============================================================
ALTER TABLE debt_target_cache
  ADD COLUMN IF NOT EXISTS partner_code VARCHAR(255),
  ADD COLUMN IF NOT EXISTS partner_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS device VARCHAR(64),
  ADD COLUMN IF NOT EXISTS model VARCHAR(128),
  ADD COLUMN IF NOT EXISTS finance_amount DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS contract_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS debt_range VARCHAR(32),
  ADD COLUMN IF NOT EXISTS principal DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unlock_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS baseline_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overpaid_applied DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_arrears BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_bad_debt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_current_period BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_future_period BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_partial_paid BOOLEAN NOT NULL DEFAULT FALSE;

-- Add indexes for new boolean columns (for filtering performance)
CREATE INDEX IF NOT EXISTS dtc_section_is_paid_idx ON debt_target_cache (section, is_paid);
CREATE INDEX IF NOT EXISTS dtc_section_is_arrears_idx ON debt_target_cache (section, is_arrears);
CREATE INDEX IF NOT EXISTS dtc_section_is_bad_debt_idx ON debt_target_cache (section, is_bad_debt);

-- ============================================================
-- debt_collected_cache: add 9 missing columns
-- ============================================================
ALTER TABLE debt_collected_cache
  ADD COLUMN IF NOT EXISTS partner_code VARCHAR(255),
  ADD COLUMN IF NOT EXISTS partner_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS device VARCHAR(64),
  ADD COLUMN IF NOT EXISTS model VARCHAR(128),
  ADD COLUMN IF NOT EXISTS finance_amount DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS installment_count INTEGER,
  ADD COLUMN IF NOT EXISTS contract_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS debt_range VARCHAR(32),
  ADD COLUMN IF NOT EXISTS period INTEGER;

-- ============================================================
-- Verify
-- ============================================================
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('debt_target_cache', 'debt_collected_cache')
ORDER BY table_name, ordinal_position;

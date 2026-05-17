-- Migration 0004: Create income_monthly_summary table for pre-aggregated income data
-- Run: psql $BOONPHONE_DATABASE_URL -f drizzle/migrations/0004_income_monthly_summary.sql
--      psql $FASTFONE_DATABASE_URL   -f drizzle/migrations/0004_income_monthly_summary.sql

CREATE TABLE IF NOT EXISTS income_monthly_summary (
  id            INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  section       VARCHAR(32)      NOT NULL,
  year          INTEGER          NOT NULL,
  month         INTEGER          NOT NULL,
  income_type   VARCHAR(32)      NOT NULL,
  total_amount  DECIMAL(18, 2)   NOT NULL DEFAULT 0,
  row_count     INTEGER          NOT NULL DEFAULT 0,
  updated_at    TIMESTAMP        NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ims_section_year_month_type_idx
  ON income_monthly_summary (section, year, month, income_type);

CREATE INDEX IF NOT EXISTS ims_section_year_idx
  ON income_monthly_summary (section, year);

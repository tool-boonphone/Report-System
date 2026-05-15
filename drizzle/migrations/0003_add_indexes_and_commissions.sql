-- Migration 0003: Add unique indexes to existing tables + create commissions table
-- Run: psql $DATABASE_URL -f drizzle/migrations/0003_add_indexes_and_commissions.sql

-- ─── Unique indexes for ON CONFLICT upserts ───────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS contracts_section_external_idx
  ON contracts (section, external_id);

CREATE INDEX IF NOT EXISTS contracts_section_status_idx
  ON contracts (section, status);

CREATE INDEX IF NOT EXISTS contracts_section_approve_idx
  ON contracts (section, approve_date);

CREATE UNIQUE INDEX IF NOT EXISTS installments_section_external_idx
  ON installments (section, external_id);

CREATE INDEX IF NOT EXISTS installments_section_contract_idx
  ON installments (section, contract_external_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_section_external_idx
  ON payment_transactions (section, external_id);

CREATE INDEX IF NOT EXISTS payment_transactions_section_contract_idx
  ON payment_transactions (section, contract_external_id);

CREATE INDEX IF NOT EXISTS payment_transactions_section_paid_at_idx
  ON payment_transactions (section, paid_at);

CREATE UNIQUE INDEX IF NOT EXISTS cached_customers_section_customer_idx
  ON cached_customers (section, customer_id);

-- ─── Commissions table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commissions (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section         VARCHAR(32)   NOT NULL,
  external_id     VARCHAR(64)   NOT NULL,
  contract_external_id VARCHAR(64),
  contract_no     VARCHAR(64),
  approved_at     VARCHAR(32),
  partner_code    VARCHAR(64),
  member_name     VARCHAR(255),
  member_tel      VARCHAR(32),
  product_name    VARCHAR(512),
  product_price   NUMERIC(12,2),
  deposit_amount  NUMERIC(12,2),
  finance_amount  NUMERIC(12,2),
  installment_number INTEGER,
  installment_amount NUMERIC(12,2),
  comm_amount     NUMERIC(12,2),
  incentive       NUMERIC(12,2),
  total_transfer  NUMERIC(12,2),
  payment_at      VARCHAR(32),
  payment_status  VARCHAR(64),
  payment_slip    TEXT,
  payment_slip2   TEXT,
  payment_channel VARCHAR(64),
  payment_by      VARCHAR(128),
  raw_json        JSONB,
  synced_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS commissions_section_external_idx
  ON commissions (section, external_id);

CREATE INDEX IF NOT EXISTS commissions_section_contract_idx
  ON commissions (section, contract_external_id);

CREATE INDEX IF NOT EXISTS commissions_section_approved_idx
  ON commissions (section, approved_at);

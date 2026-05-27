-- Migration: Add serial_no column to debt_target_cache
-- Generated: 2026-05-27
-- Purpose: Store serial number from contracts table in cache for MDM API matching
-- Run this on the Render PostgreSQL database

ALTER TABLE debt_target_cache
  ADD COLUMN IF NOT EXISTS serial_no VARCHAR(64);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'debt_target_cache'
  AND column_name = 'serial_no';

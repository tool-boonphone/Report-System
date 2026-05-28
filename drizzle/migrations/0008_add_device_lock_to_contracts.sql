-- Migration: เพิ่ม device_lock column ใน contracts table
-- device_lock: สถานะล็อคเครื่องจาก MDM (true=ล็อค, false=ปลดล็อค, null=ไม่พบ)
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "device_lock" boolean;

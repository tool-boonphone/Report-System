ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "income_type" varchar(32);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_section_income_type_idx" ON "payment_transactions" ("section","income_type");

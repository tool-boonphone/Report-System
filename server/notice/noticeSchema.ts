/**
 * noticeSchema.ts — DDL สำหรับตาราง/คอลัมน์ Notice (Phase 4)
 * รัน ensureNoticeSchema() ก่อนการทำงานครั้งแรกของแต่ละ section DB
 */
import { sql } from "drizzle-orm";
import type { SectionKey } from "../../shared/const";
import { getDb } from "../db";

let ensuredSections = new Set<string>();

export async function ensureNoticeSchema(section: SectionKey): Promise<void> {
  if (ensuredSections.has(section)) return;
  const db = await getDb(section);
  if (!db) return;

  await db.execute(sql`
    ALTER TABLE notice_print_logs
      ADD COLUMN IF NOT EXISTS document_no VARCHAR(8)
  `);
  await db.execute(sql`
    ALTER TABLE notice_restore_logs
      ADD COLUMN IF NOT EXISTS document_no VARCHAR(8)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS notice_document_counters (
      section VARCHAR(32) PRIMARY KEY,
      next_value INTEGER NOT NULL DEFAULT 1
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS notice_contract_doc (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      section VARCHAR(32) NOT NULL,
      contract_external_id VARCHAR(64) NOT NULL,
      document_no VARCHAR(8) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ncd_section_contract_idx
      ON notice_contract_doc (section, contract_external_id)
  `);
  await db.execute(sql`
    INSERT INTO notice_document_counters (section, next_value)
    VALUES (${section}, 1)
    ON CONFLICT (section) DO NOTHING
  `);

  ensuredSections.add(section);
}

/** แปลงเลขลำดับเป็นเลขที่เอกสาร (4 หลัก → 5 หลักเมื่อเกิน 9999) */
export function formatDocumentNo(n: number): string {
  if (n <= 9999) return String(n).padStart(4, "0");
  return String(n).padStart(5, "0");
}

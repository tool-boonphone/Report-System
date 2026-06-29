import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';
import type { SectionKey } from "../shared/const";

// ─── Connection pools ─────────────────────────────────────────────────────────
// boonphone-db  → Boonphone data + auth (users/app_users)
// fastfone-db   → Fastfone365 data only
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _boonphoneDb: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fastfoneDb: any = null;
// ถ้า connection เคย fail เพราะ env ยังไม่พร้อม ให้ retry ได้ใหม่
let _fastfoneDbFailed = false;
let _boonphoneDbFailed = false;

function createPool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    statement_timeout: 20 * 60 * 1000,
    query_timeout: 20 * 60 * 1000,
  });
}

/**
 * Get database connection for a specific section.
 * - "Boonphone"   → boonphone-db  (DATABASE_URL_BOONPHONE)
 * - "Fastfone365" → fastfone-db   (DATABASE_URL_FASTFONE365)
 * - undefined     → falls back to DATABASE_URL (legacy)
 */
export async function getDb(section?: SectionKey) {
  if (section === "Fastfone365") {
    // retry ถ้า _fastfoneDb ยังไม่มี (เช่น env ยังไม่พร้อมตอน startup)
    if (!_fastfoneDb) {
      const url = process.env.FASTFONE_DATABASE_URL || process.env.FASTFONE365_DATABASE_URL || process.env.DATABASE_URL;
      if (!url) {
        if (!_fastfoneDbFailed) console.warn("[Database] FASTFONE_DATABASE_URL not set — Fastfone365 DB unavailable");
        _fastfoneDbFailed = true;
        return null;
      }
      try {
        _fastfoneDb = drizzle(createPool(url));
        _fastfoneDbFailed = false;
        console.log("[Database] Connected to fastfone-db ✓");
      } catch (error) {
        console.warn("[Database] Failed to connect to fastfone-db:", error);
        return null;
      }
    }
    return _fastfoneDb;
  }

  // Default: Boonphone (also used as auth DB)
  if (!_boonphoneDb) {
    const url = process.env.BOONPHONE_DATABASE_URL || process.env.DATABASE_URL_BOONPHONE || process.env.DATABASE_URL;
    if (!url) {
      if (!_boonphoneDbFailed) console.warn("[Database] DATABASE_URL not set — Boonphone DB unavailable");
      _boonphoneDbFailed = true;
      return null;
    }
    try {
      _boonphoneDb = drizzle(createPool(url));
      _boonphoneDbFailed = false;
    } catch (error) {
      console.warn("[Database] Failed to connect to boonphone-db:", error);
      return null;
    }
  }
  return _boonphoneDb;
}

/**
 * Get auth database (app_users, app_groups, app_sessions).
 * Always uses boonphone-db — auth tables live there.
 */
export async function getAuthDb() {
  return getDb("Boonphone");
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getAuthDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getAuthDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Normalize db.execute() result for PostgreSQL compatibility.
 */
export function pgRows(result: unknown): any[] {
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as any).rows ?? [];
  }
  if (Array.isArray(result)) {
    if (Array.isArray((result as any)[0])) return (result as any)[0];
    return result as any[];
  }
  return [];
}

/** Columns Drizzle references on contracts INSERT — must exist on both DBs. */
const CONTRACTS_SYNC_COLUMNS = [
  "serial_no",
  "imei",
  "last_online_days",
  "last_online_at",
  "device_lock",
  "loss_status",
  "mdm_device_id",
  "bad_debt_amount",
  "bad_debt_date",
  "suspended_from_period",
  "bad_debt_updated_by",
  "bad_debt_updated_at",
] as const;

/**
 * Critical DDL that sync/populate require — idempotent.
 * Called at sync start (not only startup) so fastfone-db is never missing columns
 * if startup migration was skipped or FASTFONE_DATABASE_URL was late.
 */
export async function ensureSectionSchemaReady(section: SectionKey): Promise<void> {
  const db = await getDb(section);
  if (!db) {
    throw new Error(`[schema] ${section}: database connection not available`);
  }
  await db.execute(sql.raw(`
    ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS serial_no VARCHAR(64),
    ADD COLUMN IF NOT EXISTS imei VARCHAR(64),
    ADD COLUMN IF NOT EXISTS last_online_days INTEGER,
    ADD COLUMN IF NOT EXISTS last_online_at VARCHAR(32),
    ADD COLUMN IF NOT EXISTS device_lock BOOLEAN,
    ADD COLUMN IF NOT EXISTS loss_status INTEGER,
    ADD COLUMN IF NOT EXISTS mdm_device_id INTEGER,
    ADD COLUMN IF NOT EXISTS bad_debt_amount DECIMAL(12,2),
    ADD COLUMN IF NOT EXISTS bad_debt_date VARCHAR(20),
    ADD COLUMN IF NOT EXISTS suspended_from_period INTEGER,
    ADD COLUMN IF NOT EXISTS bad_debt_updated_by VARCHAR(128),
    ADD COLUMN IF NOT EXISTS bad_debt_updated_at VARCHAR(32)
  `));
  await db.execute(sql.raw(`
    ALTER TABLE sync_logs
    ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  `));

  const colList = CONTRACTS_SYNC_COLUMNS.map((c) => `'${c}'`).join(", ");
  const colCheck = await db.execute(sql.raw(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contracts'
      AND column_name IN (${colList})
  `));
  const present = new Set(pgRows(colCheck).map((r: { column_name?: string }) => r.column_name));
  const missing = CONTRACTS_SYNC_COLUMNS.filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new Error(
      `[schema] ${section}: contracts still missing columns after ALTER: ${missing.join(", ")}`,
    );
  }

  // Migration 0003 indexes — required for ON CONFLICT upserts (fastfone-db often missing these)
  await db.execute(sql.raw(`
    DELETE FROM contracts a
    USING contracts b
    WHERE a.id > b.id AND a.section = b.section AND a.external_id = b.external_id;

    DELETE FROM cached_customers a
    USING cached_customers b
    WHERE a.id > b.id AND a.section = b.section AND a.customer_id = b.customer_id;

    DELETE FROM installments a
    USING installments b
    WHERE a.id > b.id AND a.section = b.section AND a.external_id = b.external_id;

    DELETE FROM payment_transactions a
    USING payment_transactions b
    WHERE a.id > b.id AND a.section = b.section AND a.external_id = b.external_id;

    CREATE UNIQUE INDEX IF NOT EXISTS contracts_section_external_idx
      ON contracts (section, external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS cached_customers_section_customer_idx
      ON cached_customers (section, customer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS installments_section_external_idx
      ON installments (section, external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_section_external_idx
      ON payment_transactions (section, external_id);
  `));

  try {
    await db.execute(sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS commissions_section_external_idx
        ON commissions (section, external_id);
    `));
  } catch {
    // commissions table may not exist on older DBs — non-fatal until commissions sync runs
  }

  // Migration 0002: debt_target_cache / debt_collected_cache columns (populate INSERT requires these)
  await db.execute(sql.raw(`
    ALTER TABLE debt_target_cache
      ADD COLUMN IF NOT EXISTS partner_code VARCHAR(255),
      ADD COLUMN IF NOT EXISTS partner_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS device VARCHAR(64),
      ADD COLUMN IF NOT EXISTS model VARCHAR(128),
      ADD COLUMN IF NOT EXISTS serial_no VARCHAR(64),
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
      ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
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

    CREATE UNIQUE INDEX IF NOT EXISTS dtc_section_contract_period_idx
      ON debt_target_cache (section, contract_external_id, period);
    CREATE INDEX IF NOT EXISTS dtc_section_is_paid_idx ON debt_target_cache (section, is_paid);
    CREATE INDEX IF NOT EXISTS dtc_section_is_arrears_idx ON debt_target_cache (section, is_arrears);
    CREATE INDEX IF NOT EXISTS dtc_section_is_bad_debt_idx ON debt_target_cache (section, is_bad_debt);
  `));

  console.log(`[schema] ${section}: sync-critical columns + upsert indexes + debt cache cols verified`);
}

/**
 * runStartupMigrations — รัน DDL migrations ที่จำเป็นตอน startup
 * ใช้ CREATE TABLE IF NOT EXISTS เพื่อให้ idempotent (รันซ้ำได้ปลอดภัย)
 */
export async function runStartupMigrations(): Promise<void> {
  const sections: Array<"Boonphone" | "Fastfone365"> = ["Boonphone", "Fastfone365"];
  for (const section of sections) {
    const db = await getDb(section);
    if (!db) continue;
    try {
      // Migration 0006: monthly_summary_due_month_cache
      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS "monthly_summary_due_month_cache" (
          "id"                   INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          "section"              VARCHAR(32)      NOT NULL,
          "query_type"           VARCHAR(32)      NOT NULL,
          "approve_month"        VARCHAR(7)       NOT NULL,
          "due_month"            VARCHAR(16)      NOT NULL,
          "product_type"         VARCHAR(64),
          "device_family"        VARCHAR(16),
          "contract_count"       INTEGER          NOT NULL DEFAULT 0,
          "principal"            DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "interest"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "fee"                  DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "penalty"              DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "unlock_fee"           DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "discount"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "overpaid"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "bad_debt"             DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "bad_debt_installment" DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "total_amount"         DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "finance_total"        DECIMAL(18,2)    NOT NULL DEFAULT '0',
          "updated_at"           TIMESTAMP        NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS "msdmc_unique_idx"
          ON "monthly_summary_due_month_cache" (
            "section", "query_type", "approve_month", "due_month",
            COALESCE("product_type", ''), COALESCE("device_family", '')
          )
      `));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "msdmc_section_query_idx" ON "monthly_summary_due_month_cache" ("section", "query_type")`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "msdmc_section_approve_idx" ON "monthly_summary_due_month_cache" ("section", "approve_month")`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "msdmc_section_due_idx" ON "monthly_summary_due_month_cache" ("section", "due_month")`));
      console.log(`[migration] ${section}: monthly_summary_due_month_cache — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_summary_due_month_cache failed:`, err?.message ?? err);
    }
    try {
      // Migration 0007: เพิ่ม finance_total column ใน monthly_summary_cache (ยอดจัดฯ)
      await db.execute(sql.raw(`
        ALTER TABLE monthly_summary_cache
        ADD COLUMN IF NOT EXISTS finance_total DECIMAL(18,2) NOT NULL DEFAULT 0
      `));
      console.log(`[migration] ${section}: monthly_summary_cache.finance_total — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_summary_cache.finance_total failed:`, err?.message ?? err);
    }
    try {
      // Migration 0008: เพิ่ม serial_no column ใน debt_target_cache (เพื่อ match กับ MDM API)
      await db.execute(sql.raw(`
        ALTER TABLE debt_target_cache
        ADD COLUMN IF NOT EXISTS serial_no VARCHAR(64)
      `));
      console.log(`[migration] ${section}: debt_target_cache.serial_no — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: debt_target_cache.serial_no failed:`, err?.message ?? err);
    }
    try {
      // Migration 0009: เพิ่ม serial_no และ imei ใน contracts (เพื่อเก็บข้อมูลจาก detail API)
      await db.execute(sql.raw(`
        ALTER TABLE contracts
        ADD COLUMN IF NOT EXISTS serial_no VARCHAR(64),
        ADD COLUMN IF NOT EXISTS imei VARCHAR(64)
      `));
      console.log(`[migration] ${section}: contracts.serial_no, imei — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: contracts.serial_no, imei failed:`, err?.message ?? err);
    }
    try {
      // Migration 0010: เพิ่ม last_online_days และ last_online_at ใน contracts
      // เพื่อเก็บข้อมูล MDM online status โดยตรง (ไม่ต้องดึง detail API ทีละสัญญา)
      await db.execute(sql.raw(`
        ALTER TABLE contracts
        ADD COLUMN IF NOT EXISTS last_online_days INTEGER,
        ADD COLUMN IF NOT EXISTS last_online_at VARCHAR(32)
      `));
      console.log(`[migration] ${section}: contracts.last_online_days, last_online_at — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: contracts.last_online_days, last_online_at failed:`, err?.message ?? err);
    }
    try {
      // Migration 0011: เพิ่ม device_lock ใน contracts (สถานะล็อกเครื่องจาก MDM)
      await db.execute(sql.raw(`
        ALTER TABLE contracts
        ADD COLUMN IF NOT EXISTS device_lock BOOLEAN
      `));
      console.log(`[migration] ${section}: contracts.device_lock — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: contracts.device_lock failed:`, err?.message ?? err);
    }
    try {
      // Migration 0012: เพิ่ม finance_total column ใน monthly_summary_due_month_cache
      // (ยอดจัดฯ ต่อ approve_month × due_month — ใช้ใน getDueMonthSummaryFromCache)
      await db.execute(sql.raw(`
        ALTER TABLE monthly_summary_due_month_cache
        ADD COLUMN IF NOT EXISTS finance_total DECIMAL(18,2) NOT NULL DEFAULT 0
      `));
      console.log(`[migration] ${section}: monthly_summary_due_month_cache.finance_total — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_summary_due_month_cache.finance_total failed:`, err?.message ?? err);
    }
    try {
      // Migration 0014: เพิ่ม financed_total, overdue_total, collected_sale ใน monthly_collection_snapshot
      await db.execute(sql.raw(`
        ALTER TABLE monthly_collection_snapshot
        ADD COLUMN IF NOT EXISTS financed_total  DECIMAL(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS overdue_total   DECIMAL(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS collected_sale  DECIMAL(18,2) NOT NULL DEFAULT 0
      `));
      console.log(`[migration] ${section}: monthly_collection_snapshot — financed_total, overdue_total, collected_sale OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_collection_snapshot new cols failed:`, err?.message ?? err);
    }
    try {
      // Migration 0015: สร้าง monthly_target_detail_snapshot table
      // เก็บ snapshot รายสัญญา ณ วันที่ 1 ของทุกเดือน (freeze ตลอด)
      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS "monthly_target_detail_snapshot" (
          "id"                    INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          "section"               VARCHAR(32)      NOT NULL,
          "snapshot_month"        VARCHAR(7)       NOT NULL,
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
          "period"                INTEGER,
          "due_date"              VARCHAR(20),
          "principal"             DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "interest"              DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "fee"                   DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "penalty"               DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "unlock_fee"            DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "total_amount"          DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "paid_amount"           DECIMAL(12,2)    NOT NULL DEFAULT '0',
          "contract_status"       VARCHAR(32),
          "debt_range"            VARCHAR(32),
          "is_paid"               BOOLEAN          NOT NULL DEFAULT FALSE,
          "is_arrears"            BOOLEAN          NOT NULL DEFAULT FALSE,
          "is_bad_debt"           BOOLEAN          NOT NULL DEFAULT FALSE,
          "is_closed"             BOOLEAN          NOT NULL DEFAULT FALSE,
          "is_suspended"          BOOLEAN          NOT NULL DEFAULT FALSE,
          "is_current_period"     BOOLEAN          NOT NULL DEFAULT FALSE,
          "is_future_period"      BOOLEAN          NOT NULL DEFAULT FALSE,
          "populated_at"          TIMESTAMP        NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "mtds_section_month_idx" ON "monthly_target_detail_snapshot" ("section", "snapshot_month")`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "mtds_section_month_contract_idx" ON "monthly_target_detail_snapshot" ("section", "snapshot_month", "contract_external_id")`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "mtds_section_month_due_idx" ON "monthly_target_detail_snapshot" ("section", "snapshot_month", "due_date")`));
      console.log(`[migration] ${section}: monthly_target_detail_snapshot — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_target_detail_snapshot failed:`, err?.message ?? err);
    }
    try {
      // Migration 0013: ขยาย due_month เป็น VARCHAR(16) (backup migration สำหรับค่า sentinel เก่า "__approved__" และ "__summary__" ที่ยาวเกิน 7 ตัว)
      await db.execute(sql.raw(`
        ALTER TABLE monthly_summary_due_month_cache
        ALTER COLUMN due_month TYPE VARCHAR(16)
      `));
      console.log(`[migration] ${section}: monthly_summary_due_month_cache.due_month -> VARCHAR(16) — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_summary_due_month_cache.due_month -> VARCHAR(16) failed:`, err?.message ?? err);
    }
    try {
      // Migration 0016: เพิ่ม snapshot metadata columns ใน monthly_target_detail_snapshot
      // snapshot_mode: 'today' | 'end_of_month' — cutoff ที่ใช้ตอน populate
      // cutoff_date: วันที่ cutoff จริง (YYYY-MM-DD)
      // filter_debt_only: toggle ตั้งหนี้ที่เปิดอยู่ตอน snapshot
      // filter_principal_only: toggle เฉพาะเงินต้นที่เปิดอยู่ตอน snapshot
      await db.execute(sql.raw(`ALTER TABLE monthly_target_detail_snapshot ADD COLUMN IF NOT EXISTS snapshot_mode VARCHAR(16) DEFAULT 'today'`));
      await db.execute(sql.raw(`ALTER TABLE monthly_target_detail_snapshot ADD COLUMN IF NOT EXISTS cutoff_date VARCHAR(10) DEFAULT NULL`));
      await db.execute(sql.raw(`ALTER TABLE monthly_target_detail_snapshot ADD COLUMN IF NOT EXISTS filter_debt_only BOOLEAN DEFAULT FALSE`));
      await db.execute(sql.raw(`ALTER TABLE monthly_target_detail_snapshot ADD COLUMN IF NOT EXISTS filter_principal_only BOOLEAN DEFAULT TRUE`));
      console.log(`[migration] ${section}: monthly_target_detail_snapshot snapshot metadata columns — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_target_detail_snapshot snapshot metadata columns failed:`, err?.message ?? err);
    }
    try {
      // Migration 0017: ลบ Snapshot เก่าทั้งหมด — populate logic เปลี่ยนเป็น v3
      // ใช้ migration_flags table เพื่อตรวจสอบว่ารันแล้วหรือยัง (รันแค่ครั้งเดียว)
      await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS migration_flags (flag_key VARCHAR(128) PRIMARY KEY, ran_at TIMESTAMP NOT NULL DEFAULT NOW())`));
      const m17 = await db.execute(sql.raw(`SELECT 1 FROM migration_flags WHERE flag_key = 'snapshot_v3_reset_${section}'`));
      const m17rows = pgRows(m17);
      if (m17rows.length === 0) {
        await db.execute(sql.raw(`DELETE FROM monthly_target_detail_snapshot WHERE section = '${section}'`));
        await db.execute(sql.raw(`INSERT INTO migration_flags (flag_key) VALUES ('snapshot_v3_reset_${section}') ON CONFLICT DO NOTHING`));
        console.log(`[migration] ${section}: monthly_target_detail_snapshot — cleared all old snapshots (v3 reset)`);
      } else {
        console.log(`[migration] ${section}: monthly_target_detail_snapshot v3 reset — already done, skipping`);
      }
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_target_detail_snapshot clear failed:`, err?.message ?? err);
    }
    try {
      // Migration 0018: เพิ่ม phone column ใน monthly_target_detail_snapshot
      // phone ไม่ได้อยู่ใน debt_target_cache — ต้อง JOIN กับ contracts ตอน populate
      await db.execute(sql.raw(`ALTER TABLE monthly_target_detail_snapshot ADD COLUMN IF NOT EXISTS phone VARCHAR(32)`));
      console.log(`[migration] ${section}: monthly_target_detail_snapshot.phone — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_target_detail_snapshot.phone failed:`, err?.message ?? err);
    }
    try {
      // Migration 0019: ลบ Snapshot เก่าทั้งหมด — populate logic เปลี่ยนเป็น v4 (เพิ่ม phone)
      // ใช้ migration_flags table เพื่อตรวจสอบว่ารันแล้วหรือยัง (รันแค่ครั้งเดียว)
      await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS migration_flags (flag_key VARCHAR(128) PRIMARY KEY, ran_at TIMESTAMP NOT NULL DEFAULT NOW())`));
      const m19 = await db.execute(sql.raw(`SELECT 1 FROM migration_flags WHERE flag_key = 'snapshot_v4_reset_${section}'`));
      const m19rows = pgRows(m19);
      if (m19rows.length === 0) {
        await db.execute(sql.raw(`DELETE FROM monthly_target_detail_snapshot WHERE section = '${section}'`));
        await db.execute(sql.raw(`INSERT INTO migration_flags (flag_key) VALUES ('snapshot_v4_reset_${section}') ON CONFLICT DO NOTHING`));
        console.log(`[migration] ${section}: monthly_target_detail_snapshot — cleared all old snapshots (v4 reset)`);
      } else {
        console.log(`[migration] ${section}: monthly_target_detail_snapshot v4 reset — already done, skipping`);
      }
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_target_detail_snapshot clear failed:`, err?.message ?? err);
    }
    try {
      // Migration 0020: เพิ่ม filter_state column (JSON) ใน monthly_target_detail_snapshot
      // เก็บ filter state ที่ใช้ตอน Snapshot เพื่อ auto-restore เมื่อเปิดดู Snapshot
      await db.execute(sql.raw(`ALTER TABLE monthly_target_detail_snapshot ADD COLUMN IF NOT EXISTS filter_state TEXT DEFAULT NULL`));
      console.log(`[migration] ${section}: monthly_target_detail_snapshot.filter_state — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_target_detail_snapshot.filter_state failed:`, err?.message ?? err);
    }
    try {
      // Migration 0022: เพิ่ม target_by_range และ daily_breakdown ใน monthly_collection_snapshot
      // เก็บ pre-computed data เพื่อให้โหลดเร็ว ไม่ต้อง query real-time
      // target_by_range: { "ปกติ": 1234, "เกิน 1-7": 5678, ... } (6 สถานะ default)
      // daily_breakdown: { "1": { target: 1234, collected: 0 }, "2": {...}, ... } (รายวัน)
      await db.execute(sql.raw(`
        ALTER TABLE monthly_collection_snapshot
        ADD COLUMN IF NOT EXISTS target_by_range  JSONB,
        ADD COLUMN IF NOT EXISTS daily_breakdown  JSONB
      `));
      console.log(`[migration] ${section}: monthly_collection_snapshot — target_by_range, daily_breakdown OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_collection_snapshot target_by_range/daily_breakdown failed:`, err?.message ?? err);
    }
    try {
      // Migration 0021: สร้าง monthly_collection_snapshot table (IF NOT EXISTS)
      // ป้องกัน DB ที่ไม่เคยรัน migration นี้ (เช่น section ที่เพิ่มทีหลัง)
      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS monthly_collection_snapshot (
          id                      INTEGER          PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          section                 VARCHAR(32)      NOT NULL,
          collection_month        VARCHAR(7)       NOT NULL,
          target_amount           NUMERIC          NOT NULL DEFAULT 0,
          target_contract_count   INTEGER          NOT NULL DEFAULT 0,
          target_frozen_at        TIMESTAMP,
          target_principal        NUMERIC          NOT NULL DEFAULT 0,
          target_interest         NUMERIC          NOT NULL DEFAULT 0,
          target_fee              NUMERIC          NOT NULL DEFAULT 0,
          target_penalty          NUMERIC          NOT NULL DEFAULT 0,
          target_unlock_fee       NUMERIC          NOT NULL DEFAULT 0,
          collected_amount        NUMERIC          NOT NULL DEFAULT 0,
          collected_contract_count INTEGER         NOT NULL DEFAULT 0,
          collected_frozen_at     TIMESTAMP,
          collected_is_frozen     BOOLEAN          NOT NULL DEFAULT false,
          collected_principal     NUMERIC          NOT NULL DEFAULT 0,
          collected_interest      NUMERIC          NOT NULL DEFAULT 0,
          collected_fee           NUMERIC          NOT NULL DEFAULT 0,
          collected_penalty       NUMERIC          NOT NULL DEFAULT 0,
          collected_unlock_fee    NUMERIC          NOT NULL DEFAULT 0,
          collected_discount      NUMERIC          NOT NULL DEFAULT 0,
          collected_overpaid      NUMERIC          NOT NULL DEFAULT 0,
          collected_bad_debt      NUMERIC          NOT NULL DEFAULT 0,
          install_total           NUMERIC          NOT NULL DEFAULT 0,
          financed_total          NUMERIC          NOT NULL DEFAULT 0,
          overdue_total           NUMERIC          NOT NULL DEFAULT 0,
          collected_sale          NUMERIC          NOT NULL DEFAULT 0,
          created_at              TIMESTAMP        NOT NULL DEFAULT NOW(),
          updated_at              TIMESTAMP        NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS mcs_section_month_idx
          ON monthly_collection_snapshot (section, collection_month)
      `));
      console.log(`[migration] ${section}: monthly_collection_snapshot — CREATE TABLE IF NOT EXISTS OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: monthly_collection_snapshot CREATE failed:`, err?.message ?? err);
    }
    try {
      // Migration 0023: Notice — print batches / print logs / restore logs
      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS notice_print_batches (
          id            INTEGER       PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          section       VARCHAR(32)   NOT NULL,
          printed_by    VARCHAR(128)  NOT NULL,
          printed_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
          total_items   INTEGER       NOT NULL DEFAULT 0,
          pdf_file_url  TEXT,
          excel_file_url TEXT,
          created_at    TIMESTAMP     NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS npb_section_printed_idx ON notice_print_batches (section, printed_at)`));

      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS notice_print_logs (
          id                   INTEGER       PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          section              VARCHAR(32)   NOT NULL,
          contract_external_id VARCHAR(64)   NOT NULL,
          contract_no          VARCHAR(64),
          notice_round         INTEGER       NOT NULL,
          printed_by           VARCHAR(128)  NOT NULL,
          printed_at           TIMESTAMP     NOT NULL DEFAULT NOW(),
          batch_id             INTEGER,
          pdf_file_url         TEXT,
          excel_file_url       TEXT,
          created_at           TIMESTAMP     NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS npl_section_contract_idx ON notice_print_logs (section, contract_external_id)`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS npl_section_printed_by_idx ON notice_print_logs (section, printed_by)`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS npl_section_printed_at_idx ON notice_print_logs (section, printed_at)`));

      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS notice_restore_logs (
          id                   INTEGER       PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          section              VARCHAR(32)   NOT NULL,
          contract_external_id VARCHAR(64)   NOT NULL,
          contract_no          VARCHAR(64),
          notice_round         INTEGER       NOT NULL,
          restored_by          VARCHAR(128)  NOT NULL,
          restored_at          TIMESTAMP     NOT NULL DEFAULT NOW(),
          reason               TEXT,
          created_at           TIMESTAMP     NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS nrl_section_contract_idx ON notice_restore_logs (section, contract_external_id)`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS nrl_section_restored_by_idx ON notice_restore_logs (section, restored_by)`));
      console.log(`[migration] ${section}: notice_print_batches / notice_print_logs / notice_restore_logs — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: notice tables failed:`, err?.message ?? err);
    }
    try {
      // Migration 0024: contracts — loss_status + mdm_device_id (MDM/GPS; sync upsert references these columns)
      await db.execute(sql.raw(`
        ALTER TABLE contracts
        ADD COLUMN IF NOT EXISTS loss_status INTEGER,
        ADD COLUMN IF NOT EXISTS mdm_device_id INTEGER
      `));
      console.log(`[migration] ${section}: contracts.loss_status, mdm_device_id — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: contracts.loss_status, mdm_device_id failed:`, err?.message ?? err);
    }
    try {
      // Migration 0025: device_location_logs (GPS history)
      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS device_location_logs (
          id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          section       VARCHAR(64)  NOT NULL,
          serial_no     VARCHAR(64)  NOT NULL,
          mdm_device_id INTEGER      NOT NULL,
          latitude      VARCHAR(32)  NOT NULL,
          longitude     VARCHAR(32)  NOT NULL,
          altitude      VARCHAR(32),
          speed         VARCHAR(32),
          recorded_at   TIMESTAMP    NOT NULL DEFAULT NOW()
        )
      `));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS dll_section_serial_idx ON device_location_logs(section, serial_no)`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS dll_section_recorded_idx ON device_location_logs(section, recorded_at)`));
      console.log(`[migration] ${section}: device_location_logs — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: device_location_logs failed:`, err?.message ?? err);
    }
    try {
      // Migration 0026: sync_logs.stage_updated_at — heartbeat for zombie sync detection
      await db.execute(sql.raw(`
        ALTER TABLE sync_logs
        ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      `));
      console.log(`[migration] ${section}: sync_logs.stage_updated_at — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: sync_logs.stage_updated_at failed:`, err?.message ?? err);
    }
    try {
      // Migration 0027: contracts bad_debt columns (Drizzle INSERT references these)
      await db.execute(sql.raw(`
        ALTER TABLE contracts
        ADD COLUMN IF NOT EXISTS bad_debt_amount DECIMAL(12,2),
        ADD COLUMN IF NOT EXISTS bad_debt_date VARCHAR(20),
        ADD COLUMN IF NOT EXISTS suspended_from_period INTEGER,
        ADD COLUMN IF NOT EXISTS bad_debt_updated_by VARCHAR(128),
        ADD COLUMN IF NOT EXISTS bad_debt_updated_at VARCHAR(32)
      `));
      console.log(`[migration] ${section}: contracts.bad_debt_* — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: contracts.bad_debt_* failed:`, err?.message ?? err);
    }
    try {
      // Migration 0028: unique indexes for ON CONFLICT upserts (sync engine)
      await db.execute(sql.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS contracts_section_external_idx
          ON contracts (section, external_id);
        CREATE UNIQUE INDEX IF NOT EXISTS cached_customers_section_customer_idx
          ON cached_customers (section, customer_id);
        CREATE UNIQUE INDEX IF NOT EXISTS installments_section_external_idx
          ON installments (section, external_id);
        CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_section_external_idx
          ON payment_transactions (section, external_id);
        CREATE UNIQUE INDEX IF NOT EXISTS commissions_section_external_idx
          ON commissions (section, external_id);
      `));
      console.log(`[migration] ${section}: upsert unique indexes — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: upsert unique indexes failed:`, err?.message ?? err);
    }
    try {
      // Migration 0029: debt cache columns required by populateDebtCache INSERT
      await db.execute(sql.raw(`
        ALTER TABLE debt_target_cache
          ADD COLUMN IF NOT EXISTS partner_code VARCHAR(255),
          ADD COLUMN IF NOT EXISTS partner_name VARCHAR(255),
          ADD COLUMN IF NOT EXISTS device VARCHAR(64),
          ADD COLUMN IF NOT EXISTS model VARCHAR(128),
          ADD COLUMN IF NOT EXISTS serial_no VARCHAR(64),
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
          ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
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
        CREATE UNIQUE INDEX IF NOT EXISTS dtc_section_contract_period_idx
          ON debt_target_cache (section, contract_external_id, period);
      `));
      console.log(`[migration] ${section}: debt_target_cache / debt_collected_cache cols — OK`);
    } catch (err: any) {
      console.error(`[migration] ${section}: debt cache cols failed:`, err?.message ?? err);
    }
  }
}

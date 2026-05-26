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
    if (!_fastfoneDb) {
      const url = process.env.FASTFONE_DATABASE_URL || process.env.FASTFONE365_DATABASE_URL || process.env.DATABASE_URL;
      if (!url) return null;
      try {
        _fastfoneDb = drizzle(createPool(url));
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
    if (!url) return null;
    try {
      _boonphoneDb = drizzle(createPool(url));
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
          "due_month"            VARCHAR(7)       NOT NULL,
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
  }
}

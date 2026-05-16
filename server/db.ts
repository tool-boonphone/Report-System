import { eq } from "drizzle-orm";
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
      const url = process.env.DATABASE_URL_FASTFONE365 || process.env.DATABASE_URL;
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
    const url = process.env.DATABASE_URL_BOONPHONE || process.env.DATABASE_URL;
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
 * Get auth database (users, app_users) — always boonphone-db.
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

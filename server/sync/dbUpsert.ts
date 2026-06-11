/**
 * Batched upserts for the sync engine.
 *
 * PostgreSQL uses `ON CONFLICT (section, external_id) DO UPDATE SET ...`
 * We chunk rows to keep individual queries manageable and to give progress callbacks a cadence.
 *
 * IMPORTANT: In PostgreSQL, the `set` block must reference the incoming row values via `EXCLUDED.col`.
 */

import { getDb } from "../db";
import { sql, type SQL } from "drizzle-orm";
import {
  contracts,
  installments,
  paymentTransactions,
  cachedCustomers,
  commissions,
} from "../../drizzle/schema";
import { normalizeSectionKey, type SectionKey } from "../../shared/const";

const BATCH_SIZE = 1000; // เพิ่มจาก 200 เป็น 1000 เพื่อเร่งความเร็วในการ Upsert ลง DB

type AnyRow = Record<string, any>;

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Camel → snake converter used to build EXCLUDED.col references for PostgreSQL. */
function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Build an `ON CONFLICT DO UPDATE` set block that points every column to its
 * freshly-inserted value via `EXCLUDED.col`.
 */
function buildUpsertSet(
  sampleRow: AnyRow,
  table: Record<string, any>,
): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sampleRow)) {
    if (key === "section" || key === "externalId" || key === "customerId") continue;
    // Skip keys that don't exist on the drizzle table (defensive).
    if (!(key in table)) continue;
    const col = snake(key);
    set[key] = sql.raw(`EXCLUDED."${col}"`);
  }
  // Always refresh syncedAt so the audit column is current.
  set.syncedAt = sql`CURRENT_TIMESTAMP`;
  return set;
}

/**
 * Normalize section field in every row before inserting into DB.
 * Ensures consistent SectionKey regardless of what the caller passes.
 */
function normalizeRows(rows: AnyRow[]): AnyRow[] {
  return rows.map((r) => ({
    ...r,
    section: normalizeSectionKey(r.section as string),
  }));
}

export async function upsertContracts(rows: AnyRow[], section: SectionKey): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb(section);
  if (!db) throw new Error("DB not available for upsertContracts");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, contracts as any);
    // lastOnlineDays / lastOnlineAt ถูก set โดย MDM stage ซึ่งรันหลัง upsertContracts
    // ดังนั้น upsert contracts จาก API จะ overwrite ด้วย null ก่อน แล้ว MDM stage จะ update ทับอีกครั้ง
    // ไม่ต้องใช้ COALESCE เพราะ syncMdmOnlineDays ใหม่จะข้ามการ update ถ้า SN ไม่เจอใน MDM
    // (ป้องกันการ set null เมื่อ Cloudflare block MDM API)
    await db
      .insert(contracts)
      .values(merged as any)
      .onConflictDoUpdate({
        target: [contracts.section, contracts.externalId],
        set: setObj as any,
      });
    total += merged.length;
  }
  return total;
}

export async function upsertInstallments(rows: AnyRow[], section: SectionKey): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb(section);
  if (!db) throw new Error("DB not available for upsertInstallments");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, installments as any);
    // Preserve updatedBy/updatedAt that were enriched from contract detail API.
    // Use COALESCE so the existing DB value is kept when the incoming value is NULL.
    setObj.updatedBy = sql.raw(`COALESCE(EXCLUDED."updated_by", "installments"."updated_by")`);
    setObj.updatedAt = sql.raw(`COALESCE(EXCLUDED."updated_at", "installments"."updated_at")`);
    await db
      .insert(installments)
      .values(merged as any)
      .onConflictDoUpdate({
        target: [installments.section, installments.externalId],
        set: setObj as any,
      });
    total += merged.length;
  }
  return total;
}

export async function upsertPayments(rows: AnyRow[], section: SectionKey): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb(section);
  if (!db) throw new Error("DB not available for upsertPayments");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, paymentTransactions as any);
    await db
      .insert(paymentTransactions)
      .values(merged as any)
      .onConflictDoUpdate({
        target: [paymentTransactions.section, paymentTransactions.externalId],
        set: setObj as any,
      });
    total += merged.length;
  }
  return total;
}

/**
 * If the same (section, externalId) appears multiple times in one batch, merge
 * them together: later entries overwrite earlier ones.
 */
function mergeBatch<T extends AnyRow>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.section}::${r.externalId || r.customerId}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r });
    } else {
      // Merge, keeping truthy values from the newer row.
      const merged: AnyRow = { ...prev };
      for (const [k, v] of Object.entries(r)) {
        if (v !== undefined && v !== null && v !== "") {
          merged[k] = v;
        }
      }
      map.set(key, merged as T);
    }
  }
  return Array.from(map.values());
}

/** Return a row that contains every key that appears in any row of the batch. */
function unionKeys(rows: AnyRow[]): AnyRow {
  const out: AnyRow = {};
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!(k in out)) out[k] = r[k];
    }
  }
  return out;
}

/**
 * Upsert customer rows into `cached_customers`.
 * Unique key: (section, customer_id).
 */
export async function upsertCachedCustomers(rows: AnyRow[], section: SectionKey): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb(section);
  if (!db) throw new Error("DB not available for upsertCachedCustomers");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const deduped = mergeBatch(batch);
    const sample = unionKeys(deduped);
    const setObj = buildUpsertSet(sample, cachedCustomers as any);
    await db
      .insert(cachedCustomers)
      .values(deduped as any)
      .onConflictDoUpdate({
        target: [cachedCustomers.section, cachedCustomers.customerId],
        set: setObj as any,
      });
    total += deduped.length;
  }
  return total;
}

export async function upsertCommissions(rows: AnyRow[], section: SectionKey): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb(section);
  if (!db) throw new Error("DB not available for upsertCommissions");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, commissions as any);
    await db
      .insert(commissions)
      .values(merged as any)
      .onConflictDoUpdate({
        target: [commissions.section, commissions.externalId],
        set: setObj as any,
      });
    total += merged.length;
  }
  return total;
}

/**
 * Load all cached customers for a section into a Map keyed by customer_id string.
 */
export async function loadCachedCustomersBySection(
  section: SectionKey,
): Promise<Map<string, AnyRow>> {
  const db = await getDb(section);
  if (!db) return new Map();
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(cachedCustomers)
    .where(eq(cachedCustomers.section, normalizeSectionKey(section)));
  const map = new Map<string, AnyRow>();
  for (const r of rows) {
    map.set(String(r.customerId), r);
  }
  return map;
}

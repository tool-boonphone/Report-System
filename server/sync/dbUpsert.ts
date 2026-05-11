/**
 * Batched upserts for the sync engine.
 *
 * Drizzle's `onDuplicateKeyUpdate()` lets us use the unique index
 * `(section, external_id)` as a natural key. We chunk rows to keep individual
 * queries under MySQL's packet limit and to give progress callbacks a cadence.
 *
 * IMPORTANT: the `set` block must reference the *incoming* row values, not the
 * existing column. In MySQL that is `col = VALUES(col)`, which is what we emit
 * via `sql`VALUES(col)``. Using a drizzle `Column` object here would compile
 * to `col = \`contracts\`.\`col\`` — a self-assignment that silently turns the
 * update into a no-op (which is how previously-synced rows ended up with NULL
 * customer fields).
 */

import { getDb } from "../db";
import { sql, type SQL } from "drizzle-orm";
import {
  contracts,
  installments,
  paymentTransactions,
  cachedCustomers,
} from "../../drizzle/schema";
import { normalizeSectionKey } from "../../shared/const";

const BATCH_SIZE = 200;

type AnyRow = Record<string, any>;

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Camel → snake converter used to build `VALUES(col)` references for MySQL. */
function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Build an `ON DUPLICATE KEY UPDATE` set block that points every column to its
 * freshly-inserted value via `VALUES(col)`. We intentionally exclude the
 * unique key (`section`, `externalId`) so we never try to rewrite the key.
 */
function buildUpsertSet(
  sampleRow: AnyRow,
  table: Record<string, any>,
): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sampleRow)) {
    if (key === "section" || key === "externalId") continue;
    // Skip keys that don't exist on the drizzle table (defensive).
    if (!(key in table)) continue;
    const col = snake(key);
    set[key] = sql.raw(`VALUES(\`${col}\`)`);
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

export async function upsertContracts(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertContracts");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    // Union of keys across the batch → ensures every column touched by any row
    // is in the SET clause (otherwise a row that is the first in a batch but
    // happens to miss some keys would leave those columns stale for every
    // other row in the same chunk).
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, contracts as any);
    await db
      .insert(contracts)
      .values(merged as any)
      .onDuplicateKeyUpdate({ set: setObj as any });
    total += merged.length;
  }
  return total;
}

export async function upsertInstallments(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertInstallments");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, installments as any);
    // Preserve updatedBy/updatedAt that were enriched from contract detail API.
    // The bulk installments endpoint does NOT return these fields (they come back
    // as null), so overwriting them on every re-sync would wipe out the enriched
    // values and force a full re-enrichment of all 17k+ contracts every time.
    // Use COALESCE so the existing DB value is kept when the incoming value is NULL.
    setObj.updatedBy = sql.raw("COALESCE(VALUES(`updated_by`), `updated_by`)");
    setObj.updatedAt = sql.raw("COALESCE(VALUES(`updated_at`), `updated_at`)");
    await db
      .insert(installments)
      .values(merged as any)
      .onDuplicateKeyUpdate({ set: setObj as any });
    total += merged.length;
  }
  return total;
}

export async function upsertPayments(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertPayments");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const sample = unionKeys(merged);
    const setObj = buildUpsertSet(sample, paymentTransactions as any);
    await db
      .insert(paymentTransactions)
      .values(merged as any)
      .onDuplicateKeyUpdate({ set: setObj as any });
    total += merged.length;
  }
  return total;
}

/**
 * If the same (section, externalId) appears multiple times in one batch, merge
 * them together: later entries overwrite earlier ones. MySQL raises
 * "INSERT ... ON DUPLICATE KEY UPDATE" with duplicate-in-payload rows as an
 * error, so we preempt that here.
 */
function mergeBatch<T extends AnyRow>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.section}::${r.externalId}`;
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
 * Refreshes all columns on conflict so stale data is overwritten.
 */
export async function upsertCachedCustomers(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertCachedCustomers");
  let total = 0;
  for (const batch of chunks(normalizeRows(rows), BATCH_SIZE)) {
    // Deduplicate by (section, customerId) -- keep last occurrence.
    const map = new Map<string, AnyRow>();
    for (const r of batch) {
      map.set(`${r.section}::${r.customerId}`, r);
    }
    const deduped = Array.from(map.values());
    const sample = unionKeys(deduped);
    const setObj: Record<string, SQL> = {};
    for (const key of Object.keys(sample)) {
      if (key === "section" || key === "customerId") continue;
      if (!(key in cachedCustomers)) continue;
      const col = snake(key);
      setObj[key] = sql.raw(`VALUES(\`${col}\`)`);
    }
    setObj.syncedAt = sql`CURRENT_TIMESTAMP`;
    await db
      .insert(cachedCustomers)
      .values(deduped as any)
      .onDuplicateKeyUpdate({ set: setObj as any });
    total += deduped.length;
  }
  return total;
}

/**
 * Load all cached customers for a section into a Map keyed by customer_id string.
 * Used by syncContracts to enrich contract rows without calling the customers API.
 */
export async function loadCachedCustomersBySection(
  section: string,
): Promise<Map<string, AnyRow>> {
  const db = await getDb();
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

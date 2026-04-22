/**
 * Batched upserts for the sync engine.
 *
 * Drizzle's `onDuplicateKeyUpdate()` lets us use the unique index
 * `(section, external_id)` as a natural key. We chunk rows to keep individual
 * queries under MySQL's packet limit and to give progress callbacks a cadence.
 */

import { getDb } from "../db";
import {
  contracts,
  installments,
  paymentTransactions,
} from "../../drizzle/schema";

const BATCH_SIZE = 200;

type AnyRow = Record<string, any>;

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Build the `set` object for onDuplicateKeyUpdate from a row — skip PK / externalId. */
function buildUpdateSet(row: AnyRow): AnyRow {
  const { externalId, section, ...rest } = row;
  // Always refresh syncedAt to mark latest-seen timestamp.
  rest.syncedAt = new Date();
  return rest;
}

export async function upsertContracts(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertContracts");
  let total = 0;
  for (const batch of chunks(rows, BATCH_SIZE)) {
    // Merge: if the same (section, externalId) appears twice in the same batch
    // (e.g. list + detail map), the later one wins.
    const merged = mergeBatch(batch);
    // Use the first row as template for the update-set keys; all rows share the same columns.
    const set = buildUpdateSet(merged[0]);
    const setKeys = Object.keys(set);
    await db
      .insert(contracts)
      .values(merged as any)
      .onDuplicateKeyUpdate({
        set: Object.fromEntries(
          setKeys.map((k) => [k, (contracts as any)[k]] as const)
            .concat([["syncedAt", contracts.syncedAt]])
            .map(([k]) => [k, (contracts as any)[k]]),
        ) as any,
      });
    total += merged.length;
  }
  return total;
}

export async function upsertInstallments(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertInstallments");
  let total = 0;
  for (const batch of chunks(rows, BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const set = buildUpdateSet(merged[0]);
    const keys = Object.keys(set);
    await db
      .insert(installments)
      .values(merged as any)
      .onDuplicateKeyUpdate({
        set: Object.fromEntries(
          keys.map((k) => [k, (installments as any)[k]]),
        ) as any,
      });
    total += merged.length;
  }
  return total;
}

export async function upsertPayments(rows: AnyRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB not available for upsertPayments");
  let total = 0;
  for (const batch of chunks(rows, BATCH_SIZE)) {
    const merged = mergeBatch(batch);
    const set = buildUpdateSet(merged[0]);
    const keys = Object.keys(set);
    await db
      .insert(paymentTransactions)
      .values(merged as any)
      .onDuplicateKeyUpdate({
        set: Object.fromEntries(
          keys.map((k) => [k, (paymentTransactions as any)[k]]),
        ) as any,
      });
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

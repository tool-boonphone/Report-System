/**
 * debtIdbCache.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * IndexedDB-backed persistent cache for debt data (target + collected rows).
 *
 * Cache expiry logic:
 *  - Data is valid until 04:00 AM of the NEXT day after it was loaded.
 *  - If the current time is past 04:00 AM today AND the cache was loaded
 *    before today's 04:00 AM → cache is stale → must reload.
 *  - Clear cache manually via clearIdbCache() (triggered by "Clear Cache" button).
 *
 * Storage:
 *  - DB name: "debt-cache-v1"
 *  - Object store: "sections"
 *  - Key: SectionKey ("Boonphone" | "Fastfone365")
 *  - Value: IdbCacheEntry
 */

import type { SectionKey } from "@shared/const";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IdbCacheEntry = {
  section: SectionKey;
  /** Unix ms timestamp when this cache was saved */
  savedAt: number;
  /** target rows */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetRows: any[];
  /** collected rows */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collectedRows: any[];
  /** whether collected data has principal breakdown */
  hasPrincipalBreakdown: boolean;
};

// ─── DB helpers ───────────────────────────────────────────────────────────────

const DB_NAME = "debt-cache-v1";
const STORE = "sections";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "section" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Expiry logic ─────────────────────────────────────────────────────────────

/**
 * Returns the Unix ms timestamp of 04:00 AM today (local time).
 * If current time is before 04:00 AM today, returns yesterday's 04:00 AM.
 * Effectively: the most recent 04:00 AM boundary.
 */
function getLastSyncBoundary(): number {
  const now = new Date();
  const boundary = new Date(now);
  boundary.setHours(4, 0, 0, 0); // 04:00 AM today
  if (now < boundary) {
    // before 04:00 AM today → use yesterday's 04:00 AM
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.getTime();
}

/**
 * Returns true if the cache entry is still valid (not expired).
 * Valid = savedAt is AFTER the most recent 04:00 AM boundary.
 */
export function isCacheValid(entry: IdbCacheEntry): boolean {
  const boundary = getLastSyncBoundary();
  return entry.savedAt >= boundary;
}

/** Cache is usable only when both target and collected have at least one row. */
export function isCachePopulated(entry: IdbCacheEntry): boolean {
  return entry.targetRows.length > 0 && entry.collectedRows.length > 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Read a cache entry for a section. Returns null if not found or expired. */
export async function readIdbCache(section: SectionKey): Promise<IdbCacheEntry | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.get(section);
      req.onsuccess = () => {
        const entry = req.result as IdbCacheEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }
        if (!isCacheValid(entry)) {
          // Expired → delete and return null
          const delTx = db.transaction(STORE, "readwrite");
          delTx.objectStore(STORE).delete(section);
          resolve(null);
          return;
        }
        resolve(entry);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Write a cache entry for a section. */
export async function writeIdbCache(entry: IdbCacheEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Silently fail — cache write failure should not break the app
  }
}

/** Clear cache for a specific section. */
export async function clearIdbCacheSection(section: SectionKey): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).delete(section);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Silently fail
  }
}

/** Clear ALL cached sections. */
export async function clearIdbCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Silently fail
  }
}

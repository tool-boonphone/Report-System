/**
 * debtCache.ts — Server-side in-memory cache for listDebtTarget / listDebtCollected
 *
 * ลด query time โดย cache ผลลัพธ์ไว้ 5 นาที ต่อ section
 * เมื่อ sync ใหม่เสร็จ ให้เรียก invalidateDebtCache(section) เพื่อ clear cache
 */

type CacheEntry<T> = {
  data: T;
  expiresAt: number; // Unix ms
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const targetCache = new Map<string, CacheEntry<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectedCache = new Map<string, CacheEntry<any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedTarget(section: string): any | null {
  const entry = targetCache.get(section);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    targetCache.delete(section);
    return null;
  }
  return entry.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCachedTarget(section: string, data: any): void {
  targetCache.set(section, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedCollected(section: string): any | null {
  const entry = collectedCache.get(section);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    collectedCache.delete(section);
    return null;
  }
  return entry.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCachedCollected(section: string, data: any): void {
  collectedCache.set(section, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** เรียกเมื่อ sync ใหม่เสร็จ เพื่อ clear cache ของ section นั้น */
export function invalidateDebtCache(section: string): void {
  targetCache.delete(section);
  collectedCache.delete(section);
  console.log(`[debtCache] Invalidated cache for section: ${section}`);
}

/** Invalidate all sections (used after logic fixes that affect all data) */
export function invalidateAllDebtCache(): void {
  targetCache.clear();
  collectedCache.clear();
  console.log('[debtCache] Invalidated ALL cache entries');
}

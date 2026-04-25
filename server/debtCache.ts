/**
 * debtCache.ts — Server-side in-memory cache for listDebtTarget / listDebtCollected
 *
 * ลด query time โดย cache ผลลัพธ์ไว้ 30 นาที ต่อ section
 * เมื่อ sync ใหม่เสร็จ ให้เรียก invalidateDebtCache(section) เพื่อ clear cache
 *
 * Phase 32: เพิ่ม TTL จาก 5 → 30 นาที เพื่อลด cache miss ที่ทำให้ reverse proxy timeout
 * เพิ่ม stale-while-revalidate: เมื่อ cache ใกล้หมด (< REFRESH_THRESHOLD_MS)
 *   ให้ return ข้อมูลเก่า (stale) ทันที และ refresh ใน background
 */

type CacheEntry<T> = {
  data: T;
  expiresAt: number; // Unix ms — hard expiry
  refreshAt: number; // Unix ms — soft expiry (trigger background refresh)
  isRefreshing?: boolean; // ป้องกัน concurrent refresh
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (Phase 32: เพิ่มจาก 5 นาที)
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh ล่วงหน้า 5 นาทีก่อน expire

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const targetCache = new Map<string, CacheEntry<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectedCache = new Map<string, CacheEntry<any>>();

// Background refresh callbacks — registered by debtPrewarm.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bgRefreshTarget: ((section: string) => Promise<any>) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bgRefreshCollected: ((section: string) => Promise<any>) | null = null;

/** Register background refresh callbacks (called from debtPrewarm.ts) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerBgRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetFn: (section: string) => Promise<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collectedFn: (section: string) => Promise<any>,
): void {
  _bgRefreshTarget = targetFn;
  _bgRefreshCollected = collectedFn;
}

function triggerBgRefreshTarget(section: string): void {
  if (!_bgRefreshTarget) return;
  const entry = targetCache.get(section);
  if (entry?.isRefreshing) return; // already refreshing
  if (entry) entry.isRefreshing = true;
  console.log(`[debtCache] Background refresh target for ${section}`);
  _bgRefreshTarget(section)
    .then((data) => {
      setCachedTarget(section, data);
      console.log(`[debtCache] Background refresh target done for ${section}`);
    })
    .catch((err) => {
      console.warn(`[debtCache] Background refresh target failed for ${section}:`, err);
      const e = targetCache.get(section);
      if (e) e.isRefreshing = false;
    });
}

function triggerBgRefreshCollected(section: string): void {
  if (!_bgRefreshCollected) return;
  const entry = collectedCache.get(section);
  if (entry?.isRefreshing) return; // already refreshing
  if (entry) entry.isRefreshing = true;
  console.log(`[debtCache] Background refresh collected for ${section}`);
  _bgRefreshCollected(section)
    .then((data) => {
      setCachedCollected(section, data);
      console.log(`[debtCache] Background refresh collected done for ${section}`);
    })
    .catch((err) => {
      console.warn(`[debtCache] Background refresh collected failed for ${section}:`, err);
      const e = collectedCache.get(section);
      if (e) e.isRefreshing = false;
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedTarget(section: string): any | null {
  const entry = targetCache.get(section);
  if (!entry) return null;
  const now = Date.now();
  if (now > entry.expiresAt) {
    // Hard expired — delete and return null (force fresh compute)
    targetCache.delete(section);
    return null;
  }
  // Stale-while-revalidate: return stale data and trigger background refresh
  if (now > entry.refreshAt && !entry.isRefreshing) {
    triggerBgRefreshTarget(section);
  }
  return entry.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCachedTarget(section: string, data: any): void {
  const now = Date.now();
  targetCache.set(section, {
    data,
    expiresAt: now + CACHE_TTL_MS,
    refreshAt: now + CACHE_TTL_MS - REFRESH_THRESHOLD_MS,
    isRefreshing: false,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedCollected(section: string): any | null {
  const entry = collectedCache.get(section);
  if (!entry) return null;
  const now = Date.now();
  if (now > entry.expiresAt) {
    // Hard expired — delete and return null (force fresh compute)
    collectedCache.delete(section);
    return null;
  }
  // Stale-while-revalidate: return stale data and trigger background refresh
  if (now > entry.refreshAt && !entry.isRefreshing) {
    triggerBgRefreshCollected(section);
  }
  return entry.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCachedCollected(section: string, data: any): void {
  const now = Date.now();
  collectedCache.set(section, {
    data,
    expiresAt: now + CACHE_TTL_MS,
    refreshAt: now + CACHE_TTL_MS - REFRESH_THRESHOLD_MS,
    isRefreshing: false,
  });
}

// Prewarm state tracking — ป้องกัน double-stream ระหว่าง prewarm + user request
const _prewarmingTarget = new Map<string, Promise<void>>();
const _prewarmingCollected = new Map<string, Promise<void>>();

/** Register a prewarm promise so concurrent requests can wait for it */
export function setPrewarmingTarget(section: string, p: Promise<void>): void {
  _prewarmingTarget.set(section, p);
  p.finally(() => _prewarmingTarget.delete(section));
}
export function setPrewarmingCollected(section: string, p: Promise<void>): void {
  _prewarmingCollected.set(section, p);
  p.finally(() => _prewarmingCollected.delete(section));
}
/** Wait for any in-progress prewarm for this section (returns immediately if none) */
export async function waitForPrewarmTarget(section: string): Promise<void> {
  const p = _prewarmingTarget.get(section);
  if (p) await p.catch(() => {});
}
export async function waitForPrewarmCollected(section: string): Promise<void> {
  const p = _prewarmingCollected.get(section);
  if (p) await p.catch(() => {});
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

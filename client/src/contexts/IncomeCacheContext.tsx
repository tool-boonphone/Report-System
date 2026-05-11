/**
 * IncomeCacheContext — Global in-memory cache for income rows per section.
 *
 * เก็บ income rows ทั้งหมดต่อ section ไว้ใน React Context
 * โดย prefetch ตั้งแต่ App load (background) เพื่อให้หน้ารายรับ
 * ไม่ต้องโหลดซ้ำเมื่อสลับ mode หรือกลับมาที่หน้านี้
 *
 * Cache จะถูก invalidate เมื่อ:
 *  - Re-Sync API สำเร็จ (เรียก invalidateIncomeCache)
 *  - Clear Cache (เรียก clearAll)
 *  - section เปลี่ยน (ล้าง cache ของ section เก่า)
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SectionKey } from "@shared/const";
import { trpc } from "@/lib/trpc";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;

export type IncomeCacheEntry = {
  /** income rows ทั้งหมด (ยังไม่ filter) */
  rows: AnyRow[] | null;
  /** Unix ms timestamp เมื่อ cache ถูก populate */
  loadedAt: number;
  /** จำนวน rows ที่โหลดแล้ว (ระหว่าง chunked fetch) */
  loadedCount: number;
  /** จำนวน rows ทั้งหมดจาก API */
  totalCount: number;
  /** กำลังโหลดอยู่ไหม */
  isLoading: boolean;
  /** โหลดครบแล้วไหม */
  isComplete: boolean;
  /** error message ถ้ามี */
  error: string | null;
};

type IncomeCacheContextValue = {
  /** ดึง cache entry ของ section ที่ระบุ */
  getCache: (section: SectionKey) => IncomeCacheEntry;
  /** เริ่ม prefetch สำหรับ section (ถ้ายังไม่มี cache) */
  prefetch: (section: SectionKey) => void;
  /** ล้าง cache ของ section และ refetch ใหม่ */
  invalidateIncomeCache: (section: SectionKey) => void;
  /** ล้าง cache ทั้งหมด */
  clearAll: () => void;
};

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */
const IncomeCacheContext = createContext<IncomeCacheContextValue | null>(null);

const CHUNK_SIZE = 2000;

const makeEmptyEntry = (): IncomeCacheEntry => ({
  rows: null,
  loadedAt: 0,
  loadedCount: 0,
  totalCount: 0,
  isLoading: false,
  isComplete: false,
  error: null,
});

export function IncomeCacheProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<Map<SectionKey, IncomeCacheEntry>>(new Map());
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // ใช้ tRPC utils สำหรับ fetch โดยตรง (ไม่ผ่าน useQuery)
  const utils = trpc.useUtils();

  // ติดตาม fetch ที่กำลังทำงานอยู่ เพื่อไม่ให้ fetch ซ้ำ
  const fetchingRef = useRef<Set<SectionKey>>(new Set());

  const getCache = useCallback((section: SectionKey): IncomeCacheEntry => {
    return cacheRef.current.get(section) ?? makeEmptyEntry();
  }, []);

  const updateEntry = useCallback(
    (section: SectionKey, patch: Partial<IncomeCacheEntry>) => {
      const prev = cacheRef.current.get(section) ?? makeEmptyEntry();
      cacheRef.current.set(section, { ...prev, ...patch });
      bump();
    },
    [bump],
  );

  /**
   * ดึงข้อมูล income ทั้งหมดแบบ chunked สำหรับ section ที่ระบุ
   * ถ้ากำลัง fetch อยู่แล้ว หรือ cache ครบแล้ว จะไม่ fetch ซ้ำ
   */
  const doFetch = useCallback(
    async (section: SectionKey) => {
      if (fetchingRef.current.has(section)) return;
      const existing = cacheRef.current.get(section);
      if (existing?.isComplete) return;

      fetchingRef.current.add(section);
      updateEntry(section, { isLoading: true, error: null, rows: existing?.rows ?? null });

      try {
        let page = 1;
        let allRows: AnyRow[] = existing?.rows ?? [];
        let totalCount = existing?.totalCount ?? 0;

        // ถ้ามี rows บางส่วนแล้ว ให้ต่อจาก page ที่ค้างไว้
        if (allRows.length > 0 && totalCount > 0) {
          page = Math.floor(allRows.length / CHUNK_SIZE) + 1;
        }

        while (true) {
          const result = await utils.accounting.listIncome.fetch({
            section,
            page,
            pageSize: CHUNK_SIZE,
          });

          const fetchedRows = result.rows as AnyRow[];
          totalCount = result.total;

          // ถ้าเป็น page แรก reset rows
          if (page === 1) {
            allRows = fetchedRows;
          } else {
            allRows = [...allRows, ...fetchedRows];
          }

          updateEntry(section, {
            rows: allRows,
            loadedCount: allRows.length,
            totalCount,
            isLoading: allRows.length < totalCount,
            isComplete: allRows.length >= totalCount,
            loadedAt: Date.now(),
          });

          if (allRows.length >= totalCount || fetchedRows.length === 0) {
            break;
          }

          page++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "โหลดข้อมูลรายรับไม่สำเร็จ";
        updateEntry(section, { isLoading: false, error: msg });
      } finally {
        fetchingRef.current.delete(section);
      }
    },
    [utils, updateEntry],
  );

  const prefetch = useCallback(
    (section: SectionKey) => {
      const existing = cacheRef.current.get(section);
      if (existing?.isComplete || existing?.isLoading) return;
      doFetch(section);
    },
    [doFetch],
  );

  const invalidateIncomeCache = useCallback(
    (section: SectionKey) => {
      fetchingRef.current.delete(section);
      cacheRef.current.set(section, makeEmptyEntry());
      bump();
      // refetch ทันที
      doFetch(section);
    },
    [doFetch, bump],
  );

  const clearAll = useCallback(() => {
    fetchingRef.current.clear();
    cacheRef.current.clear();
    bump();
  }, [bump]);

  return (
    <IncomeCacheContext.Provider
      value={{ getCache, prefetch, invalidateIncomeCache, clearAll }}
    >
      {children}
    </IncomeCacheContext.Provider>
  );
}

export function useIncomeCache() {
  const ctx = useContext(IncomeCacheContext);
  if (!ctx) throw new Error("useIncomeCache must be used within IncomeCacheProvider");
  return ctx;
}

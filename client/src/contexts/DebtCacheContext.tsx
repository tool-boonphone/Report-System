/**
 * DebtCacheContext — Global in-memory cache for debt data per section.
 *
 * เก็บ target rows + collected rows ต่อ section ไว้ใน React Context
 * เพื่อให้ DebtReport, DebtOverview, DebtSummary ใช้ข้อมูลร่วมกัน
 * โดยไม่ต้อง fetch ใหม่เมื่อเปลี่ยนเมนูแล้วกลับมา
 *
 * ใช้ unknown[] สำหรับ rows เพื่อหลีกเลี่ยง type conflict ระหว่างหน้า
 * แต่ละหน้า cast เป็น type ของตัวเองหลังจาก getCache()
 *
 * Cache จะถูก invalidate เมื่อ:
 *  - section เปลี่ยน (ล้าง cache ของ section เก่า)
 *  - ผู้ใช้กด "โหลดใหม่" ใน UI
 *  - ผู้ใช้ refresh browser (เพราะ state อยู่ใน memory เท่านั้น)
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { SectionKey } from "@shared/const";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;

export type DebtCacheEntry = {
  /** target rows (TargetRow[] ที่ cast จากแต่ละหน้า) */
  target: { rows: AnyRow[] } | null;
  /** collected rows (CollectedRow[] ที่ cast จากแต่ละหน้า) */
  collected: { rows: AnyRow[]; hasPrincipalBreakdown: boolean } | null;
  /** Unix ms timestamp เมื่อ cache ถูก populate ครั้งแรก */
  loadedAt: number;
  /** progress ระหว่าง loading (จำนวน rows ที่โหลดแล้ว) */
  progress: { target: number; collected: number };
  /** total contracts ที่ต้องโหลด */
  total: { target: number; collected: number };
  /** loading state */
  loading: { target: boolean; collected: boolean };
  /** error state */
  error: { target: string | null; collected: string | null };
};

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

type DebtCacheContextValue = {
  /** ดึง cache entry ของ section ที่ระบุ */
  getCache: (section: SectionKey) => DebtCacheEntry;
  /** อัปเดต target rows ของ section */
  setTargetRows: (section: SectionKey, rows: AnyRow[]) => void;
  /** อัปเดต collected rows ของ section */
  setCollectedRows: (section: SectionKey, rows: AnyRow[], hasPrincipalBreakdown: boolean) => void;
  /** อัปเดต loading/progress/total/error state */
  setLoadingState: (
    section: SectionKey,
    t: "target" | "collected",
    state: Partial<{ loading: boolean; progress: number; total: number; error: string | null }>,
  ) => void;
  /** ล้าง cache ของ section (เมื่อต้องการ refetch) */
  clearCache: (section: SectionKey) => void;
  /** ล้าง cache ทั้งหมด */
  clearAll: () => void;
};

const DebtCacheContext = createContext<DebtCacheContextValue | null>(null);

const makeEmptyEntry = (): DebtCacheEntry => ({
  target: null,
  collected: null,
  loadedAt: 0,
  progress: { target: 0, collected: 0 },
  total: { target: 0, collected: 0 },
  loading: { target: false, collected: false },
  error: { target: null, collected: null },
});

export function DebtCacheProvider({ children }: { children: ReactNode }) {
  // ใช้ useRef เพื่อเก็บ cache โดยไม่ trigger re-render เมื่ออัปเดต
  // แต่ใช้ version counter เพื่อ trigger re-render เมื่อจำเป็น
  const cacheRef = useRef<Map<SectionKey, DebtCacheEntry>>(new Map());
  const [, setVersion] = useState(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const getCache = useCallback((section: SectionKey): DebtCacheEntry => {
    return cacheRef.current.get(section) ?? makeEmptyEntry();
  }, []);

  const setTargetRows = useCallback((section: SectionKey, rows: AnyRow[]) => {
    const prev = cacheRef.current.get(section) ?? makeEmptyEntry();
    cacheRef.current.set(section, {
      ...prev,
      target: { rows },
      loadedAt: prev.loadedAt || Date.now(),
    });
    bump();
  }, [bump]);

  const setCollectedRows = useCallback((
    section: SectionKey,
    rows: AnyRow[],
    hasPrincipalBreakdown: boolean,
  ) => {
    const prev = cacheRef.current.get(section) ?? makeEmptyEntry();
    cacheRef.current.set(section, {
      ...prev,
      collected: { rows, hasPrincipalBreakdown },
      loadedAt: prev.loadedAt || Date.now(),
    });
    bump();
  }, [bump]);

  const setLoadingState = useCallback((
    section: SectionKey,
    t: "target" | "collected",
    state: Partial<{ loading: boolean; progress: number; total: number; error: string | null }>,
  ) => {
    const prev = cacheRef.current.get(section) ?? makeEmptyEntry();
    const updated: DebtCacheEntry = { ...prev };
    if (state.loading !== undefined) {
      updated.loading = { ...prev.loading, [t]: state.loading };
    }
    if (state.progress !== undefined) {
      updated.progress = { ...prev.progress, [t]: state.progress };
    }
    if (state.total !== undefined) {
      updated.total = { ...prev.total, [t]: state.total };
    }
    if (state.error !== undefined) {
      updated.error = { ...prev.error, [t]: state.error };
    }
    cacheRef.current.set(section, updated);
    bump();
  }, [bump]);

  const clearCache = useCallback((section: SectionKey) => {
    cacheRef.current.delete(section);
    bump();
  }, [bump]);

  const clearAll = useCallback(() => {
    cacheRef.current.clear();
    bump();
  }, [bump]);

  const value = useMemo<DebtCacheContextValue>(
    () => ({ getCache, setTargetRows, setCollectedRows, setLoadingState, clearCache, clearAll }),
    [getCache, setTargetRows, setCollectedRows, setLoadingState, clearCache, clearAll],
  );

  return (
    <DebtCacheContext.Provider value={value}>
      {children}
    </DebtCacheContext.Provider>
  );
}

export function useDebtCache(): DebtCacheContextValue {
  const ctx = useContext(DebtCacheContext);
  if (!ctx) throw new Error("useDebtCache must be used inside <DebtCacheProvider>");
  return ctx;
}

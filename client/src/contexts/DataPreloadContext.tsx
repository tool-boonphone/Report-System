/**
 * DataPreloadContext — ติดตาม state การ preload ข้อมูล 3 ส่วน:
 *  1. สัญญา (contracts)
 *  2. เป้าเก็บหนี้ (debt target)
 *  3. ยอดเก็บหนี้ (debt collected)
 *
 * หลัง SelectSection → navigate ไป /data-loading
 * เมื่อทั้ง 3 ส่วนโหลดเสร็จ → navigate ไป /contracts
 * ถ้าผู้ใช้ refresh browser และ section ยังอยู่ใน localStorage
 * → ตรวจสอบว่า cache ยังมีข้อมูลอยู่หรือไม่ ถ้าไม่มีให้ preload ใหม่
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type PreloadStatus = "idle" | "loading" | "done" | "error";

export type PreloadState = {
  contracts: { status: PreloadStatus; loaded: number; total: number; error: string | null };
  target: { status: PreloadStatus; loaded: number; total: number; error: string | null };
  collected: { status: PreloadStatus; loaded: number; total: number; error: string | null };
};

type DataPreloadContextValue = {
  state: PreloadState;
  isPreloading: boolean;
  isPreloaded: boolean;
  /** เริ่ม preload — ถูกเรียกจาก DataLoadingScreen */
  startPreload: () => void;
  /** อัปเดต state ของแต่ละส่วน */
  updateContracts: (update: Partial<PreloadState["contracts"]>) => void;
  updateTarget: (update: Partial<PreloadState["target"]>) => void;
  updateCollected: (update: Partial<PreloadState["collected"]>) => void;
  /** reset ทั้งหมด (เมื่อ section เปลี่ยน) */
  reset: () => void;
  /** section ที่ preload ครั้งล่าสุด */
  preloadedSection: string | null;
  setPreloadedSection: (s: string | null) => void;
};

const INITIAL_ITEM = { status: "idle" as PreloadStatus, loaded: 0, total: 0, error: null };

const INITIAL_STATE: PreloadState = {
  contracts: { ...INITIAL_ITEM },
  target: { ...INITIAL_ITEM },
  collected: { ...INITIAL_ITEM },
};

const DataPreloadContext = createContext<DataPreloadContextValue | null>(null);

export function DataPreloadProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PreloadState>(INITIAL_STATE);
  const [preloadedSection, setPreloadedSection] = useState<string | null>(null);
  const startedRef = useRef(false);

  const isPreloading = useMemo(() => {
    const { contracts, target, collected } = state;
    const statuses = [contracts.status, target.status, collected.status];
    return statuses.some((s) => s === "loading") && !statuses.every((s) => s === "done" || s === "error");
  }, [state]);

  const isPreloaded = useMemo(() => {
    const { contracts, target, collected } = state;
    return (
      (contracts.status === "done" || contracts.status === "error") &&
      (target.status === "done" || target.status === "error") &&
      (collected.status === "done" || collected.status === "error")
    );
  }, [state]);

  const startPreload = useCallback(() => {
    startedRef.current = true;
    setState({
      contracts: { status: "loading", loaded: 0, total: 0, error: null },
      target: { status: "loading", loaded: 0, total: 0, error: null },
      collected: { status: "loading", loaded: 0, total: 0, error: null },
    });
  }, []);

  const updateContracts = useCallback((update: Partial<PreloadState["contracts"]>) => {
    setState((prev) => ({ ...prev, contracts: { ...prev.contracts, ...update } }));
  }, []);

  const updateTarget = useCallback((update: Partial<PreloadState["target"]>) => {
    setState((prev) => ({ ...prev, target: { ...prev.target, ...update } }));
  }, []);

  const updateCollected = useCallback((update: Partial<PreloadState["collected"]>) => {
    setState((prev) => ({ ...prev, collected: { ...prev.collected, ...update } }));
  }, []);

  const reset = useCallback(() => {
    startedRef.current = false;
    setState(INITIAL_STATE);
  }, []);

  const value = useMemo<DataPreloadContextValue>(
    () => ({
      state,
      isPreloading,
      isPreloaded,
      startPreload,
      updateContracts,
      updateTarget,
      updateCollected,
      reset,
      preloadedSection,
      setPreloadedSection,
    }),
    [state, isPreloading, isPreloaded, startPreload, updateContracts, updateTarget, updateCollected, reset, preloadedSection, setPreloadedSection],
  );

  return (
    <DataPreloadContext.Provider value={value}>
      {children}
    </DataPreloadContext.Provider>
  );
}

export function useDataPreload(): DataPreloadContextValue {
  const ctx = useContext(DataPreloadContext);
  if (!ctx) throw new Error("useDataPreload must be used inside <DataPreloadProvider>");
  return ctx;
}

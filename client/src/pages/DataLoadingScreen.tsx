/**
 * DataLoadingScreen — หน้าโหลดข้อมูล 3 ส่วนก่อนเข้าใช้งานระบบ
 *
 * Flow:
 *  SelectSection → navigate("/data-loading") → DataLoadingScreen
 *  → โหลด contracts + debt target + debt collected พร้อมกัน
 *  → เมื่อครบทั้ง 3 → navigate("/contracts")
 *
 * หากผู้ใช้ refresh browser และ section ยังอยู่ใน localStorage
 * → ตรวจสอบว่า DebtCache มีข้อมูลอยู่แล้วหรือไม่
 *   - ถ้ามี → ข้ามหน้านี้ไป /contracts ทันที
 *   - ถ้าไม่มี → โหลดใหม่
 */

import { BRAND_ACCENT, BRAND_LOGOS } from "@/config/brand";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import type { SectionKey } from "@shared/const";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

type ItemStatus = "idle" | "loading" | "done" | "error";

type LoadItem = {
  key: "contracts" | "target" | "collected";
  label: string;
  icon: string;
};

const LOAD_ITEMS: LoadItem[] = [
  { key: "contracts", label: "สัญญา", icon: "📋" },
  { key: "target", label: "เป้าเก็บหนี้", icon: "🎯" },
  { key: "collected", label: "ยอดเก็บหนี้", icon: "💰" },
];

const CHUNK_SIZE = 500;

export default function DataLoadingScreen() {
  const { isLoading: authLoading, isAuthenticated, can } = useAppAuth();
  const { section } = useSection();
  const debtCache = useDebtCache();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();

  // State ของแต่ละ item
  const [statuses, setStatuses] = useState<Record<LoadItem["key"], ItemStatus>>({
    contracts: "idle",
    target: "idle",
    collected: "idle",
  });
  const [loaded, setLoaded] = useState<Record<LoadItem["key"], number>>({
    contracts: 0,
    target: 0,
    collected: 0,
  });
  const [total, setTotal] = useState<Record<LoadItem["key"], number>>({
    contracts: 0,
    target: 0,
    collected: 0,
  });
  const [errors, setErrors] = useState<Record<LoadItem["key"], string | null>>({
    contracts: null,
    target: null,
    collected: null,
  });

  const startedRef = useRef(false);

  const accent = section ? BRAND_ACCENT[section as SectionKey] : "#1e40af";

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const setStatus = useCallback((key: LoadItem["key"], status: ItemStatus) => {
    setStatuses((prev) => ({ ...prev, [key]: status }));
  }, []);

  const setItemLoaded = useCallback((key: LoadItem["key"], n: number) => {
    setLoaded((prev) => ({ ...prev, [key]: n }));
  }, []);

  const setItemTotal = useCallback((key: LoadItem["key"], n: number) => {
    setTotal((prev) => ({ ...prev, [key]: n }));
  }, []);

  const setItemError = useCallback((key: LoadItem["key"], msg: string | null) => {
    setErrors((prev) => ({ ...prev, [key]: msg }));
  }, []);

  // ─── Fetch contracts ──────────────────────────────────────────────────────

  const fetchContracts = useCallback(async (sec: SectionKey) => {
    setStatus("contracts", "loading");
    setItemLoaded("contracts", 0);
    setItemTotal("contracts", 0);
    try {
      const data = await utils.contracts.listAll.fetch({ section: sec });
      setItemTotal("contracts", data.length);
      setItemLoaded("contracts", data.length);
      setStatus("contracts", "done");
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "เกิดข้อผิดพลาด";
      setItemError("contracts", msg);
      setStatus("contracts", "error");
    }
  }, [utils, setStatus, setItemLoaded, setItemTotal, setItemError]);

  // ─── Fetch debt chunk with retry ──────────────────────────────────────────

  const fetchChunkWithRetry = useCallback(async (
    sec: SectionKey,
    t: "target" | "collected",
    offset: number,
    limit: number,
    maxRetries = 3,
  ) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (t === "target") {
          return await utils.debt.getTargetChunk.fetch({ section: sec, offset, limit });
        } else {
          return await utils.debt.getCollectedChunk.fetch({ section: sec, offset, limit });
        }
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastErr;
  }, [utils]);

  // ─── Fetch debt stream ────────────────────────────────────────────────────

  const fetchDebt = useCallback(async (sec: SectionKey, t: "target" | "collected") => {
    const key = t;
    setStatus(key, "loading");
    setItemLoaded(key, 0);
    setItemTotal(key, 0);
    debtCache.setLoadingState(sec, t, { loading: true, progress: 0, total: 0, error: null });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = [];
      let hasPrincipalBreakdown = true;
      let offset = 0;
      let totalContracts = 0;
      while (true) {
        const result = await fetchChunkWithRetry(sec, t, offset, CHUNK_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkRows = result.rows as any[];
        totalContracts = result.totalContracts;
        const hasMore = result.hasMore;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (t === "collected" && (result as any).hasPrincipalBreakdown === false) {
          hasPrincipalBreakdown = false;
        }
        rows.push(...chunkRows);
        offset += CHUNK_SIZE;
        setItemTotal(key, totalContracts);
        setItemLoaded(key, rows.length);
        debtCache.setLoadingState(sec, t, { progress: rows.length, total: totalContracts });
        if (!hasMore) break;
      }
      // บันทึกลง Global Cache
      if (t === "target") {
        debtCache.setTargetRows(sec, rows);
      } else {
        debtCache.setCollectedRows(sec, rows, hasPrincipalBreakdown);
      }
      debtCache.setLoadingState(sec, t, { loading: false });
      setStatus(key, "done");
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "เกิดข้อผิดพลาด";
      setItemError(key, msg);
      debtCache.setLoadingState(sec, t, { loading: false, error: msg });
      setStatus(key, "error");
    }
  }, [fetchChunkWithRetry, debtCache, setStatus, setItemLoaded, setItemTotal, setItemError]);

  // ─── Main preload logic ───────────────────────────────────────────────────

  const startPreload = useCallback(async (sec: SectionKey) => {
    if (startedRef.current) return;
    startedRef.current = true;

    // โหลดทีละแถบ (sequential) เพื่อลด load บน server และป้องกัน race condition
    // 1) สัญญา
    await fetchContracts(sec);
    // 2) เป้าเก็บหนี้
    await fetchDebt(sec, "target");
    // 3) ยอดเก็บหนี้
    await fetchDebt(sec, "collected");
  }, [fetchContracts, fetchDebt]);

  // ─── Effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (authLoading || !isAuthenticated || !section) return;

    // ตรวจสอบว่า cache มีข้อมูลอยู่แล้วหรือไม่
    const cache = debtCache.getCache(section as SectionKey);
    if (cache.target && cache.collected) {
      // มีข้อมูลแล้ว → ข้ามไป /contracts ทันที
      navigate("/contracts", { replace: true });
      return;
    }

    startPreload(section as SectionKey);
  }, [authLoading, isAuthenticated, section]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Navigate เมื่อโหลดเสร็จ ──────────────────────────────────────────────
  // รอให้ครบทั้ง 3 ส่วนเป็น "done" เท่านั้น (ไม่ข้ามเมื่อ error)

  useEffect(() => {
    const allDone = LOAD_ITEMS.every(
      (item) => statuses[item.key] === "done",
    );
    if (allDone && startedRef.current) {
      // รอ 800ms เพื่อให้ผู้ใช้เห็น checkmark ก่อน navigate
      const timer = setTimeout(() => {
        navigate("/contracts", { replace: true });
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [statuses, navigate]);

  // ─── Auth guard ───────────────────────────────────────────────────────────

  if (authLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!section) {
    navigate("/select-section", { replace: true });
    return null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const allDone = LOAD_ITEMS.every(
    (item) => statuses[item.key] === "done",
  );
  const hasError = LOAD_ITEMS.some((item) => statuses[item.key] === "error");

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <img
            src={BRAND_LOGOS[section as SectionKey]}
            alt={section}
            className="w-20 h-20 mx-auto rounded-2xl object-contain bg-white border border-gray-100 shadow-sm mb-4"
          />
          <h1 className="text-xl font-bold text-gray-900">กำลังโหลดข้อมูล</h1>
          <p className="text-sm text-gray-500 mt-1">
            {section} — กรุณารอสักครู่...
          </p>
        </div>

        {/* Progress items */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
          {LOAD_ITEMS.map((item) => {
            const status = statuses[item.key];
            const loadedN = loaded[item.key];
            const totalN = total[item.key];
            const pct = totalN > 0 ? Math.min(100, Math.round((loadedN / totalN) * 100)) : 0;
            const err = errors[item.key];

            return (
              <div key={item.key}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{item.icon}</span>
                    <span className="text-sm font-medium text-gray-700">{item.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {status === "idle" && (
                      <span className="text-xs text-gray-400">รอดำเนินการ</span>
                    )}
                    {status === "loading" && (
                      <>
                        <span className="text-xs text-gray-500">
                          {totalN > 0 ? `${loadedN.toLocaleString()} / ${totalN.toLocaleString()}` : "กำลังโหลด..."}
                        </span>
                        <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                      </>
                    )}
                    {status === "done" && (
                      <>
                        <span className="text-xs text-green-600">{totalN.toLocaleString()} รายการ</span>
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      </>
                    )}
                    {status === "error" && (
                      <>
                        <span className="text-xs text-red-500 max-w-[140px] truncate" title={err ?? ""}>
                          {err ?? "เกิดข้อผิดพลาด"}
                        </span>
                        <AlertCircle className="w-4 h-4 text-red-500" />
                      </>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  {status === "idle" && (
                    <div className="h-full w-0 rounded-full" />
                  )}
                  {status === "loading" && (
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: totalN > 0 ? `${pct}%` : "30%",
                        background: accent,
                        // indeterminate animation เมื่อยังไม่รู้ total
                        animation: totalN === 0 ? "pulse 1.5s ease-in-out infinite" : undefined,
                      }}
                    />
                  )}
                  {status === "done" && (
                    <div
                      className="h-full w-full rounded-full"
                      style={{ background: "#22c55e" }}
                    />
                  )}
                  {status === "error" && (
                    <div className="h-full w-full rounded-full bg-red-400" />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="text-center mt-6">
          {allDone ? (
            <p className="text-sm text-green-600 font-medium">โหลดข้อมูลเสร็จสิ้น กำลังเข้าสู่ระบบ...</p>
          ) : hasError ? (
            <div className="space-y-3">
              <p className="text-sm text-red-500">เกิดข้อผิดพลาดระหว่างโหลดข้อมูล</p>
              <button
                onClick={() => {
                  startedRef.current = false;
                  setStatuses({ contracts: "idle", target: "idle", collected: "idle" });
                  setLoaded({ contracts: 0, target: 0, collected: 0 });
                  setTotal({ contracts: 0, target: 0, collected: 0 });
                  setErrors({ contracts: null, target: null, collected: null });
                  if (section) startPreload(section as SectionKey);
                }}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg"
                style={{ background: accent }}
              >
                ลองใหม่อีกครั้ง
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400">ข้อมูลจะถูกเก็บ cache ไว้ตลอด session</p>
          )}
        </div>
      </div>
    </div>
  );
}

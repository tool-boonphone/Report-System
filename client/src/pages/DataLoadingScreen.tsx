/**
 * DataLoadingScreen — หน้าโหลดข้อมูล 3 ส่วนก่อนเข้าใช้งานระบบ
 *
 * Flow:
 *  SelectSection → navigate("/data-loading") → DataLoadingScreen
 *
 *  1. ตรวจสอบว่า sync กำลังทำงานอยู่ไหม (trpc.sync.status)
 *     - ถ้า sync กำลังทำงาน → แสดงหน้า "ระบบกำลังอัพเดทข้อมูล" พร้อม progress bar
 *       รอจนกว่า sync เสร็จ แล้วค่อยเข้าหน้าโหลด 3 แถบ
 *     - ถ้า sync ไม่ได้ทำงาน → เข้าหน้าโหลด 3 แถบทันที
 *
 *  2. โหลด contracts + debt target + debt collected พร้อมกัน
 *     → เมื่อครบทั้ง 3 → navigate("/contracts")
 */

import { BRAND_ACCENT, BRAND_LOGOS_SQUARE } from "@/config/brand";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { popReturnPath } from "@/components/AppShell";
import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import type { SectionKey } from "@shared/const";
import { CheckCircle2, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readIdbCache, writeIdbCache } from "@/lib/debtIdbCache";
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

const CHUNK_SIZE = 1000;

/** ชื่อ stage ที่แสดงผลในภาษาไทย */
const STAGE_LABELS: Record<string, string> = {
  partners: "ดึงข้อมูลพาร์ทเนอร์",
  customers: "ดึงข้อมูลลูกค้า",
  contracts: "ดึงข้อมูลสัญญา",
  installments: "ดึงข้อมูลงวดผ่อน",
  payments: "ดึงข้อมูลการชำระ",
  populate_target: "ประมวลผลเป้าเก็บหนี้",
  populate_collected: "ประมวลผลยอดเก็บหนี้",
  finishing: "กำลังเสร็จสิ้น",
};

// ─── SyncWaitingScreen ────────────────────────────────────────────────────────

function SyncWaitingScreen({
  section,
  accent,
  onSyncDone,
}: {
  section: SectionKey;
  accent: string;
  onSyncDone: () => void;
}) {
  const syncStatus = trpc.sync.status.useQuery(undefined, {
    refetchInterval: 3000, // poll ทุก 3 วินาที
  });

  const cancelSync = trpc.sync.cancel.useMutation({
    onSuccess: () => {
      // หลัง cancel สำเร็จ รอ 1 วินาทีแล้ว trigger onSyncDone
      setTimeout(() => onSyncDone(), 1000);
    },
  });

  const [showConfirm, setShowConfirm] = useState(false);

  const handleCancelConfirm = () => {
    cancelSync.mutate({ section });
    setShowConfirm(false);
  };

  const info = syncStatus.data?.[section];
  const isRunning = info?.running ?? true;
  const progress = info?.progress ?? 0;
  const currentStage = info?.currentStage ?? "";
  const stageIndex = info?.stageIndex ?? 0;
  const totalStages = info?.totalStages ?? 5;
  const startedAt = info?.startedAt ? new Date(info.startedAt) : null;

  // คำนวณเวลาที่ใช้ไป
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const update = () => setElapsed(Math.floor((Date.now() - startedAt.getTime()) / 1000));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  // เมื่อ sync เสร็จ → แจ้ง parent
  const prevRunning = useRef(true);
  useEffect(() => {
    if (prevRunning.current && !isRunning && syncStatus.data) {
      // sync เพิ่งเสร็จ
      onSyncDone();
    }
    prevRunning.current = isRunning;
  }, [isRunning, syncStatus.data, onSyncDone]);

  const formatElapsed = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m === 0) return `${s} วินาที`;
    return `${m} นาที ${s} วินาที`;
  };

  const stageLabel = STAGE_LABELS[currentStage] ?? currentStage ?? "กำลังประมวลผล";

  return (
    <div className="w-full max-w-md">
      {/* Header */}
      <div className="text-center mb-8">
        <div
          className="w-20 h-20 mx-auto rounded-2xl flex items-center justify-center mb-4 shadow-sm"
          style={{ background: `${accent}18` }}
        >
          <RefreshCw
            className="w-10 h-10 animate-spin"
            style={{ color: accent, animationDuration: "2s" }}
          />
        </div>
        <h1 className="text-xl font-bold text-gray-900">ระบบกำลังอัพเดทข้อมูล</h1>
        <p className="text-sm text-gray-500 mt-1">
          {section} — กรุณารอสักครู่...
        </p>
      </div>

      {/* Progress card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        {/* Overall progress bar */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">ความคืบหน้าโดยรวม</span>
            <span className="text-sm font-bold" style={{ color: accent }}>{progress}%</span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${progress}%`, background: accent }}
            />
          </div>
        </div>

        {/* Stage dots */}
        <div className="flex items-center justify-between mb-5">
          {Array.from({ length: totalStages }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <div
                className="w-3 h-3 rounded-full transition-all duration-300"
                style={{
                  background: i < stageIndex ? "#22c55e" : i === stageIndex ? accent : "#e5e7eb",
                  transform: i === stageIndex ? "scale(1.3)" : "scale(1)",
                }}
              />
            </div>
          ))}
        </div>

        {/* Current stage */}
        <div className="flex items-center gap-2 p-3 rounded-xl" style={{ background: `${accent}10` }}>
          <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: accent }} />
          <div>
            <p className="text-sm font-medium" style={{ color: accent }}>{stageLabel}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              ขั้นตอนที่ {Math.max(1, stageIndex + 1)} จาก {totalStages}
            </p>
          </div>
        </div>

        {/* Elapsed time */}
        {startedAt && (
          <p className="text-xs text-gray-400 text-center mt-4">
            ใช้เวลาไปแล้ว {formatElapsed(elapsed)}
          </p>
        )}
      </div>

      {/* Cancel button */}
      <div className="text-center mt-4">
        {!showConfirm ? (
          <button
            onClick={() => setShowConfirm(true)}
            className="text-sm text-gray-400 hover:text-red-500 transition-colors underline underline-offset-2"
          >
            ยกเลิกการอัพเดท
          </button>
        ) : (
          <div className="bg-white rounded-xl border border-red-100 p-4 shadow-sm">
            <p className="text-sm font-medium text-gray-700 mb-3">ยืนยันการยกเลิก?</p>
            <p className="text-xs text-gray-500 mb-4">ข้อมูลที่ sync ไปแล้วจะถูกเก็บไว้ แต่ข้อมูลที่ยังไม่ได้ sync จะไม่ครบถ้วน</p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                ไม่ยกเลิก
              </button>
              <button
                onClick={handleCancelConfirm}
                disabled={cancelSync.isPending}
                className="px-4 py-1.5 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
              >
                {cancelSync.isPending ? "กำลังยกเลิก..." : "ยืนยันยกเลิก"}
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 text-center mt-3">
        ระบบจะเข้าสู่หน้าโหลดข้อมูลอัตโนมัติเมื่ออัพเดทเสร็จสิ้น
      </p>
    </div>
  );
}

// ─── DataLoadingScreen ────────────────────────────────────────────────────────


export default function DataLoadingScreen() {
  const { isLoading: authLoading, isAuthenticated } = useAppAuth();
  const { section } = useSection();
  const debtCache = useDebtCache();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();

  // ─── Phase: "checking" → "syncing" → "loading" ───────────────────────────
  type Phase = "checking" | "syncing" | "loading";
  const [phase, setPhase] = useState<Phase>("checking");

  // ─── State ของแต่ละ item (ใช้ใน phase "loading") ─────────────────────────
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
  const idbCheckedRef = useRef(false);
  const accent = section ? BRAND_ACCENT[section as SectionKey] : "#1e40af";

  // ─── ตรวจสอบ sync status ครั้งแรก ────────────────────────────────────────
  const [checkingElapsed, setCheckingElapsed] = useState(0);
  const syncStatusQuery = trpc.sync.status.useQuery(undefined, {
    enabled: phase === "checking" && !!section && !authLoading && isAuthenticated,
    refetchOnWindowFocus: false,
  });

  // นับเวลาที่ค้างอยู่ใน phase "checking"
  useEffect(() => {
    if (phase !== "checking") return;
    const t = setInterval(() => setCheckingElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Auto-skip เมื่อ sync status ไม่ตอบกลับนานเกิน 15 วินาที
  useEffect(() => {
    if (phase !== "checking") return;
    if (checkingElapsed >= 15) {
      console.warn("[DataLoadingScreen] sync.status timeout — skipping to loading phase");
      setPhase("loading");
    }
  }, [checkingElapsed, phase]);

  useEffect(() => {
    if (phase !== "checking") return;
    if (!syncStatusQuery.data || !section) return;

    const info = syncStatusQuery.data[section as SectionKey];
    if (info?.running) {
      // sync กำลังทำงาน → แสดงหน้า syncing
      setPhase("syncing");
    } else {
      // sync ไม่ได้ทำงาน → เข้าหน้าโหลดทันที
      setPhase("loading");
    }
  }, [syncStatusQuery.data, section, phase]);

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

  // ─── Fetch contracts (chunked with progress) ────────────────────────────

  const fetchContracts = useCallback(async (sec: SectionKey) => {
    setStatus("contracts", "loading");
    setItemLoaded("contracts", 0);
    setItemTotal("contracts", 0);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allRows: any[] = [];
      let offset = 0;
      const CONTRACTS_CHUNK = 2000;
      while (true) {
        const result = await utils.contracts.listChunk.fetch({
          section: sec,
          offset,
          limit: CONTRACTS_CHUNK,
        });
        allRows.push(...result.rows);
        setItemTotal("contracts", result.total);
        setItemLoaded("contracts", allRows.length);
        if (!result.hasMore) break;
        offset += CONTRACTS_CHUNK;
      }
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
    maxRetries = 8,
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
        const errMsg = (err as Error)?.message ?? "";
        // "Failed to fetch" = transient network/connection-pool error → retry ทันที (short delay)
        // Other errors (timeout, server error) → exponential backoff
        const isTransient = errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError");
        if (attempt < maxRetries - 1) {
          const delay = isTransient
            ? 500 + attempt * 300          // 500ms, 800ms, 1.1s, ... (เร็ว)
            : 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, ... (ช้า)
          await new Promise((r) => setTimeout(r, delay));
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
    await fetchContracts(sec);
    await fetchDebt(sec, "target");
    await fetchDebt(sec, "collected");
    // บันทึกลง IndexedDB หลังโหลดครบทั้งหมด
    const cache = debtCache.getCache(sec);
    if (cache.target && cache.collected) {
      writeIdbCache({
        section: sec,
        savedAt: Date.now(),
        targetRows: cache.target.rows,
        collectedRows: cache.collected.rows,
        hasPrincipalBreakdown: cache.collected.hasPrincipalBreakdown,
      }).catch(() => { /* silent fail */ });
    }
  }, [fetchContracts, fetchDebt, debtCache]);

  // ─── เริ่มโหลดเมื่อ phase เปลี่ยนเป็น "loading" ──────────────────────────

  useEffect(() => {
    if (phase !== "loading") return;
    if (authLoading || !isAuthenticated || !section) return;

    // ตรวจสอบว่า memory cache มีข้อมูลอยู่แล้วหรือไม่
    const memCache = debtCache.getCache(section as SectionKey);
    if (memCache.target && memCache.collected) {        navigate(popReturnPath() ?? "/contracts", { replace: true });
      return;
    }
    // ป้องกัน IDB check ซ้ำ
    if (idbCheckedRef.current) return;
    idbCheckedRef.current = true;

    // ตรวจสอบ IndexedDB cache ก่อนโหลดจาก API
    readIdbCache(section as SectionKey).then((idbEntry) => {
      if (idbEntry) {
        // มี IDB cache ที่ยังไม่หมดอายุ → restore เข้า memory แล้วไปหน้า contracts ทันที
        debtCache.setTargetRows(section as SectionKey, idbEntry.targetRows);
        debtCache.setCollectedRows(section as SectionKey, idbEntry.collectedRows, idbEntry.hasPrincipalBreakdown);
        navigate(popReturnPath() ?? "/contracts", { replace: true });
      } else {
        // ไม่มี IDB cache → โหลดจาก API ตามปกติ
        startPreload(section as SectionKey);
      }
    }).catch(() => {
      startPreload(section as SectionKey);
    });
  }, [phase, authLoading, isAuthenticated, section]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Navigate เมื่อโหลดเสร็จ ──────────────────────────────────────────────

  useEffect(() => {
    if (phase !== "loading") return;
    const allDone = LOAD_ITEMS.every((item) => statuses[item.key] === "done");
    if (allDone && startedRef.current) {
      const timer = setTimeout(() => {
        navigate(popReturnPath() ?? "/contracts", { replace: true });
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [statuses, navigate, phase]);

  // ─── Auth guard ───────────────────────────────────────────────────────────

  // ถ้าเริ่มโหลดแล้ว (startedRef.current) ไม่ redirect ไป login
  // เพราะ auth.me อาจ refetch ระหว่างโหลดข้อมูล Fastfone ที่ใช้เวลานาน
  if (!startedRef.current && (authLoading || !isAuthenticated)) {
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

  const allDone = LOAD_ITEMS.every((item) => statuses[item.key] === "done");
  const hasError = LOAD_ITEMS.some((item) => statuses[item.key] === "error");

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center px-4">

      {/* Phase: checking — spinner ก่อนรู้ว่า sync ทำงานอยู่ไหม */}
      {phase === "checking" && (
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 animate-spin" style={{ color: accent }} />
          <p className="text-sm text-gray-500">กำลังตรวจสอบสถานะระบบ...</p>
          {checkingElapsed >= 10 && (
            <div className="flex flex-col items-center gap-2 mt-2">
              <p className="text-xs text-gray-400">ใช้เวลานานกว่าปกติ ({checkingElapsed}s)</p>
              <button
                onClick={() => setPhase("loading")}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                ข้ามการตรวจสอบและโหลดข้อมูลเลย
              </button>
            </div>
          )}
        </div>
      )}

      {/* Phase: syncing — รอ background sync เสร็จ */}
      {phase === "syncing" && (
        <SyncWaitingScreen
          section={section as SectionKey}
          accent={accent}
          onSyncDone={() => {
            // reset state แล้วเข้าหน้าโหลด
            startedRef.current = false;
            setStatuses({ contracts: "idle", target: "idle", collected: "idle" });
            setLoaded({ contracts: 0, target: 0, collected: 0 });
            setTotal({ contracts: 0, target: 0, collected: 0 });
            setErrors({ contracts: null, target: null, collected: null });
            setPhase("loading");
          }}
        />
      )}

      {/* Phase: loading — โหลด 3 แถบตามปกติ */}
      {phase === "loading" && (
        <div className="w-full max-w-md">
          {/* Header */}
          <div className="text-center mb-8">
            <img
              src={BRAND_LOGOS_SQUARE[section as SectionKey]}
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
                    {status === "idle" && <div className="h-full w-0 rounded-full" />}
                    {status === "loading" && (
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: totalN > 0 ? `${pct}%` : "30%",
                          background: accent,
                          animation: totalN === 0 ? "pulse 1.5s ease-in-out infinite" : undefined,
                        }}
                      />
                    )}
                    {status === "done" && (
                      <div className="h-full w-full rounded-full" style={{ background: "#22c55e" }} />
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
      )}
    </div>
  );
}

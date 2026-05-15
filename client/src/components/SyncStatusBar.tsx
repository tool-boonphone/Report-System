import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Progress } from "@/components/ui/progress";
import { clearIdbCache } from "@/lib/debtIdbCache";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useIncomeCache } from "@/contexts/IncomeCacheContext";
import type { SectionKey } from "@shared/const";
import { useAppAuth } from "@/hooks/useAppAuth";
import { RefreshCw, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

/**
 * Injected into TopNav actions. Shows:
 *  - "ข้อมูล ณ <date>"
 *  - ปุ่ม "Re-Sync API" — ดึงข้อมูลจาก API ภายนอกมาบันทึกลง DB ใหม่
 *  - ปุ่ม "Clear Cache" — ล้าง IndexedDB ใน browser แล้ว redirect ไปหน้า data-loading
 *
 * While a sync is running:
 *  - Hides both buttons
 *  - Shows a progress bar with % complete + elapsed/ETA
 *
 * Uses polling (trpc.sync.status) to track progress.
 * Sync is triggered via fire-and-forget tRPC mutation (returns immediately).
 * Cloud Run keeps the sync process alive as long as the scheduler is running.
 */

/** Format seconds into "Xm Ys" or "Xs" */
function formatSecs(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Stage labels in Thai */
const STAGE_LABELS: Record<string, string> = {
  partners: "ดึงข้อมูลตัวแทน",
  customers: "ดึงข้อมูลลูกค้า",
  contracts: "ดึงข้อมูลสัญญา",
  installments: "ดึงข้อมูลงวด",
  payments: "ดึงข้อมูลการชำระ",
  finishing: "กำลังบันทึก",
  เริ่มต้น: "กำลังเริ่มต้น",
};

export function SyncStatusBar() {
  const { section } = useSection();
  const utils = trpc.useUtils();
  const debtCache = useDebtCache();
  const incomeCache = useIncomeCache();
  const [, navigate] = useLocation();
  const [isClearing, setIsClearing] = useState(false);
  const { can } = useAppAuth();
  const canResync = can("sync_api", "sync");

  // Last synced time for the active section.
  const last = trpc.sync.lastSyncedAt.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section, refetchOnWindowFocus: true },
  );

  // Poll sync status from DB — fast poll when running, stop when idle.
  const status = trpc.sync.status.useQuery(undefined, {
    refetchInterval: (q) => {
      const d = q.state.data as any;
      if (!d) return 3000;
      const s = section ?? "Boonphone";
      return d?.[s]?.running ? 2000 : false;
    },
  });

  const sectionData = section ? (status.data as any)?.[section] : null;
  const isRunning = Boolean(sectionData?.running);

  // Elapsed timer — ticks every second while running
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // SSE stream ref — keeps Cloud Run alive during sync
  const sseRef = useRef<EventSource | null>(null);

  const progress: number = sectionData?.progress ?? 0;
  const currentStage: string = sectionData?.currentStage ?? "";
  const startedAt: number | null = sectionData?.startedAt ?? null;

  // Parse sub-progress from stage string e.g. "customers (3/10)"
  const stageMatch = currentStage.match(/^(\w+)\s*\((\d+)\/(\d+)\)$/);
  const baseStage = stageMatch ? stageMatch[1] : currentStage;
  const stageLabel = STAGE_LABELS[baseStage] ?? baseStage;
  const subProgress = stageMatch ? `(${stageMatch[2]}/${stageMatch[3]})` : "";

  // Elapsed seconds
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const elapsedSecs = elapsedMs / 1000;

  // ETA: elapsed / progress * (100 - progress)
  const etaSecs =
    progress > 0 && progress < 100
      ? (elapsedSecs / progress) * (100 - progress)
      : null;

  // Trigger via SSE stream — keeps Render/Cloud Run alive during sync
  // ใช้ EventSource ตัวเดียว (ไม่ต้อง probe แยก) เพราะ server ส่ง SSE event แทน HTTP status codes
  const triggerSSE = useCallback(
    (sec: string, onDone: () => void) => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }

      // เปิด EventSource ตรงๆ — server จะส่ง event แรกบอกสถานะ
      // (started / already_running / error)
      const es = new EventSource(`/api/sync-stream/${sec}`, { withCredentials: true });
      sseRef.current = es;

      // Timeout กรณี server ไม่ส่ง event ใดๆ ภายใน 30 วินาที
      const connectTimeout = setTimeout(() => {
        toast.error("Server ไม่ตอบสนอง กรุณาลองใหม่");
        onDone();
        es.close();
        sseRef.current = null;
      }, 30000);

      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          // ยกเลิก connect timeout เมื่อได้รับ event แรก
          clearTimeout(connectTimeout);

          if (msg.type === "started") {
            toast.info(`เริ่ม Re-Sync ${sec}...`);
            onDone(); // ปุ่มกลับมา enable เมื่อ sync เริ่มแล้ว (progress bar จะแสดงแทน)
            utils.sync.status.invalidate();
          } else if (msg.type === "already_running") {
            toast.info(`Sync ${sec} กำลังทำงานอยู่แล้ว`);
            onDone();
            utils.sync.status.invalidate();
            es.close();
            sseRef.current = null;
          } else if (msg.type === "done") {
            toast.success(`Re-Sync ${sec} สำเร็จ (${msg.rowCount ?? 0} rows)`);
            onDone();
            utils.sync.status.invalidate();
            utils.sync.lastSyncedAt.invalidate();
            if (section) incomeCache.invalidateIncomeCache(section as SectionKey);
            es.close();
            sseRef.current = null;
          } else if (msg.type === "error") {
            toast.error(`Sync ${sec} ล้มเหลว: ${msg.message}`);
            onDone();
            utils.sync.status.invalidate();
            es.close();
            sseRef.current = null;
          } else if (msg.type === "progress" || msg.type === "heartbeat") {
            utils.sync.status.invalidate();
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        clearTimeout(connectTimeout);
        // SSE connection error (network drop, server restart, 401/403)
        onDone();
        utils.sync.status.invalidate();
        setTimeout(() => {
          const d = (status.data as any)?.[sec];
          if (!d?.running) {
            toast.error("ไม่สามารถเชื่อมต่อ Re-Sync ได้ กรุณาลองใหม่");
          }
        }, 3000);
        es.close();
        sseRef.current = null;
      };
    },
    [utils, section, status.data, incomeCache],
  );

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, []);

  // Force-clear stuck sync mutation
  const clearStuck = trpc.sync.clearStuck.useMutation({
    onSuccess: (data) => {
      toast.success(`ล้าง sync ที่ค้างแล้ว (${data.cleared} รายการ) — สามารถ Re-Sync ใหม่ได้`);
      utils.sync.status.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const [isTriggerPending, setIsTriggerPending] = useState(false);

  const handleResync = useCallback(() => {
    if (!section || isRunning || isTriggerPending) return;
    setIsTriggerPending(true);
    // isTriggerPending จะ reset เมื่อ SSE ตอบกลับ (started/error) ผ่าน onDone callback
    // มี fallback timeout 15 วินาที กันกรณีที่ไม่มี response ใดๆ เลย
    const fallbackTimer = setTimeout(() => setIsTriggerPending(false), 15000);
    triggerSSE(section, () => {
      clearTimeout(fallbackTimer);
      setIsTriggerPending(false);
    });
  }, [section, isRunning, isTriggerPending, triggerSSE]);

  // Clear Cache handler
  const handleClearCache = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      await clearIdbCache();
      debtCache.clearAll();
      incomeCache.clearAll();
      toast.info("ล้างแคชเรียบร้อย — กำลังโหลดข้อมูลใหม่...");
      navigate("/data-loading", { replace: true });
    } catch {
      toast.error("ล้างแคชไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setIsClearing(false);
    }
  };

  if (!section) return null;

  const lastLabel = last.data?.lastSyncedAt
    ? new Date(last.data.lastSyncedAt as any).toLocaleString("th-TH", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "ยังไม่เคย Sync";

  return (
    <div className="flex items-center gap-2">
      {/* ข้อมูล ณ วันที่ */}
      <span className="hidden sm:inline text-xs text-gray-500 whitespace-nowrap">
        ข้อมูล ณ {lastLabel}
      </span>

      {isRunning && canResync ? (
        /* ---- Progress bar (แสดงแทนปุ่มขณะ Sync กำลังทำงาน) ---- */
        <div className="flex items-center gap-2">
          <div className="min-w-[180px] max-w-[260px]">
            {/* Stage label + sub-progress + % */}
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs text-blue-600 font-medium truncate">
                {stageLabel || "กำลัง Sync..."}
                {subProgress && (
                  <span className="ml-1 text-blue-400">{subProgress}</span>
                )}
              </span>
              <span className="text-xs text-blue-600 font-semibold ml-1 shrink-0">
                {progress}%
              </span>
            </div>
            {/* Progress bar */}
            <Progress value={progress} className="h-1.5" />
            {/* Elapsed + ETA */}
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[10px] text-gray-400">
                ใช้ไป {formatSecs(elapsedSecs)}
              </span>
              {etaSecs !== null && (
                <span className="text-[10px] text-gray-400">
                  เหลือ ~{formatSecs(etaSecs)}
                </span>
              )}
            </div>
          </div>
          {/* Force Clear — แสดงเมื่อ sync ค้างนานกว่า 10 นาที */}
          {elapsedSecs > 600 && (
            <button
              onClick={() => clearStuck.mutate({ section })}
              disabled={clearStuck.isPending}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-red-200 hover:bg-red-50 text-xs text-red-600 disabled:opacity-50 transition-colors shrink-0"
              title="ยกเลิก sync ที่ค้างอยู่ เพื่อให้สามารถ Re-Sync ใหม่ได้"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">ยกเลิก</span>
            </button>
          )}
        </div>
      ) : canResync ? (
        /* ---- ปุ่ม Re-Sync API + Clear Cache (เฉพาะผู้มีสิทธิ์) ---- */
        <div className="flex items-center gap-1.5">
          {/* Re-Sync API */}
          <button
            onClick={handleResync}
            disabled={isRunning || isClearing || isTriggerPending}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50 transition-colors"
            title="ดึงข้อมูลใหม่จาก API ภายนอก (ใช้เวลาหลายนาที)"
          >
            <RefreshCw className={`w-4 h-4 ${isTriggerPending ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Re-Sync API</span>
          </button>

          {/* Clear Cache */}
          <button
            onClick={handleClearCache}
            disabled={isRunning || isClearing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-orange-200 hover:bg-orange-50 text-sm text-orange-600 disabled:opacity-50 transition-colors"
            title="ล้างข้อมูลที่บันทึกไว้ในเบราเซอร์ แล้วโหลดข้อมูลใหม่จากระบบ"
          >
            <Trash2
              className={`w-4 h-4 ${isClearing ? "animate-pulse" : ""}`}
            />
            <span className="hidden sm:inline">Clear Cache</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

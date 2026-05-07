import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Progress } from "@/components/ui/progress";
import { clearIdbCache } from "@/lib/debtIdbCache";
import { useDebtCache } from "@/contexts/DebtCacheContext";
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
 * Uses SSE (/api/sync-stream/:section) to keep Cloud Run connection alive
 * during sync. Falls back to polling sync.status for externally-triggered syncs.
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
  const [, navigate] = useLocation();
  const [isClearing, setIsClearing] = useState(false);
  const { can } = useAppAuth();
  const canResync = can("sync_api", "sync");

  // SSE-driven sync state (set when user manually triggers sync via this component)
  const [sseRunning, setSseRunning] = useState(false);
  const [sseProgress, setSseProgress] = useState(0);
  const [sseStage, setSseStage] = useState("");
  const [sseStartedAt, setSseStartedAt] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Last synced time for the active section.
  const last = trpc.sync.lastSyncedAt.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section, refetchOnWindowFocus: true },
  );

  // Running status — poll DB to detect externally-triggered syncs (auto-sync, other users).
  // Only poll when SSE is NOT active (to avoid double-counting).
  const status = trpc.sync.status.useQuery(undefined, {
    refetchInterval: (q) => {
      if (sseRunning) return false; // SSE is driving progress — no need to poll
      const d = q.state.data as any;
      if (!d) return false;
      const s = section ?? "Boonphone";
      return d?.[s]?.running ? 2000 : false;
    },
  });

  const sectionData = section ? (status.data as any)?.[section] : null;
  // isRunning = SSE active OR DB says running (for externally-triggered syncs)
  const isRunning = sseRunning || Boolean(sectionData?.running);

  // Elapsed timer — ticks every second while running
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Determine progress/stage/startedAt from SSE (preferred) or DB polling
  const progress: number = sseRunning ? sseProgress : (sectionData?.progress ?? 0);
  const currentStage: string = sseRunning ? sseStage : (sectionData?.currentStage ?? "");
  const startedAt: number | null = sseRunning ? sseStartedAt : (sectionData?.startedAt ?? null);
  const stageLabel = STAGE_LABELS[currentStage] ?? currentStage;

  // Elapsed seconds
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const elapsedSecs = elapsedMs / 1000;

  // ETA: elapsed / progress * (100 - progress)
  const etaSecs =
    progress > 0 && progress < 100
      ? (elapsedSecs / progress) * (100 - progress)
      : null;

  // Cleanup SSE on unmount or section change
  useEffect(() => {
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [section]);

  // Force-clear stuck sync mutation
  const clearStuck = trpc.sync.clearStuck.useMutation({
    onSuccess: (data) => {
      toast.success(`ล้าง sync ที่ค้างแล้ว (${data.cleared} รายการ) — สามารถ Re-Sync ใหม่ได้`);
      setSseRunning(false);
      setSseProgress(0);
      setSseStage("");
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      utils.sync.status.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  // Re-Sync via SSE — keeps Cloud Run connection alive during sync
  const handleResync = useCallback(() => {
    if (!section || sseRunning) return;

    // Close any existing SSE connection
    if (esRef.current) { esRef.current.close(); esRef.current = null; }

    setSseRunning(true);
    setSseProgress(0);
    setSseStage("เริ่มต้น");
    setSseStartedAt(Date.now());

    const es = new EventSource(`/api/sync-stream/${encodeURIComponent(section)}`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "progress") {
          setSseProgress(msg.progress ?? 0);
          setSseStage(msg.currentStage ?? "");
        } else if (msg.type === "done") {
          setSseRunning(false);
          setSseProgress(100);
          setSseStage("");
          es.close();
          esRef.current = null;
          toast.success(`Sync ${section} เสร็จสิ้น`);
          utils.sync.lastSyncedAt.invalidate();
          utils.sync.status.invalidate();
        } else if (msg.type === "error") {
          setSseRunning(false);
          setSseStage("");
          es.close();
          esRef.current = null;
          toast.error(`Sync ${section} ล้มเหลว: ${msg.message}`);
          utils.sync.status.invalidate();
        }
        // heartbeat — ignore, just keeps connection alive
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE connection dropped — check if sync is still running via DB
      setSseRunning(false);
      es.close();
      esRef.current = null;
      // Start polling to detect if sync is still running on server
      utils.sync.status.invalidate();
      toast.error("การเชื่อมต่อ Sync ขาดหาย — กำลังตรวจสอบสถานะ...");
    };

    toast.info(`เริ่ม Re-Sync ${section}...`);
  }, [section, sseRunning, utils.sync.lastSyncedAt, utils.sync.status]);

  // Clear Cache handler
  const handleClearCache = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      await clearIdbCache();
      debtCache.clearAll();
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
            {/* Stage label + % */}
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs text-blue-600 font-medium truncate">
                {stageLabel || "กำลัง Sync..."}
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
          {/* Re-Sync API — uses SSE to keep Cloud Run alive */}
          <button
            onClick={handleResync}
            disabled={isRunning || isClearing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50 transition-colors"
            title="ดึงข้อมูลใหม่จาก API ภายนอก (ใช้เวลาหลายนาที)"
          >
            <RefreshCw className="w-4 h-4" />
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

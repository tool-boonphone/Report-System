import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Progress } from "@/components/ui/progress";
import { clearIdbCache } from "@/lib/debtIdbCache";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

  // Last synced time for the active section.
  const last = trpc.sync.lastSyncedAt.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section, refetchOnWindowFocus: true },
  );

  // Running status — short polling while running (2s), off otherwise.
  const status = trpc.sync.status.useQuery(undefined, {
    refetchInterval: (q) => {
      const d = q.state.data as any;
      if (!d) return false;
      const s = section ?? "Boonphone";
      return d?.[s]?.running ? 2000 : false;
    },
  });

  const wasRunning = useRef(false);
  const sectionData = section ? (status.data as any)?.[section] : null;
  const isRunning = Boolean(sectionData?.running);

  // Elapsed timer — ticks every second while running
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Toast on sync completion
  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      toast.success(`Sync ${section} เสร็จสิ้น`);
      utils.sync.lastSyncedAt.invalidate();
    }
    wasRunning.current = isRunning;
  }, [isRunning, section, utils.sync.lastSyncedAt]);

  // Re-Sync API mutation
  const trigger = trpc.sync.trigger.useMutation({
    onSuccess: () => {
      toast.info(`เริ่ม Re-Sync ${section} — ทำงานเบื้องหลัง`);
      utils.sync.status.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  // Clear Cache handler
  const handleClearCache = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      // ล้าง IndexedDB ทั้งหมด
      await clearIdbCache();
      // ล้าง memory cache ด้วย
      debtCache.clearAll();
      toast.info("ล้างแคชเรียบร้อย — กำลังโหลดข้อมูลใหม่...");
      // redirect ไปหน้า data-loading เพื่อโหลดใหม่
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

  // ---- Progress bar data ----
  const progress: number = sectionData?.progress ?? 0;
  const startedAt: number | null = sectionData?.startedAt ?? null;
  const currentStage: string = sectionData?.currentStage ?? "";
  const stageLabel = STAGE_LABELS[currentStage] ?? currentStage;

  // Elapsed seconds
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const elapsedSecs = elapsedMs / 1000;

  // ETA: elapsed / progress * (100 - progress)
  const etaSecs =
    progress > 0 && progress < 100
      ? (elapsedSecs / progress) * (100 - progress)
      : null;

  return (
    <div className="flex items-center gap-2">
      {/* ข้อมูล ณ วันที่ */}
      <span className="hidden sm:inline text-xs text-gray-500 whitespace-nowrap">
        ข้อมูล ณ {lastLabel}
      </span>

      {isRunning && canResync ? (
        /* ---- Progress bar (แสดงแทนปุ่มขณะ Sync กำลังทำงาน) ---- */
        <div className="flex items-center gap-2 min-w-[180px] max-w-[260px]">
          <div className="flex-1 min-w-0">
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
        </div>
      ) : canResync ? (
        /* ---- ปุ่ม Re-Sync API + Clear Cache (เฉพาะผู้มีสิทธิ์) ---- */
        <div className="flex items-center gap-1.5">
          {/* Re-Sync API */}
          <button
            onClick={() => trigger.mutate({ section })}
            disabled={trigger.isPending || isClearing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50 transition-colors"
            title="ดึงข้อมูลใหม่จาก API ภายนอก (ใช้เวลาหลายนาที)"
          >
            <RefreshCw
              className={`w-4 h-4 ${trigger.isPending ? "animate-spin text-blue-600" : ""}`}
            />
            <span className="hidden sm:inline">Re-Sync API</span>
          </button>

          {/* Clear Cache */}
          <button
            onClick={handleClearCache}
            disabled={trigger.isPending || isClearing}
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

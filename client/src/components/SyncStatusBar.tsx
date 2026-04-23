import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Progress } from "@/components/ui/progress";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Injected into TopNav actions. Shows "ข้อมูล ณ <date>" + a Refresh button.
 *
 * While a sync is running:
 *  - Hides the Refresh button
 *  - Shows a progress bar with % complete
 *  - Shows elapsed time and estimated remaining time
 *
 * Polls `sync.status` every 2s while running, 0 otherwise.
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

  const trigger = trpc.sync.trigger.useMutation({
    onSuccess: () => {
      toast.info(`เริ่ม Sync ${section} — ทำงานเบื้องหลัง`);
      utils.sync.status.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

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
      <span className="hidden sm:inline text-xs text-gray-500 whitespace-nowrap">
        ข้อมูล ณ {lastLabel}
      </span>

      {isRunning ? (
        /* ---- Progress bar (replaces Refresh button while running) ---- */
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
      ) : (
        /* ---- Normal Refresh button ---- */
        <button
          onClick={() => trigger.mutate({ section })}
          disabled={trigger.isPending}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50"
          title="Sync ข้อมูลใหม่"
        >
          <RefreshCw
            className={`w-4 h-4 ${trigger.isPending ? "animate-spin text-blue-600" : ""}`}
          />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      )}
    </div>
  );
}

import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Injected into TopNav actions. Shows "ข้อมูล ณ <date>" + a Refresh button.
 * Polls `sync.status` every 5s while a sync is running to auto-dismiss the
 * spinner and show a toast when finished.
 */
export function SyncStatusBar() {
  const { section } = useSection();
  const utils = trpc.useUtils();

  // Last synced time for the active section.
  const last = trpc.sync.lastSyncedAt.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section, refetchOnWindowFocus: true },
  );

  // Running status — short polling while running.
  const status = trpc.sync.status.useQuery(undefined, {
    refetchInterval: (q) => {
      const d = q.state.data as any;
      if (!d) return false;
      const s = section ?? "Boonphone";
      return d?.[s]?.running ? 5000 : false;
    },
  });
  const wasRunning = useRef(false);
  const isRunning = section ? Boolean((status.data as any)?.[section]?.running) : false;

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

  return (
    <div className="flex items-center gap-2">
      <span className="hidden sm:inline text-xs text-gray-500 whitespace-nowrap">
        ข้อมูล ณ {lastLabel}
      </span>
      <button
        onClick={() => trigger.mutate({ section })}
        disabled={isRunning || trigger.isPending}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50"
        title="Sync ข้อมูลใหม่"
      >
        <RefreshCw
          className={`w-4 h-4 ${isRunning ? "animate-spin text-blue-600" : ""}`}
        />
        <span className="hidden sm:inline">{isRunning ? "กำลัง Sync..." : "Refresh"}</span>
      </button>
    </div>
  );
}

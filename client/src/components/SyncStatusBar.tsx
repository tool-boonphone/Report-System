import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Progress } from "@/components/ui/progress";
import { clearIdbCache } from "@/lib/debtIdbCache";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useIncomeCache } from "@/contexts/IncomeCacheContext";
import type { SectionKey } from "@shared/const";
import { useAppAuth } from "@/hooks/useAppAuth";
import { RefreshCw, Trash2, XCircle, Info, CheckCircle2, AlertCircle, Clock, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

/**
 * Injected into TopNav actions. Shows:
 *  - "ข้อมูล ณ <date>" + ไอคอน i สำหรับดู sync log สรุป
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

/** Format duration between two dates */
function formatDuration(start: Date | string | null, end: Date | string | null): string {
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "-";
  return formatSecs(ms / 1000);
}

/** Format date to Thai locale short */
function formatThaiShort(d: Date | string | null): string {
  if (!d) return "-";
  return new Date(d).toLocaleString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Stage labels in Thai */
const STAGE_LABELS: Record<string, string> = {
  partners: "ดึงข้อมูลตัวแทน",
  customers: "ดึงข้อมูลลูกค้า",
  contracts: "ดึงข้อมูลสัญญา",
  imei_enrich: "ดึง IMEI/Serial No",
  installments: "ดึงข้อมูลงวด",
  payments: "ดึงข้อมูลการชำระ",
  commissions: "ดึงข้อมูลค่าคอมมิชชัน",
  bad_debt: "คำนวณหนี้เสีย",
  mdm_online: "อัปเดตสถานะ MDM Online",
  populate: "สร้าง Cache รายงาน",
  finishing: "กำลังบันทึก",
  all: "ภาพรวม",
  เริ่มต้น: "กำลังเริ่มต้น",
};

/** Entity labels in Thai */
const ENTITY_LABELS: Record<string, string> = {
  partners: "ตัวแทน",
  customers: "ลูกค้า",
  contracts: "สัญญา",
  imei_enrich: "IMEI/SN",
  installments: "งวด",
  payments: "การชำระ",
  commissions: "ค่าคอมมิชชัน",
  bad_debt: "หนี้เสีย",
  populate: "Cache",
  all: "ภาพรวม",
};

/** Sync Log Popup Component */
function SyncLogPopup({
  section,
  onClose,
}: {
  section: SectionKey;
  onClose: () => void;
}) {
  const summary = trpc.sync.lastRunSummary.useQuery({ section });

  const data = summary.data;
  const overall = data?.overall;
  const entities = data?.entities ?? [];

  const isSuccess = overall?.status === "success";
  const isError = overall?.status === "error";
  const isInProgress = overall?.status === "in_progress";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end pt-14 pr-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl border border-gray-200 w-80 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800">
            Sync Log — {section}
          </span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            ×
          </button>
        </div>

        {summary.isLoading ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">กำลังโหลด...</div>
        ) : !overall ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">ยังไม่มีข้อมูล Sync</div>
        ) : (
          <div className="px-4 py-3 space-y-3">
            {/* Overall status */}
            <div className="flex items-start gap-2">
              {isSuccess ? (
                <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
              ) : isError ? (
                <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              ) : (
                <Clock className="w-4 h-4 text-blue-500 mt-0.5 shrink-0 animate-pulse" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">
                  {isSuccess ? "สำเร็จ" : isError ? "ล้มเหลว / ไม่สมบูรณ์" : "กำลังทำงาน"}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  เริ่ม: {formatThaiShort(overall.startedAt)}
                </div>
                {overall.finishedAt && (
                  <div className="text-xs text-gray-500">
                    เสร็จ: {formatThaiShort(overall.finishedAt)}
                    {" "}
                    <span className="text-gray-400">
                      ({formatDuration(overall.startedAt, overall.finishedAt)})
                    </span>
                  </div>
                )}
                {overall.rowCount != null && overall.rowCount > 0 && (
                  <div className="text-xs text-gray-500">
                    จำนวน: {overall.rowCount.toLocaleString()} rows
                  </div>
                )}
                {overall.errorMessage && (
                  <div className="text-xs text-red-500 mt-1 break-words">
                    {overall.errorMessage}
                  </div>
                )}
              </div>
            </div>

            {/* Entity breakdown */}
            {entities.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1.5">รายละเอียดแต่ละขั้นตอน</div>
                <div className="space-y-1">
                  {entities.map((e: any) => (
                    <div
                      key={e.id}
                      className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-gray-50"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {e.status === "success" ? (
                          <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                        ) : e.status === "error" ? (
                          <AlertCircle className="w-3 h-3 text-red-500 shrink-0" />
                        ) : (
                          <Clock className="w-3 h-3 text-blue-400 shrink-0" />
                        )}
                        <span className="text-gray-700 truncate">
                          {ENTITY_LABELS[e.entity] ?? e.entity}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {e.rowCount != null && e.rowCount > 0 && (
                          <span className="text-gray-400">{e.rowCount.toLocaleString()}</span>
                        )}
                        <span className="text-gray-400">
                          {formatDuration(e.startedAt, e.finishedAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Triggered by */}
            {overall.triggeredBy && (
              <div className="text-xs text-gray-400 border-t border-gray-100 pt-2">
                เรียกโดย: {overall.triggeredBy === "cron" ? "ระบบอัตโนมัติ (01:00)" : overall.triggeredBy === "manual" ? "ผู้ใช้" : overall.triggeredBy}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Dropdown รวมปุ่ม Sync ทั้งหมด */
function SyncDropdown({
  isRunning,
  isClearing,
  isTriggerPending,
  isMdmPending,
  onResync,
  onSyncMdm,
  onTestMdm,
  onClearCache,
  onRepopulate,
  isRepopulating,
}: {
  isRunning: boolean;
  isClearing: boolean;
  isTriggerPending: boolean;
  isMdmPending: boolean;
  onResync: () => void;
  onSyncMdm: () => void;
  onTestMdm: () => void;
  onClearCache: () => void;
  /** callback สำหรับ Repopulate Summary — ถ้าไม่ส่งมา จะไม่แสดงปุ่ม */
  onRepopulate?: () => void;
  isRepopulating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  // ปิด dropdown เมื่อคลิกนอก
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const anyBusy = isRunning || isClearing || isTriggerPending || isMdmPending;

  return (
    <div ref={dropRef} className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={anyBusy}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50 transition-colors"
        title="ตัวเลือกการ Sync"
      >
        <RefreshCw className={`w-4 h-4 ${isTriggerPending || isMdmPending ? "animate-spin" : ""}`} />
        <span className="hidden sm:inline">Sync</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-lg border border-gray-200 py-1.5 z-50">
          {/* Re-Sync API */}
          <button
            onClick={() => { onResync(); setOpen(false); }}
            disabled={isRunning || isTriggerPending}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${isTriggerPending ? "animate-spin" : ""}`} />
            <div className="text-left">
              <div className="font-medium">Re-Sync API</div>
              <div className="text-xs text-gray-400">ดึงข้อมูลทั้งหมด (หลายนาที)</div>
            </div>
          </button>

          {/* Sync MDM */}
          <button
            onClick={() => { onSyncMdm(); setOpen(false); }}
            disabled={isRunning || isMdmPending}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${isMdmPending ? "animate-spin" : ""}`} />
            <div className="text-left">
              <div className="font-medium">Sync MDM</div>
              <div className="text-xs text-blue-400">อัปเดตสถานะออนไลน์ (~30วิ)</div>
            </div>
          </button>

          {/* Test MDM — diagnostic */}
          <button
            onClick={() => { onTestMdm(); setOpen(false); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-purple-600 hover:bg-purple-50 transition-colors"
          >
            <Info className="w-4 h-4 shrink-0" />
            <div className="text-left">
              <div className="font-medium">Test MDM</div>
              <div className="text-xs text-purple-400">ตรวจสอบการเชื่อมต่อ MDM API</div>
            </div>
          </button>

          {/* Repopulate Summary — แสดงเฉพาะเมื่อมี onRepopulate callback (superAdmin only) */}
          {onRepopulate && (
            <>
              <div className="my-1 border-t border-gray-100" />
              <button
                onClick={() => { onRepopulate(); setOpen(false); }}
                disabled={isRunning || isRepopulating}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-purple-600 hover:bg-purple-50 disabled:opacity-40 transition-colors"
              >
                <RefreshCw className={`w-4 h-4 shrink-0 ${isRepopulating ? "animate-pulse" : ""}`} />
                <div className="text-left">
                  <div className="font-medium">{isRepopulating ? "กำลังประมวลผล..." : "Repopulate Summary"}</div>
                  <div className="text-xs text-purple-400">สร้าง Cache รายงานใหม่</div>
                </div>
              </button>
            </>
          )}

          {/* Divider */}
          <div className="my-1 border-t border-gray-100" />

          {/* Clear Cache */}
          <button
            onClick={() => { onClearCache(); setOpen(false); }}
            disabled={isRunning || isClearing}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-orange-600 hover:bg-orange-50 disabled:opacity-40 transition-colors"
          >
            <Trash2 className={`w-4 h-4 shrink-0 ${isClearing ? "animate-pulse" : ""}`} />
            <div className="text-left">
              <div className="font-medium">Clear Cache</div>
              <div className="text-xs text-orange-400">ล้างแคชเบราเซอร์</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

export function SyncStatusBar({
  onRepopulate,
  isRepopulating,
}: {
  /** callback สำหรับ Repopulate Summary — ถ้าไม่ส่งมา จะไม่แสดงปุ่มใน Dropdown */
  onRepopulate?: () => void;
  isRepopulating?: boolean;
} = {}) {
  const { section } = useSection();
  const utils = trpc.useUtils();
  const debtCache = useDebtCache();
  const incomeCache = useIncomeCache();
  const [, navigate] = useLocation();
  const [isClearing, setIsClearing] = useState(false);
  const { can } = useAppAuth();
  const canResync = can("sync_api", "sync");
  const [showLogPopup, setShowLogPopup] = useState(false);

  // Last synced time for the active section.
  const last = trpc.sync.lastSyncedAt.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section, refetchOnWindowFocus: true },
  );

  // Poll sync status from DB — fast poll when running, slow poll when idle.
  const status = trpc.sync.status.useQuery(undefined, {
    refetchInterval: (q) => {
      const d = q.state.data as any;
      if (!d) return 3000;
      const s = section ?? "Boonphone";
      return d?.[s]?.running ? 2000 : 10000;
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

  // SSE stream ref — keeps Render/Cloud Run alive during sync
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

  // isSyncingLocally = true ทันทีที่กด Re-Sync
  const [isSyncingLocally, setIsSyncingLocally] = useState(false);
  const syncingLocallyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSyncingLocally = useCallback((delayMs = 1500) => {
    if (syncingLocallyTimerRef.current) clearTimeout(syncingLocallyTimerRef.current);
    syncingLocallyTimerRef.current = setTimeout(() => {
      setIsSyncingLocally(false);
      syncingLocallyTimerRef.current = null;
    }, delayMs);
  }, []);

  const triggerSSE = useCallback(
    (sec: string, onDone: () => void) => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }

      const es = new EventSource(`/api/sync-stream/${sec}`, { withCredentials: true });
      sseRef.current = es;

      const connectTimeout = setTimeout(() => {
        toast.error("Server ไม่ตอบสนอง กรุณาลองใหม่");
        onDone();
        es.close();
        sseRef.current = null;
      }, 30000);

      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          clearTimeout(connectTimeout);

          if (msg.type === "started") {
            toast.info(`เริ่ม Re-Sync ${sec}...`);
            onDone();
            utils.sync.status.invalidate();
          } else if (msg.type === "already_running") {
            toast.info(`Sync ${sec} กำลังทำงานอยู่แล้ว`);
            onDone();
            setIsSyncingLocally(false);
            utils.sync.status.invalidate();
            es.close();
            sseRef.current = null;
          } else if (msg.type === "done") {
            toast.success(`Re-Sync ${sec} สำเร็จ (${msg.rowCount ?? 0} rows)`);
            onDone();
            setIsSyncingLocally(false);
            utils.sync.status.invalidate();
            utils.sync.lastSyncedAt.invalidate();
            utils.sync.lastRunSummary.invalidate();
            if (section) incomeCache.invalidateIncomeCache(section as SectionKey);
            // Fix: clear debt cache เพื่อให้ยอดเก็บหนี้ (collected) อัปเดตทุกครั้งที่ sync
            // (เป้าเก็บหนี้ยังคง freeze ตามปกติ เฉพาะ collected rows ที่ต้อง re-fetch)
            if (section) debtCache.clearCache(section as SectionKey);
            es.close();
            sseRef.current = null;
          } else if (msg.type === "error") {
            toast.error(`Sync ${sec} ล้มเหลว: ${msg.message}`);
            onDone();
            setIsSyncingLocally(false);
            utils.sync.status.invalidate();
            utils.sync.lastRunSummary.invalidate();
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
        onDone();
        setIsSyncingLocally(false);
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
    [utils, section, status.data, incomeCache, setIsSyncingLocally],
  );

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, []);

  // MDM online days sync — client fetches MDM directly (bypasses Cloudflare IP block on Render)
  const getMdmApiKeyQuery = trpc.sync.getMdmApiKey.useQuery(
    { section: (section ?? "Boonphone") as SectionKey },
    { enabled: false, retry: false, refetchOnWindowFocus: false }
  );

  /**
   * handleTestMdm — ทดสอบ MDM API จาก client browser โดยตรง
   * (ไม่ผ่าน Render server เพื่อหลีกเลี่ยง Cloudflare IP block)
   */
  const handleTestMdm = useCallback(async () => {
    if (!section) return;
    const toastId = toast.loading("กำลังทดสอบ MDM API จาก browser...");
    try {
      // ขอ API key จาก server
      const keyResult = await getMdmApiKeyQuery.refetch();
      const apiKey = keyResult.data?.apiKey;
      if (!apiKey) throw new Error("ไม่พบ MDM API Key");
      const maskedKey = `${apiKey.slice(0, 6)}...${apiKey.slice(-4)} (len=${apiKey.length})`;
      // ทดสอบ fetch MDM API โดยตรงจาก browser (ไม่ผ่าน Render server ที่ถูก Cloudflare block)
      const url = `https://mdm-th.com/api/mdm/devices?pageNum=1&pageSize=1`;
      const res = await fetch(url, {
        headers: {
          "X-API-Key": apiKey,
          "Accept": "application/json, text/plain, */*",
        },
      });
      const body = await res.text();
      if (res.ok) {
        toast.success(`MDM OK [${section}] status=${res.status} key=${maskedKey}`, { id: toastId });
      } else {
        toast.error(`MDM FAIL [${section}] status=${res.status} key=${maskedKey} — ${body.slice(0, 200)}`, { id: toastId });
      }
    } catch (err: any) {
      toast.error(`MDM Error: ${err?.message ?? String(err)}`, { id: toastId });
    }
  }, [section, getMdmApiKeyQuery]);

  const saveMdmDataMutation = trpc.sync.saveMdmData.useMutation({
    onSuccess: (data) => {
      toast.success(`อัปเดต MDM Online Days เรียบร้อย! (${data.updated}/${data.total} สัญญา)`);
    },
    onError: (err) => toast.error(`MDM Save ผิดพลาด: ${err.message}`),
  });
  const [isMdmSyncing, setIsMdmSyncing] = useState(false);

  /**
   * handleSyncMdm — Client-side MDM sync
   * 1. ขอ API key จาก server
   * 2. Client fetch MDM API โดยตรง (ผ่าน residential IP ไม่ถูก Cloudflare block)
   * 3. คำนวณ lastOnlineDays จาก lastTime
   * 4. ส่ง device data กลับ server เพื่อบันทึกลง DB
   */
  const handleSyncMdm = useCallback(async () => {
    if (!section || isMdmSyncing || saveMdmDataMutation.isPending) return;
    setIsMdmSyncing(true);
    const toastId = toast.loading("กำลังดึงข้อมูล MDM...");
    try {
      // Step 1: ขอ API key จาก server
      const keyResult = await getMdmApiKeyQuery.refetch();
      const apiKey = keyResult.data?.apiKey;
      if (!apiKey) throw new Error("ไม่พบ MDM API Key");

      // Step 2: Fetch MDM devices ทั้งหมด (pagination)
      const PAGE_SIZE = 1000;
      // เพิ่ม deviceLock ใน type
      const allDevices: Array<{ deviceId: string; lastTime: string; deviceLock: boolean | null; lastType: number | null; mdmId: number | null; lossStatus: number | null }> = [];
      let pageNum = 1;
      let total = 0;
      let fetched = 0;
      toast.loading("กำลังดึงข้อมูล MDM (0 devices)...", { id: toastId });
      do {
        const url = `https://mdm-th.com/api/mdm/devices?pageNum=${pageNum}&pageSize=${PAGE_SIZE}`;
        // timeout 60 วินาทีต่อ page เพื่อป้องกัน Fetch is aborted บนมือถือ
        const res = await fetch(url, {
          headers: {
            "X-API-Key": apiKey,
            "Accept": "application/json, text/plain, */*",
          },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`MDM API ตอบกลับ ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        const devices: Array<{ deviceId?: string; lastTime?: string; deviceLock?: number | string | boolean; lastType?: number; id?: number }> =
          Array.isArray(json) ? json : (json?.rows ?? json?.data ?? json?.devices ?? []);
        if (pageNum === 1) total = json?.total ?? devices.length;
        for (const d of devices) {
          if (d.deviceId && d.lastTime) {
            // normalize deviceLock: 1/"1"/true = ล็อค, 0/"0"/false = ปลดล็อค
            const lockVal = d.deviceLock;
            const isLocked = lockVal === 1 || lockVal === "1" || lockVal === true ? true
              : lockVal === 0 || lockVal === "0" || lockVal === false ? false
              : null;
            allDevices.push({ 
              deviceId: d.deviceId, 
              lastTime: d.lastTime, 
              deviceLock: isLocked, 
              lastType: typeof d.lastType === 'number' ? d.lastType : null, 
              mdmId: typeof d.id === 'number' ? d.id : null, 
              lossStatus: (d as any).lossStatus != null ? Number((d as any).lossStatus) : null 
            });
          }
        }
        fetched += devices.length;
        pageNum++;
        toast.loading(`กำลังดึงข้อมูล MDM (${fetched}/${total} devices)...`, { id: toastId });
      } while (fetched < total && total > 0);

      // Step 3: คำนวณ lastOnlineDays จาก lastTime
      const today = new Date();
      const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const calcDays = (lastTime: string): number | null => {
        const datePart = lastTime.split(" ")[0];
        if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
        const lastDate = new Date(`${datePart}T00:00:00`);
        if (isNaN(lastDate.getTime())) return null;
        const diffMs = todayDate.getTime() - lastDate.getTime();
        return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      };

      // เพิ่ม deviceLock + lastType + mdmDeviceId + lossStatus ใน payload
      const devicePayload = allDevices.map((d) => ({
        serialNo: d.deviceId,
        lastOnlineDays: calcDays(d.lastTime),
        lastOnlineAt: d.lastTime,
        deviceLock: d.deviceLock,
        lastType: d.lastType,       // 0=offline, 1=online ณ ขณะ sync
        mdmDeviceId: d.mdmId,       // MDM internal ID — ใช้ดึง GPS location
        lossStatus: d.lossStatus,   // 0=ปกติ, 1=Lost Mode (ดึง GPS ได้)
      }));

      // Step 4: ส่งผลกลับ server เพื่อบันทึกลง DB
      toast.loading(`บันทึกข้อมูล MDM ${devicePayload.length} devices (รวม deviceLock)...`, { id: toastId });
      await saveMdmDataMutation.mutateAsync({
        section: section as SectionKey,
        devices: devicePayload,
      });
      toast.dismiss(toastId);
    } catch (err: any) {
      toast.error(`MDM Sync ผิดพลาด: ${err?.message ?? String(err)}`, { id: toastId });
    } finally {
      setIsMdmSyncing(false);
    }
  }, [section, isMdmSyncing, saveMdmDataMutation, getMdmApiKeyQuery]);

  // Force-clear stuck sync mutation
  const clearStuck = trpc.sync.clearStuck.useMutation({
    onSuccess: (data) => {
      toast.success(`ล้าง sync ที่ค้างแล้ว (${data.cleared} รายการ) — สามารถ Re-Sync ใหม่ได้`);
      utils.sync.status.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const [isTriggerPending, setIsTriggerPending] = useState(false);

  useEffect(() => {
    if (isRunning) setIsSyncingLocally(false);
  }, [isRunning]);

  const isShowingProgress = isRunning || isSyncingLocally;

  const handleResync = useCallback(() => {
    if (!section || isShowingProgress || isTriggerPending) return;
    setIsTriggerPending(true);
    setIsSyncingLocally(true);
    const fallbackTimer = setTimeout(() => {
      setIsTriggerPending(false);
      setIsSyncingLocally(false);
    }, 15000);
    triggerSSE(section, () => {
      clearTimeout(fallbackTimer);
      setIsTriggerPending(false);
    });
  }, [section, isShowingProgress, isTriggerPending, triggerSSE]);

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
    <>
      <div className="flex items-center gap-2">
        {/* ข้อมูล ณ วันที่ + ไอคอน i */}
        <div className="hidden sm:flex items-center gap-1">
          <span className="text-xs text-gray-500 whitespace-nowrap">
            ข้อมูล ณ {lastLabel}
          </span>
          <button
            onClick={() => setShowLogPopup((v) => !v)}
            className="inline-flex items-center justify-center w-4 h-4 rounded-full text-gray-400 hover:text-blue-500 hover:bg-blue-50 transition-colors"
            title="ดูรายละเอียด Sync ล่าสุด"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </div>

        {isShowingProgress && canResync ? (
          /* ---- Progress bar ---- */
          <div className="flex items-center gap-2">
            <div className="min-w-[180px] max-w-[260px]">
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
              <Progress value={progress} className="h-1.5" />
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
            {elapsedSecs > 600 && (
              <button
                onClick={() => clearStuck.mutate({ section })}
                disabled={clearStuck.isPending}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-red-200 hover:bg-red-50 text-xs text-red-600 disabled:opacity-50 transition-colors shrink-0"
                title="ยกเลิก sync ที่ค้างอยู่"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">ยกเลิก</span>
              </button>
            )}
          </div>
        ) : canResync ? (
          /* ---- Dropdown menu รวมปุ่ม Sync ทั้งหมด ---- */
          <SyncDropdown
            isRunning={isRunning}
            isClearing={isClearing}
            isTriggerPending={isTriggerPending}
            isMdmPending={isMdmSyncing || saveMdmDataMutation.isPending}
            onResync={handleResync}
            onSyncMdm={handleSyncMdm}
            onTestMdm={handleTestMdm}
            onClearCache={handleClearCache}
            onRepopulate={onRepopulate}
            isRepopulating={isRepopulating}
          />
        ) : null}
      </div>

      {/* Sync Log Popup */}
      {showLogPopup && section && (
        <SyncLogPopup
          section={section as SectionKey}
          onClose={() => setShowLogPopup(false)}
        />
      )}
    </>
  );
}

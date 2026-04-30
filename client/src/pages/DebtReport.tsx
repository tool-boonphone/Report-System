import React from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BadgeDollarSign,
  Banknote,
  CalendarDays,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  ChevronsUpDown,
  CircleDollarSign,
  Coins,
  Download,
  Gavel,
  Info,
  LockOpen,
  Percent,
  Pin,
  PinOff,
  Search,
  Smartphone,
  Tag,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/* -------------------------------------------------------------------- */
/* Utilities                                                            */
/* -------------------------------------------------------------------- */

const DEBT_STATUSES = [
  "ปกติ",
  "เกิน 1-7",
  "เกิน 8-14",
  "เกิน 15-30",
  "เกิน 31-60",
  "เกิน 61-90",
  "เกิน >90",
  "ระงับสัญญา",
  "สิ้นสุดสัญญา",
  "หนี้เสีย",
] as const;

type DebtStatus = (typeof DEBT_STATUSES)[number];

function fmtMoney(n: number | null | undefined) {
  if (n == null || Number.isNaN(Number(n))) return "";
  const num = Number(n);
  if (num === 0) return "0.00";
  return num.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "-";
  return d.slice(0, 10);
}

/** Format datetime string as DD/MM/YYYY HH:mm (Thai-friendly) */
function fmtDateTime(d: string | null | undefined) {
  if (!d) return "-";
  // Handle both "YYYY-MM-DD HH:mm:ss" and "YYYY-MM-DDTHH:mm:ss" formats
  const dt = new Date(d.replace(" ", "T"));
  if (isNaN(dt.getTime())) return d.slice(0, 16).replace("T", " ");
  const day = String(dt.getDate()).padStart(2, "0");
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const year = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hh}:${mm}`;
}

/** Mapping: status label → Tailwind classes for the colored pill badge. */
function statusPillClasses(status: string): string {
  // Colors taken from boonphone.co.th/mm.html reference palette.
  switch (status) {
    case "ปกติ":
      return "bg-green-100 text-green-800 border-green-300";
    case "เกิน 1-7":
      return "bg-yellow-100 text-yellow-900 border-yellow-300";
    case "เกิน 8-14":
      return "bg-amber-200 text-amber-900 border-amber-400";
    case "เกิน 15-30":
      return "bg-orange-200 text-orange-900 border-orange-400";
    case "เกิน 31-60":
      return "bg-red-200 text-red-900 border-red-400";
    case "เกิน 61-90":
      return "bg-red-300 text-red-900 border-red-500";
    case "เกิน >90":
      return "bg-rose-700 text-white border-rose-800";
    case "ระงับสัญญา":
      return "bg-gray-800 text-white border-gray-900";
    case "สิ้นสุดสัญญา":
      return "bg-blue-100 text-blue-800 border-blue-300";
    case "หนี้เสีย":
      return "bg-gray-700 text-white border-gray-800";
    default:
      return "bg-gray-100 text-gray-700 border-gray-200";
  }
}

/* -------------------------------------------------------------------- */
/* Types                                                                */
/* -------------------------------------------------------------------- */

type InstallmentCell = {
  period: number | null;
  dueDate: string | null;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  /** ค่าปลดล็อก (unlock fee) for this period. */
  unlockFee?: number;
  amount: number;
  paid: number;
  /** Baseline per-contract installment amount (from contracts.installment_amount). */
  baselineAmount: number;
  /** Delta vs baseline: > 0 when API deducted overpaid from this period. */
  overpaidApplied: number;
  /** True when the period is reported as already closed (amount=0 with baseline>0). */
  isClosed: boolean;
  /** True when the period is ระงับสัญญา or หนี้เสีย. */
  isSuspended?: boolean;
  /** Label to render: "ระงับสัญญา" or "หนี้เสีย" (null when !isSuspended). */
  suspendLabel?: string | null;
  /** YYYY-MM-DD that the contract changed to suspended/bad-debt. */
  suspendedAt?: string | null;
  /** True when this period's displayed amounts include carry-forward from unpaid prior periods. */
  isArrears?: boolean;
  /** True when this is the current (first unpaid past/current) period — sky-50 BG highlight. */
  isCurrentPeriod?: boolean;
  /** Phase 9AH: principal+interest+fee only (no penalty/unlockFee). Used for principalOnly display. */
  netAmount?: number;
  /** True when this period has been fully paid (principal reduced to 0). Used for green text styling. */
  isPaid?: boolean;
};

type PaymentCell = {
  /** Installment period (1..N) this payment was applied to. */
  period: number | null;
  /** 0 = primary row, >0 = sub-row "- แบ่งชำระ -". */
  splitIndex: number;
  isCloseRow: boolean;
  isBadDebtRow: boolean;
  paidAt: string | null;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  unlockFee: number;
  discount: number;
  overpaid: number;
  closeInstallmentAmount: number;
  badDebt: number;
  total: number;
  receiptNo: string | null;
  remark: string | null;
  /** tooltip สำหรับ bad debt rows: "ยอดขายเครื่อง X บาท (DD/MM/YYYY)" */
  badDebtNote?: string | null;
  /** ผู้บันทึก (updated_by จาก API) */
  updatedBy?: string | null;
  /** วันที่บันทึก (updated_at จาก API) */
  updatedAt?: string | null;
};

type TargetRow = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  productType: string | null;
  installmentCount: number | null;
  installmentAmount: number | null;
  totalAmount: number;
  totalPaid: number;
  remaining: number;
  debtStatus: string;
  daysOverdue: number;
  installments: InstallmentCell[];
};

type CollectedRow = TargetRow & { payments: PaymentCell[] };

/* -------------------------------------------------------------------- */
/* Page                                                                 */
/* -------------------------------------------------------------------- */

/* -------------------------------------------------------------------- */
/* StatusMultiSelect component                                         */
/* -------------------------------------------------------------------- */
function StatusMultiSelect({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  // Close on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const toggle = (s: string) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(next);
  };
  const label =
    selected.size === 0
      ? "ทุกสถานะหนี้"
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} สถานะ`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px] justify-between"
      >
        <span className="truncate">{label}</span>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-[200px] bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.size === 0 ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
              {selected.size === 0 && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </span>
            ทุกสถานะหนี้
          </button>
          <div className="border-t border-gray-100 my-1" />
          {DEBT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
            >
              <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.has(s) ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
                {selected.has(s) && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
              </span>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Generic multi-select filter using Popover + Command pattern */
function MultiSelectFilter({
  label,
  selected,
  onChange,
  options,
  placeholder = "ทั้งหมด",
}: {
  label: string;
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const toggle = (s: string) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(next);
  };
  const labelText =
    selected.size === 0
      ? placeholder
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} รายการ`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px] justify-between ${
            selected.size > 0
              ? "border-indigo-400 bg-indigo-50 text-indigo-800 font-medium"
              : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
          }`}
        >
          <span className="truncate">{labelText}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={`ค้นหา ${label}...`} className="h-8 text-sm" />
          <CommandList>
            <CommandEmpty>ไม่พบตัวเลือก</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                onSelect={() => { onChange(new Set()); setOpen(false); }}
              >
                <Check className={`mr-2 h-3.5 w-3.5 ${selected.size === 0 ? "opacity-100 text-indigo-600" : "opacity-0"}`} />
                <span className={selected.size === 0 ? "text-indigo-600 font-medium" : "text-gray-500"}>
                  {placeholder}
                </span>
              </CommandItem>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={(v) => {
                    const original = options.find((o) => o.toLowerCase() === v) ?? v;
                    toggle(original);
                  }}
                >
                  <Check className={`mr-2 h-3.5 w-3.5 ${selected.has(opt) ? "opacity-100 text-indigo-600" : "opacity-0"}`} />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function DebtReport() {
  const { can, isSuperAdmin } = useAppAuth();
  const { section } = useSection();
  const { setActions } = useNavActions();
  const canView = can("debt_report", "view");
  const canExport = can("debt_report", "export");

  const [tab, setTab] = useState<"target" | "collected">("target");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  // New filters: month-year approve date, month-year due date, product type
  const [approveDateFilter, setApproveDateFilter] = useState<Set<string>>(new Set());
  const [dueDateFilter, setDueDateFilter] = useState<Set<string>>(new Set());
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  // Phase 23: exact date filter (YYYY-MM-DD)
  // target tab = วันที่ที่ต้องชำระ (dueDate), collected tab = วันที่ที่ชำระ (paidAt)
  // When set, masks cells whose date != selected date (does NOT hide the row)
  const [dueDateExact, setDueDateExact] = useState<string | null>(null);
  // Phase 26: badge visibility toggle for collected tab
  // discount is always false (cannot be toggled on)
  const [badgeVisibility, setBadgeVisibility] = useState<Record<string, boolean>>({
    principal: true,
    interest: true,
    fee: true,
    penalty: true,
    unlockFee: true,
    overpaid: true,
    badDebt: true,
    discount: false, // always off — not collected money
  });
  const toggleBadge = (key: string) => {
    if (key === "discount") return; // cannot toggle discount
    setBadgeVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  // Switch: true = เฉพาะเงินต้น (แสดง penalty/unlockFee = 0 ทุกงวด), false = รวมค่าปรับ+ค่าปลดล็อก
  const [principalOnly, setPrincipalOnly] = useState(true);
  // สวิต "ตั้งหนี้" (target tab only): เมื่อเปิด ซ่อนแถวที่ชำระครบ/ล่วงหน้า/ระงับ/สิ้นสุด/หนี้เสีย/ยังไม่ถึงดิว
  const [debtSetMode, setDebtSetMode] = useState(false);
  // ตัวกรอง "บันทึกโดย" (collected tab only)
  const [updatedByFilter, setUpdatedByFilter] = useState<string | null>(null);
  // Color legend modal
  const [showColorLegend, setShowColorLegend] = useState(false);
  // Pinned columns: set of LEFT_COLS keys that are sticky-left
  const [pinnedCols, setPinnedCols] = useState<Set<string>>(new Set());
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  // Phase 3 (vertical layout): expand/collapse state for collected tab rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleExpand = (contractNo: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(contractNo)) next.delete(contractNo);
      else next.add(contractNo);
      return next;
    });
  };
  const togglePin = (key: string) => {
    setPinnedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Phase 125: Global Cache — ข้อมูลจะถูกเก็บไว้ใน DebtCacheContext ตลอด session
  // ทำให้ไม่ต้อง fetch ใหม่เมื่อเปลี่ยนเมนูแล้วกลับมา
  const utils = trpc.useUtils();
  const debtCache = useDebtCache();
  const [streamLoading, setStreamLoading] = useState<{ target: boolean; collected: boolean }>({ target: false, collected: false });
  const [streamError, setStreamError] = useState<{ target: string | null; collected: string | null }>({ target: null, collected: null });
  const [streamProgress, setStreamProgress] = useState<{ target: number; collected: number }>({ target: 0, collected: 0 });
  const [streamTotal, setStreamTotal] = useState<{ target: number; collected: number }>({ target: 0, collected: 0 });
  // อ่านข้อมูลจาก Global Cache
  const cachedEntry = section ? debtCache.getCache(section as any) : { target: null, collected: null, loadedAt: 0 };
  const streamData = { target: cachedEntry.target, collected: cachedEntry.collected };

  /** Phase 122: fetch chunk พร้อม retry (max 3 ครั้ง, exponential backoff) */
  const fetchChunkWithRetry = useCallback(async (
    t: "target" | "collected",
    offset: number,
    limit: number,
    maxRetries = 3,
  ) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (t === "target") {
          return await utils.debt.getTargetChunk.fetch({ section: section as any, offset, limit });
        } else {
          return await utils.debt.getCollectedChunk.fetch({ section: section as any, offset, limit });
        }
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries - 1) {
          // exponential backoff: 1s, 2s, 4s
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastErr;
  }, [utils, section]);

  const fetchStream = useCallback(async (t: "target" | "collected") => {
    if (!canView || !section) return;
    // รีเซ็ต state ใน cache สำหรับ type นี้
    debtCache.setLoadingState(section as any, t, { loading: true, progress: 0, total: 0, error: null });
    setStreamLoading((prev) => ({ ...prev, [t]: true }));
    setStreamError((prev) => ({ ...prev, [t]: null }));
    setStreamProgress((prev) => ({ ...prev, [t]: 0 }));
    setStreamTotal((prev) => ({ ...prev, [t]: 0 }));
    try {
      const CHUNK_SIZE = 500; // ลดจาก 2000 เป็น 500 (~2MB ต่อ request) เพื่อลด Cloudflare timeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = [];
      let hasPrincipalBreakdown = true;
      let offset = 0;
      let totalContracts = 0;
      // วน fetch จนครบ total
      while (true) {
        const result = await fetchChunkWithRetry(t, offset, CHUNK_SIZE);
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
        setStreamTotal((prev) => ({ ...prev, [t]: totalContracts }));
        setStreamProgress((prev) => ({ ...prev, [t]: rows.length }));
        debtCache.setLoadingState(section as any, t, { progress: rows.length, total: totalContracts });
        if (!hasMore) break;
      }
      // บันทึกลง Global Cache
      if (t === "target") {
        debtCache.setTargetRows(section as any, rows as TargetRow[]);
      } else {
        debtCache.setCollectedRows(section as any, rows as CollectedRow[], hasPrincipalBreakdown);
      }
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (err as any)?.message ?? "เกิดข้อผิดพลาด";
      setStreamError((prev) => ({ ...prev, [t]: msg }));
      debtCache.setLoadingState(section as any, t, { error: msg });
    } finally {
      setStreamLoading((prev) => ({ ...prev, [t]: false }));
      debtCache.setLoadingState(section as any, t, { loading: false });
    }
  }, [canView, section, fetchChunkWithRetry]);

  // Auto-fetch when tab/section changes (only if not already loaded)
  useEffect(() => {
    if (!canView || !section) return;
    if (tab === "target" && !streamData.target && !streamLoading.target) {
      fetchStream("target");
    } else if (tab === "collected" && !streamData.collected && !streamLoading.collected) {
      fetchStream("collected");
    }
  }, [tab, section, canView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset stream data when section changes
  // ไม่ล้าง Global Cache เพราะแต่ละ section มี cache แยกกัน เพียง reset local UI state
  useEffect(() => {
    setStreamError({ target: null, collected: null });
    setStreamLoading({ target: false, collected: false });
    setStreamProgress({ target: 0, collected: 0 });
    setStreamTotal({ target: 0, collected: 0 });
  }, [section]);

  const isLoading = tab === "target" ? streamLoading.target : streamLoading.collected;
  const isError = tab === "target" ? !!streamError.target : !!streamError.collected;
  const queryError = tab === "target" ? streamError.target : streamError.collected;
  const refetch = useCallback(() => fetchStream(tab), [fetchStream, tab]);

  // Track elapsed time for first-load progress indicator
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isLoading) {
      setElapsedSec(0);
      return;
    }
    const t0 = Date.now();
    setElapsedSec(0);
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [isLoading]);

  const activeRows: (TargetRow | CollectedRow)[] =
    (tab === "target"
      ? (streamData.target?.rows as TargetRow[])
      : (streamData.collected?.rows as CollectedRow[])) ?? [];
  // hasPrincipalBreakdown: true = Boonphone (แสดง principal/interest/fee จริง)
  //                         false = Fastfone365 (แสดง "-" แทน 0.00)
  const hasPrincipalBreakdown = streamData.collected?.hasPrincipalBreakdown !== false;

  /* ---- updatedBy options (collected tab only) ---- */
  const updatedByOptions = useMemo(() => {
    if (tab !== "collected") return [];
    const s = new Set<string>();
    for (const r of activeRows as CollectedRow[]) {
      for (const p of r.payments ?? []) {
        if (p.updatedBy) s.add(p.updatedBy);
      }
    }
    return Array.from(s).sort();
  }, [activeRows, tab]);

  /* ---- Dynamic filter options (derived from ALL active rows, not filtered) ---- */
  const approveDateOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of activeRows) {
      if (r.approveDate) s.add(r.approveDate.slice(0, 7));
    }
    return Array.from(s).sort().reverse();
  }, [activeRows]);

  const dueDateOptions = useMemo(() => {
    const s = new Set<string>();
    // Phase 28: collected tab uses paidAt month for filter options; target tab uses dueDate month
    if (tab === "collected") {
      for (const r of activeRows as CollectedRow[]) {
        for (const p of r.payments ?? []) {
          if (p.paidAt) s.add(p.paidAt.slice(0, 7));
        }
      }
    } else {
      for (const r of activeRows) {
        for (const inst of r.installments) {
          if (inst.dueDate) s.add(inst.dueDate.slice(0, 7));
        }
      }
    }
    return Array.from(s).sort().reverse();
  }, [activeRows, tab]);

  const productTypeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of activeRows) {
      if (r.productType) s.add(r.productType);
    }
    return Array.from(s).sort();
  }, [activeRows]);

  /* ---- Filter (client-side) ---- */
  // Priority: approveDateFilter > dueDateExact > dueDateFilter > statusFilter > productTypeFilter
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeRows.filter((r) => {
      // 1. เดือน-ปีที่อนุมัติ
      if (approveDateFilter.size > 0) {
        const ym = r.approveDate ? r.approveDate.slice(0, 7) : "";
        if (!approveDateFilter.has(ym)) return false;
      }
      // 2. วันที่ (exact date picker)
      //    - collected tab: ซ่อน row ที่ไม่มี payment ใดที่ paidAt ตรงวันที่เลือก
      //    - target tab: ซ่อน row ที่ไม่มี installment dueDate ตรงวันที่เลือก (cell masking handles the rest)
      if (dueDateExact) {
        const hasMatch =
          tab === "collected"
            ? (r as CollectedRow).payments?.some(
                (p) => p.paidAt && p.paidAt.slice(0, 10) === dueDateExact
              ) ?? false
            : r.installments.some(
                (inst) => inst.dueDate && inst.dueDate.slice(0, 10) === dueDateExact
              );
        if (!hasMatch) return false;
      }
      // 3. เดือน-ปีที่ต้องชำระ / เดือน-ปีที่ชำระ (month-year filter)
      //    target tab: Row passes if ANY installment's due_date month is in the filter.
      //    collected tab: Row passes if ANY payment's paidAt month is in the filter.
      //    Phase 28: collected tab filters by paidAt, not dueDate.
      if (dueDateFilter.size > 0) {
        const hasMatch =
          tab === "collected"
            ? (r as CollectedRow).payments?.some(
                (p) => p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7))
              ) ?? false
            : r.installments.some(
                (inst) => inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7))
              );
        if (!hasMatch) return false;
      }
      // 4. สถานะหนี้
      if (statusFilter.size > 0 && !statusFilter.has(r.debtStatus)) return false;
      // 5. ประเภทเครื่อง
      if (productTypeFilter.size > 0 && !productTypeFilter.has(r.productType ?? "")) return false;
      // 6. บันทึกโดย (collected tab only) — กรองระดับ row: แสดงเฉพาะ row ที่มี payment ของคนนั้น
      if (tab === "collected" && updatedByFilter) {
        const hasMatch = (r as CollectedRow).payments?.some((p) => p.updatedBy === updatedByFilter) ?? false;
        if (!hasMatch) return false;
      }
      // 7. ตั้งหนี้ (target tab only) — ซ่อน row ที่ทุก installment เป็น paid/closed/suspended/future
      if (tab === "target" && debtSetMode) {
        const todayStr = new Date().toISOString().slice(0, 10);
        // Row ผ่านถ้ามี installment อย่างน้อย 1 งวดที่ต้องเก็บ (ส้มหรือดำ)
        // = ไม่ใช่ closed, ไม่ใช่ suspended, ไม่ใช่ paid, ไม่ใช่ future (dueDate > today)
        // และ contract status ไม่ใช่ ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย
        const specialStatus = r.debtStatus === "ระงับสัญญา" || r.debtStatus === "สิ้นสุดสัญญา" || r.debtStatus === "หนี้เสีย";
        if (specialStatus) return false;
        const hasCollectableInst = r.installments.some((inst) => {
          if (inst.isClosed || inst.isSuspended) return false;
          if (inst.isPaid) return false;
          if (inst.dueDate && inst.dueDate > todayStr) return false;
          return true;
        });
        if (!hasCollectableInst) return false;
      }
      // 8. ค้นหา
      if (!q) return true;
      return (
        (r.contractNo ?? "").toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q)
      );
    });
  }, [activeRows, search, statusFilter, approveDateFilter, dueDateFilter, productTypeFilter, dueDateExact, tab, updatedByFilter, debtSetMode]);

  /* ---- Max periods for the repeating group block ---- */
  // Phase 125: ใช้ filteredRows ทั้งหมดแทน pagedRows (ไม่มี pagination แล้ว)
  const maxPeriods = useMemo(() => {
    let max = 0;
    for (const r of filteredRows) {
      const n = r.installments.length;
      if (n > max) max = n;
    }
    // Cap at 36 to keep the DOM bounded; users can export for >36-งวด contracts.
    return Math.min(max, 36);
  }, [filteredRows]);

  /* ---- Per-row sub-rows: collected-tab payments grouped per period ---- */
  /** For collected tab, count max sub-rows per period across all rows so we
   * know how many cells the matrix needs in each group column. */
  // Currently unused at the matrix level (each row sizes itself), kept for
  // potential future use such as a global splitDepth-aware header.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
   const _splitDepth = useMemo(() => {
    if (tab !== "collected") return new Map<number, number>();
    const m = new Map<number, number>();
    for (const r of filteredRows as CollectedRow[]) {
      const perPeriod = new Map<number, number>();
      for (const p of r.payments ?? []) {
        if (p.period == null) continue;
        perPeriod.set(p.period, (perPeriod.get(p.period) ?? 0) + 1);
      }
      perPeriod.forEach((v, k) => {
        if (v > (m.get(k) ?? 0)) m.set(k, v);
      });
    }
    return m;
  }, [filteredRows, tab]);

  /** Per row "line count" — for collected tab, returns total payment count (vertical layout).
   *  For target tab, returns max split-payments per period (matrix layout). */
  function rowLineCount(r: CollectedRow): number {
    if (tab !== "collected") return 1;
    // Phase 3: vertical layout — each payment is a separate sub-row
    // Only count payments that pass the active date filters
    let count = 0;
    for (const p of r.payments ?? []) {
      if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
      if (dueDateExact && p.paidAt?.slice(0, 10) !== dueDateExact) continue;
      count++;
    }
    return count;
  }

  /* ---- Summary totals (computed from filteredRows, respects all filters) ---- */
  const targetSummary = useMemo(() => {
    if (tab !== "target") return null;
    const todayStr = new Date().toISOString().slice(0, 10);
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0, total = 0;
    for (const r of filteredRows) {
      // Phase 125 fix: penalty/unlockFee ใช้เฉพาะ currentPeriod ของแต่ละสัญญา (ค่าปรับถูก accumulate ไว้ที่งวดนั้นแล้ว)
      // เพื่อไม่ให้นับซ้ำจากทุกงวด
      const currentPeriodInst = r.installments.find((i) => i.isCurrentPeriod) ?? null;
      for (const inst of r.installments) {
        if (inst.isClosed || inst.isSuspended) continue;
        // Phase 125: debtSetMode — ไม่รวมงวดที่ชำระครบแล้ว (isPaid/เขียว) และงวดที่ยังไม่ถึงกำหนด (future/เทา) ใน badge
        if (debtSetMode && inst.isPaid) continue;
        if (debtSetMode && inst.dueDate && inst.dueDate > todayStr) continue;
        // Phase 23: dueDateFilter cell-mask — only sum periods whose dueDate month matches
        if (dueDateFilter.size > 0 && !(inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7)))) continue;
        // Phase 23: dueDateExact cell-mask — only sum periods whose dueDate matches exact date
        if (dueDateExact && inst.dueDate?.slice(0, 10) !== dueDateExact) continue;
        principal += inst.principal ?? 0;
        interest += inst.interest ?? 0;
        fee += inst.fee ?? 0;
        if (!principalOnly) {
          // penalty/unlockFee: นับเฉพาะงวด currentPeriod ของสัญญานี้ (ป้องกันนับซ้ำ)
          // ถ้าสัญญามี currentPeriod ให้นับเฉพาะงวดนั้น ถ้าไม่มีให้นับตามปกติ
          if (currentPeriodInst) {
            if (inst === currentPeriodInst) {
              penalty += inst.penalty ?? 0;
              unlockFee += inst.unlockFee ?? 0;
            }
            // งวดอื่นๆ ไม่นับ penalty/unlockFee (ถูก accumulate ไว้ที่ currentPeriod แล้ว)
          } else {
            // ไม่มี currentPeriod (เช่น ทุกงวดผ่านมาแล้วและยังไม่ปิด) — นับตามปกติ
            penalty += inst.penalty ?? 0;
            unlockFee += inst.unlockFee ?? 0;
          }
        }
      }
    }
    total = principal + interest + fee + penalty + unlockFee;
    return { principal, interest, fee, penalty, unlockFee, total };
  }, [filteredRows, tab, principalOnly, dueDateFilter, dueDateExact, debtSetMode]);

  const collectedSummary = useMemo(() => {
    if (tab !== "collected") return null;
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0;
    let discount = 0, overpaid = 0, badDebt = 0;
    for (const r of filteredRows as CollectedRow[]) {
      for (const p of r.payments ?? []) {
        // Phase 23: dueDateExact cell-mask — only sum payments whose paidAt matches exact date
        if (dueDateExact && (p.paidAt?.slice(0, 10) ?? null) !== dueDateExact) continue;
        // Phase 28: dueDateFilter cell-mask — only sum payments whose paidAt month is in filter
        if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
        principal += p.principal ?? 0;
        interest += p.interest ?? 0;
        fee += p.fee ?? 0;
        penalty += p.penalty ?? 0;
        unlockFee += p.unlockFee ?? 0;
        discount += p.discount ?? 0;
        overpaid += p.overpaid ?? 0;
        badDebt += p.badDebt ?? 0;
      }
    }
    // Phase 26: total = sum of visible badges only (discount always excluded)
    // ยอดที่ชำระรวม = เงินต้น + ดอกเบี้ย + ค่าดำเนินการ + ค่าปรับ + ค่าปลดล็อก + ชำระเกิน + หนี้เสีย (ไม่รวมส่วนลด)
    const bv = badgeVisibility;
    const total =
      (bv.principal ? principal : 0) +
      (bv.interest ? interest : 0) +
      (bv.fee ? fee : 0) +
      (bv.penalty ? penalty : 0) +
      (bv.unlockFee ? unlockFee : 0) +
      (bv.overpaid ? overpaid : 0) +
      (bv.badDebt ? badDebt : 0);
    return { principal, interest, fee, penalty, unlockFee, discount, overpaid, badDebt, total };
  }, [filteredRows, tab, dueDateExact, dueDateFilter, badgeVisibility]);

  /* ---- TopNav actions (sync + export) ---- */
  // Export handler (used inline in toolbar)
  const handleExport = React.useCallback(async () => {
    if (!section) return;
    const params = new URLSearchParams({ section, variant: tab });
    if (search) params.set("search", search);
    if (statusFilter.size > 0) params.set("status", Array.from(statusFilter).join(","));
    // Phase 29: pass date/month filters to export endpoint
    if (dueDateExact) params.set("dueDateExact", dueDateExact);
    if (dueDateFilter.size > 0) params.set("dueDateFilter", Array.from(dueDateFilter).join(","));
    if (approveDateFilter.size > 0) params.set("approveDate", Array.from(approveDateFilter).join(","));
    if (productTypeFilter.size > 0) params.set("productType", Array.from(productTypeFilter).join(","));
    const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
    try {
      const resp = await fetch(`/api/export/debt?${params.toString()}`, {
        credentials: "include",
      });
      if (!resp.ok) {
        const { message } = await resp
          .json()
          .catch(() => ({ message: "Export failed" }));
        toast.error(message, { id: toastId });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `debt_${tab}_${section}_${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลดสำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
   }, [section, tab, search, statusFilter, dueDateExact, dueDateFilter, approveDateFilter, productTypeFilter]);

  // Phase 88: Super Admin can force-clear server-side debt cache
  const [isInvalidating, setIsInvalidating] = useState(false);
  const handleInvalidateCache = React.useCallback(async () => {
    if (!isSuperAdmin) return;
    setIsInvalidating(true);
    try {
      const resp = await fetch("/api/debt/cache/invalidate", {
        method: "POST",
        credentials: "include",
      });
      if (!resp.ok) {
        const { error } = await resp.json().catch(() => ({ error: "Unknown error" }));
        toast.error(`ล้าง cache ไม่สำเร็จ: ${error}`);
        return;
      }
      toast.success("ล้าง server cache สำเร็จ — กำลังโหลดข้อมูลใหม่...");
      // Re-fetch both tabs after cache invalidation
      await fetchStream("target");
      await fetchStream("collected");
    } catch (err) {
      toast.error(`เกิดข้อผิดพลาด: ${(err as Error).message}`);
    } finally {
      setIsInvalidating(false);
    }
  }, [isSuperAdmin, fetchStream]);

  useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        {isSuperAdmin && (
          <button
            onClick={handleInvalidateCache}
            disabled={isInvalidating}
            className="px-3 py-1.5 text-xs bg-amber-100 text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="ล้าง server cache และโหลดข้อมูลใหม่จาก DB (Super Admin only)"
          >
            {isInvalidating ? "กำลังล้าง..." : "ล้าง Cache"}
          </button>
        )}
        <SyncStatusBar />
      </div>,
    );
    return () => setActions(null);
  }, [setActions, isSuperAdmin, handleInvalidateCache, isInvalidating]);

  /* ---- Virtual scroll ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 40;
  const SUB_ROW_HEIGHT = 32;
  // Phase 3: collected tab uses vertical layout
  // estimateSize = ROW_HEIGHT (summary row) + N * SUB_ROW_HEIGHT (detail rows, only when expanded)
  // Phase 125: ใช้ filteredRows ทั้งหมดแทน pagedRows
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      if (tab !== "collected") return ROW_HEIGHT;
      const r = filteredRows[i] as CollectedRow;
      const contractKey = r.contractNo ?? "";
      const isExp = expandedRows.has(contractKey);
      const lines = rowLineCount(r);
      // Summary row always visible; detail rows only when expanded
      return ROW_HEIGHT + (isExp ? lines * SUB_ROW_HEIGHT : 0);
    },
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? totalSize - virtualRows[virtualRows.length - 1].end
    : 0;

  /* ---- Render ---- */
  if (!canView) {
    return (
      <AppShell>
        <div className="p-6 text-gray-500">
          คุณไม่มีสิทธิ์เข้าถึงหน้ารายงานหนี้
        </div>
      </AppShell>
    );
  }

  // Column widths (px) for the left-fixed block.
  // For collected tab, add productType column.
  const LEFT_COLS = tab === "collected"
    ? [
        { key: "approveDate", label: "วันที่อนุมัติ", width: 110 },
        { key: "contractNo", label: "เลขที่สัญญา", width: 195 },
        { key: "customerName", label: "ชื่อ-นามสกุล", width: 260 },
        { key: "phone", label: "เบอร์โทร", width: 110 },
        { key: "productType", label: "ประเภทเครื่อง", width: 110 },
        { key: "totalAmount", label: "ยอดผ่อนรวม", width: 110, align: "right" },
        { key: "installmentCount", label: "งวดผ่อน", width: 70, align: "right" },
        { key: "installmentAmount", label: "ผ่อนงวดละ", width: 100, align: "right" },
        { key: "debtStatus", label: "สถานะหนี้", width: 110 },
        { key: "daysOverdue", label: "เกินกำหนด", width: 90, align: "right" },
      ] as const
    : [
        { key: "approveDate", label: "วันที่อนุมัติ", width: 110 },
        { key: "contractNo", label: "เลขที่สัญญา", width: 195 },
        { key: "customerName", label: "ชื่อ-นามสกุล", width: 260 },
        { key: "phone", label: "เบอร์โทร", width: 110 },
        { key: "totalAmount", label: "ยอดผ่อนรวม", width: 110, align: "right" },
        { key: "installmentCount", label: "งวดผ่อน", width: 70, align: "right" },
        { key: "installmentAmount", label: "ผ่อนงวดละ", width: 100, align: "right" },
        { key: "debtStatus", label: "สถานะหนี้", width: 110 },
        { key: "daysOverdue", label: "เกินกำหนด", width: 90, align: "right" },
      ] as const;

  // Per-period group sub-columns (mirrors reference layout exactly).
  const groupCols =
    tab === "target"
      ? [
          { key: "period", label: "งวดที่", width: 55 },
          { key: "dueDate", label: "วันที่ต้องชำระ", width: 105 },
          { key: "principal", label: "เงินต้น", width: 90, align: "right" },
          { key: "interest", label: "ดอกเบี้ย", width: 90, align: "right" },
          { key: "fee", label: "ค่าดำเนินการ", width: 95, align: "right" },
          // Phase 94: ซ่อน penalty/unlockFee เมื่อ principalOnly=true
          ...(!principalOnly ? [
            { key: "penalty", label: "ค่าปรับ", width: 80, align: "right" },
            { key: "unlockFee", label: "ค่าปลดล็อก", width: 90, align: "right" },
          ] : []),
          { key: "amount", label: "ยอดหนี้รวม", width: 115, align: "right" },
        ]
      : [
          // collected tab: ซ่อน closeInstallmentAmount (ซ้ำซ้อนกับ principal+interest+fee)
          { key: "period", label: "รายการ", width: 55 },
          { key: "paidAt", label: "วันที่ชำระ", width: 100 },
          { key: "principal", label: "เงินต้น", width: 80, align: "right" },
          { key: "interest", label: "ดอกเบี้ย", width: 80, align: "right" },
          { key: "fee", label: "ค่าดำเนินการ", width: 95, align: "right" },
          { key: "penalty", label: "ค่าปรับ", width: 70, align: "right" },
          { key: "unlockFee", label: "ค่าปลดล็อก", width: 80, align: "right" },
          { key: "discount", label: "ส่วนลด", width: 70, align: "right" },
          { key: "overpaid", label: "ชำระเกิน", width: 80, align: "right" },
          { key: "badDebt", label: "หนี้เสีย", width: 80, align: "right" },
          { key: "total", label: "ยอดที่ชำระรวม", width: 100, align: "right" },
          { key: "updatedBy", label: "บันทึกโดย", width: 120 },
          { key: "updatedAt", label: "บันทึกเมื่อ", width: 130 },
        ];

  const GROUP_WIDTH = groupCols.reduce((s, c) => s + c.width, 0);
  const LEFT_WIDTH = LEFT_COLS.reduce((s, c) => s + c.width, 0);
  // Compute sticky left offset for a given column key
  const getStickyLeft = (key: string): number => {
    let offset = 0;
    for (const lc of LEFT_COLS) {
      if (lc.key === key) break;
      if (pinnedCols.has(lc.key)) offset += lc.width;
    }
    return offset;
  };

  return (
    <AppShell>
      <div className="w-full px-3 md:px-5 py-4">
        {/* Tabs (moved to left, replacing title) + Export Excel on right */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Button
              variant={tab === "target" ? "default" : "outline"}
              className={
                tab === "target"
                  ? "bg-amber-600 hover:bg-amber-700 text-white border-amber-600"
                  : "bg-gray-200 hover:bg-gray-300 text-gray-600 border-gray-200"
              }
              onClick={() => setTab("target")}
            >
              <Target className="w-4 h-4 mr-1.5" />
              เป้าเก็บหนี้
            </Button>
            <Button
              variant={tab === "collected" ? "default" : "outline"}
              className={
                tab === "collected"
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600"
                  : "bg-gray-200 hover:bg-gray-300 text-gray-600 border-gray-200"
              }
              onClick={() => setTab("collected")}
            >
              <Coins className="w-4 h-4 mr-1.5" />
              ยอดเก็บหนี้
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {/* ปุ่ม i อธิบายสีตัวเลข */}
            <Button
              variant="outline"
              size="icon"
              className="w-9 h-9 rounded-full border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              onClick={() => setShowColorLegend(true)}
              title="คำอธิบายสีและสัญลักษณ์"
            >
              <Info className="w-4 h-4" />
            </Button>
            {canExport && (
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={handleExport}
              >
                <Download className="w-4 h-4 mr-1.5" />
                Export Excel
              </Button>
            )}
          </div>
        </div>

        {/* Toolbar: Search > ApproveDate > Date > DueDate > Status > ProductType > PrincipalOnly > ตั้งหนี้ (target) | บันทึกโดย (collected) */}
        <div className="flex flex-col gap-2 mb-2">
          <div className="flex flex-col md:flex-row md:items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="ค้นหา: เลขที่สัญญา / ชื่อลูกค้า / เบอร์โทร"
                className="pl-9 bg-white"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* เดือน-ปีที่อนุมัติ (ย้ายมาก่อน วว/ดด/ปปปป) */}
              <MultiSelectFilter
                label="เดือน-ปีที่อนุมัติ"
                selected={approveDateFilter}
                onChange={setApproveDateFilter}
                options={approveDateOptions}
                placeholder="ทุกเดือน-ปีที่อนุมัติ"
              />
              {/* วันที่ (date picker) — target=วันที่ต้องชำระ, collected=วันที่ชำระ */}
              <div className="flex items-center gap-1.5">
                <div className="relative flex items-center">
                  <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <input
                    type="date"
                    value={dueDateExact ?? ""}
                    onChange={(e) => setDueDateExact(e.target.value || null)}
                    className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]"
                    title={tab === "target" ? "วันที่ต้องชำระ" : "วันที่ชำระ"}
                    placeholder={tab === "target" ? "วันที่ต้องชำระ" : "วันที่ชำระ"}
                  />
                </div>
                {dueDateExact && (
                  <button
                    type="button"
                    onClick={() => setDueDateExact(null)}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors"
                    title="ล้างฟิลเตอร์วันที่"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {/* Phase 28: label changes based on tab — target=ต้องชำระ, collected=ชำระ */}
              <MultiSelectFilter
                label={tab === "collected" ? "เดือน-ปีที่ชำระ" : "เดือน-ปีที่ต้องชำระ"}
                selected={dueDateFilter}
                onChange={setDueDateFilter}
                options={dueDateOptions}
                placeholder={tab === "collected" ? "ทุกเดือน-ปีที่ชำระ" : "ทุกเดือน-ปีที่ต้องชำระ"}
              />
              {/* สถานะหนี้ */}
              <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
              {/* ประเภทเครื่อง */}
              <MultiSelectFilter
                label="ประเภทเครื่อง"
                selected={productTypeFilter}
                onChange={setProductTypeFilter}
                options={productTypeOptions}
                placeholder="ทุกประเภทเครื่อง"
              />
              {/* เฉพาะเงินต้น (target tab only) */}
              {tab === "target" && (
                <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5">
                  <Switch id="principal-only" checked={principalOnly} onCheckedChange={setPrincipalOnly} />
                  <label htmlFor="principal-only" className="text-xs text-gray-600 cursor-pointer select-none whitespace-nowrap">
                    เฉพาะเงินต้น
                  </label>
                </div>
              )}
              {/* ตั้งหนี้ (target tab only) — ซ่อนแถวที่ไม่ต้องเก็บ */}
              {tab === "target" && (
                <div
                  className={`flex items-center gap-2 border rounded-md px-3 py-1.5 cursor-pointer select-none transition-colors ${
                    debtSetMode
                      ? "bg-orange-50 border-orange-300"
                      : "bg-white border-gray-200"
                  }`}
                  onClick={() => setDebtSetMode((v) => !v)}
                  title="เปิด: แสดงเฉพาะยอดค้างชำระและยอดที่ยังไม่ได้ชำระถึงงวดปัจจุบัน (ส้ม+ดำ)"
                >
                  <Switch
                    id="debt-set-mode"
                    checked={debtSetMode}
                    onCheckedChange={setDebtSetMode}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <label htmlFor="debt-set-mode" className={`text-xs cursor-pointer whitespace-nowrap ${
                    debtSetMode ? "text-orange-700 font-medium" : "text-gray-600"
                  }`}>
                    ตั้งหนี้
                  </label>
                </div>
              )}
              {/* บันทึกโดย (collected tab only) */}
              {tab === "collected" && updatedByOptions.length > 0 && (
                <div className="relative">
                  <select
                    value={updatedByFilter ?? ""}
                    onChange={(e) => setUpdatedByFilter(e.target.value || null)}
                    className="h-9 pl-3 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none"
                    title="กรองตามผู้บันทึกรายการ"
                  >
                    <option value="">บันทึกโดย: ทั้งหมด</option>
                    {updatedByOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  {updatedByFilter && (
                    <button
                      type="button"
                      onClick={() => setUpdatedByFilter(null)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"
                      title="ล้างตัวกรองบันทึกโดย"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
              {(statusFilter.size > 0 || approveDateFilter.size > 0 || dueDateFilter.size > 0 || productTypeFilter.size > 0 || dueDateExact || updatedByFilter || debtSetMode) && (
                <button
                  type="button"
                  onClick={() => { setStatusFilter(new Set()); setApproveDateFilter(new Set()); setDueDateFilter(new Set()); setProductTypeFilter(new Set()); setDueDateExact(null); setUpdatedByFilter(null); setDebtSetMode(false); }}
                  className="text-xs text-gray-400 hover:text-red-500 underline"
                >
                  ล้างฟิลเตอร์
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Summary line + Summary Badges */}
        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
          <div className="text-xs text-gray-500 self-center">
            ทั้งหมด {activeRows.length.toLocaleString("th-TH")} สัญญา · กรอง{" "}
            {filteredRows.length.toLocaleString("th-TH")} รายการ ·{" "}
            {tab === "target" ? "ข้อมูลเป้าเก็บหนี้" : "ข้อมูลยอดเก็บหนี้"} ของงวดที่{" "}
            1–{maxPeriods || "-"}
          </div>
          {/* Summary Badges */}
          {tab === "target" && targetSummary && (
            <div className="flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                <Banknote className="w-3 h-3" />
                เงินต้น: {fmtMoney(targetSummary.principal)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200">
                <Percent className="w-3 h-3" />
                ดอกเบี้ย: {fmtMoney(targetSummary.interest)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-cyan-50 text-cyan-700 border border-cyan-200">
                <CircleDollarSign className="w-3 h-3" />
                ค่าดำเนินการ: {fmtMoney(targetSummary.fee)}
              </span>
              {!principalOnly && (
                <>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700 border border-red-200">
                    <Gavel className="w-3 h-3" />
                    ค่าปรับ: {fmtMoney(targetSummary.penalty)}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-50 text-orange-700 border border-orange-200">
                    <LockOpen className="w-3 h-3" />
                    ค่าปลดล็อก: {fmtMoney(targetSummary.unlockFee)}
                  </span>
                </>
              )}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                <Target className="w-3 h-3" />
                ยอดหนี้รวม: {fmtMoney(targetSummary.total)}
              </span>
            </div>
          )}
          {tab === "collected" && collectedSummary && (
            <div className="flex flex-wrap gap-1.5">
              {/* Helper: renders a badge with eye toggle. discount badge has canToggle=false */}
              {([
                hasPrincipalBreakdown && { key: "principal", label: "เงินต้น", value: collectedSummary.principal, icon: <Banknote className="w-3 h-3" />, colors: "bg-blue-50 text-blue-700 border-blue-200", canToggle: true },
                hasPrincipalBreakdown && { key: "interest", label: "ดอกเบี้ย", value: collectedSummary.interest, icon: <Percent className="w-3 h-3" />, colors: "bg-purple-50 text-purple-700 border-purple-200", canToggle: true },
                hasPrincipalBreakdown && { key: "fee", label: "ค่าดำเนินการ", value: collectedSummary.fee, icon: <CircleDollarSign className="w-3 h-3" />, colors: "bg-cyan-50 text-cyan-700 border-cyan-200", canToggle: true },
                { key: "penalty", label: "ค่าปรับ", value: collectedSummary.penalty, icon: <Gavel className="w-3 h-3" />, colors: "bg-red-50 text-red-700 border-red-200", canToggle: true },
                { key: "unlockFee", label: "ค่าปลดล็อก", value: collectedSummary.unlockFee, icon: <LockOpen className="w-3 h-3" />, colors: "bg-orange-50 text-orange-700 border-orange-200", canToggle: true },
                { key: "discount", label: "ส่วนลด", value: collectedSummary.discount, icon: <Tag className="w-3 h-3" />, colors: "bg-teal-50 text-teal-700 border-teal-200", canToggle: false },
                { key: "overpaid", label: "ชำระเกิน", value: collectedSummary.overpaid, icon: <TrendingUp className="w-3 h-3" />, colors: "bg-emerald-50 text-emerald-700 border-emerald-200", canToggle: true },
                { key: "badDebt", label: "หนี้เสีย", value: collectedSummary.badDebt, icon: <TrendingDown className="w-3 h-3" />, colors: "bg-red-50 text-red-700 border-red-200", canToggle: true },
              ] as const).filter(Boolean).map((b) => {
                if (!b) return null;
                const isOn = badgeVisibility[b.key] ?? false;
                const dimmed = !isOn;
                return (
                  <span
                    key={b.key}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${b.colors} ${dimmed ? "opacity-40" : ""}`}
                  >
                    {b.icon}
                    {b.label}: {fmtMoney(b.value)}
                    <button
                      type="button"
                      onClick={() => toggleBadge(b.key)}
                      disabled={!b.canToggle}
                      className={`ml-0.5 rounded-full p-0.5 transition-opacity ${b.canToggle ? "hover:opacity-70 cursor-pointer" : "cursor-not-allowed opacity-30"}`}
                      title={!b.canToggle ? "ส่วนลดไม่นำมาคำนวณยอดรวม" : isOn ? "คลิกเพื่อไม่นำมารวมในยอดรวม" : "คลิกเพื่อนำมารวมในยอดรวม"}
                      aria-label={isOn ? `ปิด ${b.label}` : `เปิด ${b.label}`}
                    >
                      {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                  </span>
                );
              })}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                <Wallet className="w-3 h-3" />
                ยอดที่ชำระรวม: {fmtMoney(collectedSummary.total)}
              </span>
            </div>
          )}
        </div>

        {/* Table */}
        {isError ? (
          /* Phase 32: แสดง error state พร้อมปุ่ม retry */
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="text-center">
              <p className="text-sm font-semibold text-red-600 mb-1">โหลดข้อมูลไม่สำเร็จ</p>
              <p className="text-xs text-gray-500 mb-3">
                {typeof queryError === "string" && queryError.includes("aborted")
                  ? "การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองใหม่"
                  : (typeof queryError === "string" ? queryError : "เกิดข้อผิดพลาด กรุณาลองใหม่")}
              </p>
              <button
                onClick={() => refetch()}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors"
              >
                ลองใหม่
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Spinner />
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700">
                {elapsedSec < 5
                  ? "กำลังโหลดข้อมูล..."
                  : elapsedSec < 20
                  ? `กำลังโหลดข้อมูล... (${elapsedSec} วินาที)`
                  : `กำลังประมวลผลข้อมูลจำนวนมาก... (${elapsedSec} วินาที)`}
              </p>
              {/* Phase 42: แสดง hint + progress bar ตั้งแต่วินาทีแรก */}
              <p className="text-xs text-gray-500 mt-1">
                {elapsedSec < 5
                  ? "กำลังเชื่อมต่อ..."
                  : elapsedSec < 20
                  ? "ครั้งถัดไปจะเร็วขึ้นมาก (ข้อมูลถูก cache ไว้)"
                  : "ข้อมูลมีปริมาณมาก กรุณารอสักครู่..."}
              </p>
              {/* Phase 114: แสดง contracts ที่ได้รับระหว่างโหลด */}
              {(tab === "target" ? streamProgress.target : streamProgress.collected) > 0 && (
                <p className="text-xs text-blue-600 mt-1">
                  โหลดแล้ว {(tab === "target" ? streamProgress.target : streamProgress.collected).toLocaleString()} /
                  {" "}{(tab === "target" ? streamTotal.target : streamTotal.collected).toLocaleString()} สัญญา
                </p>
              )}
              <div className="mt-3 w-64 bg-gray-200 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    // Phase 114: Progress bar — ใช้ contracts received / total
                    width: (() => {
                      const received = tab === "target" ? streamProgress.target : streamProgress.collected;
                      const total = tab === "target" ? streamTotal.target : streamTotal.collected;
                      if (total > 0) {
                        return `${Math.min(98, Math.max(5, (received / total) * 100))}%`;
                      }
                      // ยังไม่รู้ total — ใช้ elapsed time
                      return elapsedSec < 5
                        ? `${Math.max(3, (elapsedSec / 5) * 20)}%`
                        : elapsedSec < 20
                        ? `${Math.min(70, 20 + ((elapsedSec - 5) / 15) * 50)}%`
                        : `${Math.min(95, 70 + ((elapsedSec - 20) / 40) * 25)}%`;
                    })(),
                    background: tab === "target" ? "#b45309" : "#047857",
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="border rounded-lg bg-white overflow-auto"
            style={{ maxHeight: "calc(100vh - 280px)" }}
          >
            <div style={{ width: tab === "collected" ? LEFT_WIDTH + GROUP_WIDTH : LEFT_WIDTH + GROUP_WIDTH * maxPeriods }}>
              {/* Header row */}
              <div className="sticky top-0 z-20 bg-white">
                {/* Tier 1: group header over installment columns */}
                <div className="flex border-b bg-slate-100 text-[12px] font-semibold text-slate-700">
                  <div
                    className="bg-slate-100 border-r"
                    style={{ width: LEFT_WIDTH, height: 28 }}
                  />
                  {tab === "collected" ? (
                    // Phase 3: collected tab = single group header (vertical layout)
                    <div
                      className="border-r text-center flex items-center justify-center text-white"
                      style={{ width: GROUP_WIDTH, height: 28, background: "#047857" }}
                    >
                      รายการชำระเงิน
                    </div>
                  ) : (
                    Array.from({ length: maxPeriods }, (_, i) => (
                      <div
                        key={`gh-${i}`}
                        className="border-r text-center flex items-center justify-center text-white"
                        style={{ width: GROUP_WIDTH, height: 28, background: "#b45309" }}
                      >
                        ข้อมูลชำระงวดที่ {i + 1}
                      </div>
                    ))
                  )}
                </div>
                {/* Tier 2: left columns + sub-columns of each group */}
                <div className="flex border-b bg-slate-50 text-[12px] font-semibold text-slate-700">
                  {LEFT_COLS.map((c) => {
                    const isPinned = pinnedCols.has(c.key);
                    return (
                      <div
                        key={c.key}
                        className="px-2 py-1.5 border-r whitespace-nowrap"
                        style={{
                          width: c.width,
                          textAlign: (c as any).align === "right" ? "right" : "left",
                          position: isPinned ? "sticky" : undefined,
                          left: isPinned ? (() => {
                            // compute left offset = sum of widths of all pinned cols before this one
                            let offset = 0;
                            for (const lc of LEFT_COLS) {
                              if (lc.key === c.key) break;
                              if (pinnedCols.has(lc.key)) offset += lc.width;
                            }
                            return offset;
                          })() : undefined,
                          zIndex: isPinned ? 30 : undefined,
                          background: isPinned ? "#dbeafe" : undefined,
                        }}
                      >
                        <div className="flex items-center gap-1 justify-between">
                          <span>{c.label}</span>
                          <button
                            onClick={() => togglePin(c.key)}
                            title={isPinned ? "ยกเลิก sticky" : "ตรึงคอลัมน์นี้"}
                            className={"flex-shrink-0 rounded p-0.5 " + (isPinned ? "text-blue-600 hover:text-blue-800" : "text-gray-300 hover:text-gray-600")}
                          >
                            {isPinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {tab === "collected" ? (
                    // Phase 3: collected tab = single group header columns
                    groupCols.map((gc) => (
                      <div
                        key={`h-c-${gc.key}`}
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: gc.width,
                          textAlign: (gc as any).align === "right" ? "right" : "left",
                          background: "#ecfdf5", // emerald-50
                          color: "#064e3b", // emerald-900
                        }}
                      >
                        {gc.label}
                      </div>
                    ))
                  ) : (
                    Array.from({ length: maxPeriods }, (_, i) =>
                      groupCols.map((gc) => {
                        const subBg = i % 2 === 0 ? "#fffbeb" : "#fef3c7"; // amber-50 / amber-100
                        return (
                          <div
                            key={`h-${i}-${gc.key}`}
                            className="px-2 py-2 border-r whitespace-nowrap"
                            style={{
                              width: gc.width,
                              textAlign: (gc as any).align === "right" ? "right" : "left",
                              background: subBg,
                              color: "#78350f", // amber-900
                            }}
                          >
                            {gc.label}
                          </div>
                        );
                      }),
                    )
                  )}
                </div>
              </div>

              {/* Body (virtualized) */}
              <div style={{ paddingTop, paddingBottom }}>
                {virtualRows.map((vr) => {
                  const r = filteredRows[vr.index];
                  // For collected tab, compute sub-row count to size the row.
                  const lineCount =
                    tab === "collected"
                      ? rowLineCount(r as CollectedRow)
                      : 1;
                  const rowH =
                    ROW_HEIGHT + (lineCount - 1) * SUB_ROW_HEIGHT;
                  // Phase 3: Build filtered payments list for collected tab (vertical layout)
                  // Phase 28: filter payments by paidAt month (dueDateFilter) and exact date (dueDateExact)
                  const filteredPayments: PaymentCell[] = [];
                  if (tab === "collected") {
                    for (const p of (r as CollectedRow).payments ?? []) {
                      // Phase 28: skip payments whose paidAt month is not in dueDateFilter
                      if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
                      // Phase 30: skip payments whose paidAt date does not match dueDateExact
                      if (dueDateExact && p.paidAt?.slice(0, 10) !== dueDateExact) continue;
                      // บันทึกโดย: ซ่อน payment ที่ไม่ใช่ของคนที่เลือก
                      if (updatedByFilter && p.updatedBy !== updatedByFilter) continue;
                      filteredPayments.push(p);
                    }
                  }
                  // Phase 3: Compute summary for collected tab
                  const isExpanded = tab === "collected" && expandedRows.has(r.contractNo ?? "");
                  // Summary row: sum of all filtered payments
                  const summaryPrincipal = filteredPayments.reduce((s, p) => s + (p.principal ?? 0), 0);
                  const summaryInterest = filteredPayments.reduce((s, p) => s + (p.interest ?? 0), 0);
                  const summaryFee = filteredPayments.reduce((s, p) => s + (p.fee ?? 0), 0);
                  const summaryPenalty = filteredPayments.reduce((s, p) => s + (p.penalty ?? 0), 0);
                  const summaryUnlockFee = filteredPayments.reduce((s, p) => s + (p.unlockFee ?? 0), 0);
                  const summaryDiscount = filteredPayments.reduce((s, p) => s + (p.discount ?? 0), 0);
                  const summaryOverpaid = filteredPayments.reduce((s, p) => s + (p.overpaid ?? 0), 0);
                  const summaryBadDebt = filteredPayments.reduce((s, p) => s + (p.badDebt ?? 0), 0);
                  // Phase 89: summaryTotal must include badDebt because badDebtRow has total=0 but badDebt=contractBadDebtAmount
                  const summaryTotal = filteredPayments.reduce((s, p) => s + (p.total ?? 0), 0) + summaryBadDebt;
                  // Latest period = max period with paidAt
                  const latestPay = filteredPayments.filter(p => p.paidAt).sort((a, b) => {
                    if ((a.paidAt ?? "") > (b.paidAt ?? "")) return -1;
                    if ((a.paidAt ?? "") < (b.paidAt ?? "")) return 1;
                    return (b.period ?? 0) - (a.period ?? 0);
                  })[0] ?? null;
                  const summaryPeriod = latestPay?.period ?? null;
                  const summaryPaidAt = latestPay?.paidAt ?? null;
                  // Phase 3: vertical layout height
                  const collectedRowH = tab === "collected"
                    ? ROW_HEIGHT + (isExpanded ? filteredPayments.length * SUB_ROW_HEIGHT : 0)
                    : rowH;
                  return (
                    <div
                      key={vr.key}
                      className={`flex border-b text-[12px] transition-colors cursor-default relative ${
                        hoveredRow === vr.index
                          ? "shadow-[inset_4px_0_0_0_#2563eb,inset_0_-1px_0_0_#93c5fd,0_-1px_0_0_#93c5fd]"
                          : ""
                      }`}
                      style={{ height: tab === "collected" ? collectedRowH : rowH }}
                      onMouseEnter={() => setHoveredRow(vr.index)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      {/* Left fixed columns — no `truncate`: show full text,
                          especially for long contract numbers. */}
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[0].width,
                          position: pinnedCols.has("approveDate") ? "sticky" : undefined,
                          left: pinnedCols.has("approveDate") ? getStickyLeft("approveDate") : undefined,
                          zIndex: pinnedCols.has("approveDate") ? 10 : undefined,
                          background: pinnedCols.has("approveDate") ? "#eff6ff" : undefined,
                        }}
                      >
                        {fmtDate(r.approveDate)}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[1].width,
                          position: pinnedCols.has("contractNo") ? "sticky" : undefined,
                          left: pinnedCols.has("contractNo") ? getStickyLeft("contractNo") : undefined,
                          zIndex: pinnedCols.has("contractNo") ? 10 : undefined,
                          background: pinnedCols.has("contractNo") ? "#eff6ff" : undefined,
                        }}
                        title={r.contractNo ?? undefined}
                      >
                        {r.contractNo ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[2].width,
                          position: pinnedCols.has("customerName") ? "sticky" : undefined,
                          left: pinnedCols.has("customerName") ? getStickyLeft("customerName") : undefined,
                          zIndex: pinnedCols.has("customerName") ? 10 : undefined,
                          background: pinnedCols.has("customerName") ? "#eff6ff" : undefined,
                        }}
                        title={r.customerName ?? undefined}
                      >
                        {r.customerName ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[3].width,
                          position: pinnedCols.has("phone") ? "sticky" : undefined,
                          left: pinnedCols.has("phone") ? getStickyLeft("phone") : undefined,
                          zIndex: pinnedCols.has("phone") ? 10 : undefined,
                          background: pinnedCols.has("phone") ? "#eff6ff" : undefined,
                        }}
                      >
                        {r.phone ?? "-"}
                      </div>
                      {/* productType column — only in collected tab (LEFT_COLS[4] = productType when collected) */}
                      {tab === "collected" && (
                        <div
                          className="px-2 py-2 border-r whitespace-nowrap"
                          style={{
                            width: 110,
                            position: pinnedCols.has("productType") ? "sticky" : undefined,
                            left: pinnedCols.has("productType") ? getStickyLeft("productType") : undefined,
                            zIndex: pinnedCols.has("productType") ? 10 : undefined,
                            background: pinnedCols.has("productType") ? "#eff6ff" : undefined,
                          }}
                        >
                          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                            <Smartphone className="w-3 h-3" />
                            {r.productType ?? "-"}
                          </span>
                        </div>
                      )}
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: tab === "collected" ? LEFT_COLS[5].width : LEFT_COLS[4].width,
                          position: pinnedCols.has("totalAmount") ? "sticky" : undefined,
                          left: pinnedCols.has("totalAmount") ? getStickyLeft("totalAmount") : undefined,
                          zIndex: pinnedCols.has("totalAmount") ? 10 : undefined,
                          background: pinnedCols.has("totalAmount") ? "#eff6ff" : undefined,
                        }}
                      >
                        {fmtMoney(r.totalAmount)}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "installmentCount")?.width ?? 70,
                          position: pinnedCols.has("installmentCount") ? "sticky" : undefined,
                          left: pinnedCols.has("installmentCount") ? getStickyLeft("installmentCount") : undefined,
                          zIndex: pinnedCols.has("installmentCount") ? 10 : undefined,
                          background: pinnedCols.has("installmentCount") ? "#eff6ff" : undefined,
                        }}
                      >
                        {(() => {
                          // งวดล่าสุดที่ค้างชำระ = period ของ isCurrentPeriod installment
                          const currentInst = r.installments.find((inst) => inst.isCurrentPeriod);
                          const latestOverdue = currentInst?.period ?? null;
                          if (latestOverdue != null && r.installmentCount != null) {
                            return `${latestOverdue}/${r.installmentCount}`;
                          }
                          return r.installmentCount ?? "-";
                        })()}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "installmentAmount")?.width ?? 100,
                          position: pinnedCols.has("installmentAmount") ? "sticky" : undefined,
                          left: pinnedCols.has("installmentAmount") ? getStickyLeft("installmentAmount") : undefined,
                          zIndex: pinnedCols.has("installmentAmount") ? 10 : undefined,
                          background: pinnedCols.has("installmentAmount") ? "#eff6ff" : undefined,
                        }}
                      >
                        {fmtMoney(r.installmentAmount)}
                      </div>
                      <div
                        className="px-2 py-1.5 border-r"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "debtStatus")?.width ?? 110,
                          position: pinnedCols.has("debtStatus") ? "sticky" : undefined,
                          left: pinnedCols.has("debtStatus") ? getStickyLeft("debtStatus") : undefined,
                          zIndex: pinnedCols.has("debtStatus") ? 10 : undefined,
                          background: pinnedCols.has("debtStatus") ? "#eff6ff" : undefined,
                        }}
                      >
                        <Badge
                          variant="outline"
                          className={`${statusPillClasses(
                            r.debtStatus,
                          )} font-medium`}
                        >
                          {r.debtStatus}
                        </Badge>
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "daysOverdue")?.width ?? 90,
                          position: pinnedCols.has("daysOverdue") ? "sticky" : undefined,
                          left: pinnedCols.has("daysOverdue") ? getStickyLeft("daysOverdue") : undefined,
                          zIndex: pinnedCols.has("daysOverdue") ? 10 : undefined,
                          background: pinnedCols.has("daysOverdue") ? "#eff6ff" : undefined,
                        }}
                      >
                        {r.daysOverdue > 0 ? r.daysOverdue : 0}
                      </div>
                      {/* Repeating groups: target tab = matrix, collected tab = vertical layout */}
                      {tab === "collected" ? (
                        // Phase 3: Vertical layout for collected tab
                        // Summary row (always visible) + Detail rows (visible when expanded)
                        // Right section: flex-col so summary row + detail rows stack vertically
                        <div className="flex flex-col flex-1">
                          {/* Summary row */}
                          <div className="flex" style={{ height: ROW_HEIGHT }}>
                            {groupCols.map((gc) => {
                              let v: React.ReactNode = "";
                              const hasPayments = filteredPayments.length > 0;
                              switch (gc.key) {
                                case "period":
                                  // Show expand/collapse toggle + payment count
                                  v = (
                                    <button
                                      type="button"
                                      onClick={() => toggleExpand(r.contractNo ?? "")}
                                      className="flex items-center gap-1 text-emerald-700 hover:text-emerald-900 font-semibold"
                                      title={isExpanded ? "ซ่อนรายการ" : "แสดงรายการ"}
                                    >
                                      <ChevronRight
                                        className={`w-3.5 h-3.5 transition-transform ${
                                          isExpanded ? "rotate-90" : ""
                                        }`}
                                      />
                                      {hasPayments ? filteredPayments.length : "-"}
                                    </button>
                                  );
                                  break;
                                case "paidAt":
                                  v = summaryPaidAt ? fmtDate(summaryPaidAt) : "-";
                                  break;
                                case "principal":
                                  v = hasPrincipalBreakdown && summaryPrincipal > 0 ? fmtMoney(summaryPrincipal) : "-";
                                  break;
                                case "interest":
                                  v = hasPrincipalBreakdown && summaryInterest > 0 ? fmtMoney(summaryInterest) : "-";
                                  break;
                                case "fee":
                                  v = hasPrincipalBreakdown && summaryFee > 0 ? fmtMoney(summaryFee) : "-";
                                  break;
                                case "penalty":
                                  v = summaryPenalty > 0 ? fmtMoney(summaryPenalty) : "-";
                                  break;
                                case "unlockFee":
                                  v = summaryUnlockFee > 0 ? fmtMoney(summaryUnlockFee) : "-";
                                  break;
                                case "discount":
                                  v = summaryDiscount > 0 ? fmtMoney(summaryDiscount) : "-";
                                  break;
                                case "overpaid":
                                  v = summaryOverpaid > 0 ? fmtMoney(summaryOverpaid) : "-";
                                  break;
                                case "closeInstallmentAmount":
                                  v = "-";
                                  break;
                                case "badDebt":
                                  v = summaryBadDebt > 0 ? fmtMoney(summaryBadDebt) : "-";
                                  break;
                                case "total":
                                  v = summaryTotal > 0 ? fmtMoney(summaryTotal) : "-";
                                  break;
                                case "updatedBy":
                                case "updatedAt":
                                  v = "-";
                                  break;
                              }
                              const isTotal = gc.key === "total";
                              return (
                                <div
                                  key={`cs-${vr.index}-${gc.key}`}
                                  className={`px-2 border-r flex items-center tabular-nums ${
                                    isTotal ? "font-bold text-emerald-800" : "text-slate-700"
                                  }`}
                                  style={{
                                    width: gc.width,
                                    height: ROW_HEIGHT,
                                    textAlign: (gc as any).align === "right" ? "right" : "left",
                                    justifyContent: (gc as any).align === "right" ? "flex-end" : "flex-start",
                                    background: "#f0fdf4", // green-50
                                  }}
                                >
                                  {v}
                                </div>
                              );
                            })}
                          </div>
                          {/* Detail rows (expanded) */}
                          {isExpanded && filteredPayments.map((pay, li) => (
                            <div
                              key={`cd-${vr.index}-${li}`}
                              className="flex border-t border-dashed border-emerald-100"
                              style={{ height: SUB_ROW_HEIGHT }}
                            >
                              {groupCols.map((gc, gcIdx) => {
                                let v: React.ReactNode = "";
                                const isCloseCell = !!pay.isCloseRow;
                                const isCarryRow = pay.receiptNo === "(carry)";
                                switch (gc.key) {
                                  case "period":
                                    v = pay.period != null
                                      ? `${pay.period}-${(pay.splitIndex ?? 0) + 1}`
                                      : "-";
                                    break;
                                  case "paidAt":
                                    v = fmtDate(pay.paidAt);
                                    break;
                                  case "principal":
                                    v = hasPrincipalBreakdown ? fmtMoney(pay.principal) : "-";
                                    break;
                                  case "interest":
                                    v = hasPrincipalBreakdown ? fmtMoney(pay.interest) : "-";
                                    break;
                                  case "fee":
                                    v = hasPrincipalBreakdown ? fmtMoney(pay.fee) : "-";
                                    break;
                                  case "penalty":
                                    v = fmtMoney(pay.penalty || 0);
                                    break;
                                  case "unlockFee":
                                    v = fmtMoney(pay.unlockFee || 0);
                                    break;
                                  case "discount":
                                    v = fmtMoney(pay.discount || 0);
                                    break;
                                  case "overpaid":
                                    v = fmtMoney(pay.overpaid || 0);
                                    break;
                                  case "closeInstallmentAmount":
                                    v = pay.isCloseRow ? fmtMoney(pay.closeInstallmentAmount) : fmtMoney(0);
                                    break;
                                  case "badDebt":
                                    v = fmtMoney(pay.badDebt || 0);
                                    break;
                                  case "total":
                                    v = fmtMoney(pay.total);
                                    break;
                                  case "updatedBy":
                                    v = pay.updatedBy ?? "-";
                                    break;
                                  case "updatedAt":
                                    v = pay.updatedAt ? fmtDateTime(pay.updatedAt) : "-";
                                    break;
                                }
                                const isZeroish = v === fmtMoney(0) || v === "0" || v === "0.00";
                                let textClass = "";
                                let cellBg: string | undefined;
                                let cellBorderLeft: string | undefined;
                                if (isCarryRow) {
                                  textClass = "text-emerald-700 italic";
                                  cellBg = "#ecfdf5";
                                  cellBorderLeft = gcIdx === 0 ? "4px solid #34d399" : undefined;
                                } else if (isCloseCell) {
                                  textClass = isZeroish ? "text-rose-300 italic" : "text-rose-700";
                                  cellBg = "#fff1f2";
                                  cellBorderLeft = gcIdx === 0 ? "4px solid #fb7185" : undefined;
                                } else if (!isZeroish) {
                                  if (gc.key === "penalty" && (pay.penalty ?? 0) > 0) textClass = "text-red-600";
                                  else if (gc.key === "unlockFee" && (pay.unlockFee ?? 0) > 0) textClass = "text-blue-500";
                                  else if (gc.key === "discount" && (pay.discount ?? 0) > 0) textClass = "text-teal-600";
                                  else if (gc.key === "overpaid" && (pay.overpaid ?? 0) > 0) textClass = "text-emerald-600 font-bold";
                                  else if (gc.key === "badDebt" && (pay.badDebt ?? 0) > 0) textClass = "text-red-700 font-bold";
                                  else if (gc.key === "total") textClass = "font-bold";
                                } else {
                                  textClass = "text-gray-400 italic";
                                }
                                return (
                                  <div
                                    key={`cd-${vr.index}-${li}-${gc.key}`}
                                    className={`px-2 truncate tabular-nums ${textClass}`}
                                    style={{
                                      width: gc.width,
                                      height: SUB_ROW_HEIGHT,
                                      lineHeight: `${SUB_ROW_HEIGHT - 8}px`,
                                      textAlign: (gc as any).align === "right" ? "right" : "left",
                                      background: cellBg,
                                      borderLeft: cellBorderLeft,
                                    }}
                                    title={
                                      gc.key === "badDebt" && pay.isBadDebtRow && pay.badDebtNote
                                        ? pay.badDebtNote
                                        : (pay.remark ?? pay.receiptNo ?? undefined)
                                    }
                                  >
                                    {v}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      ) : Array.from({ length: maxPeriods }, (_, i) => {
                        const periodNo = i + 1;
                        if (tab === "target") {
                          const inst = r.installments[i];
                          const closed = !!inst?.isClosed;
                          const suspended = !!inst?.isSuspended;
                          const suspendLabel = inst?.suspendLabel ?? "ระงับสัญญา";
                          // Grey-out applies to both closed AND suspended cells.
                          const dimmed = closed || suspended;
                          // Phase 93: pre-compute isFuturePeriod+isPaid before cell value block
                          const _todayStrPre = new Date().toISOString().slice(0, 10);
                          const _isFuturePeriodPre = !dimmed && !!inst?.dueDate && inst.dueDate > _todayStrPre;
                          const _isPaidPre = !dimmed && !!inst?.isPaid;
                          // Phase 23: cell-level masking for dueDateFilter and dueDateExact
                          // If a filter is active and this period's dueDate doesn't match,
                          // render the cell as "-" (masked) instead of actual values.
                          const dueDateMonthMasked =
                            dueDateFilter.size > 0 &&
                            !(inst?.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7)));
                          const dueDateExactMasked =
                            !!dueDateExact &&
                            inst?.dueDate?.slice(0, 10) !== dueDateExact;
                          // ตั้งหนี้ masking: ซ่อน installment ที่เป็น dimmed/isPaid/isFuturePeriod/advance
                          const debtSetMasked = debtSetMode && tab === "target" && (
                            dimmed || // isClosed / isSuspended
                            _isPaidPre || // ชำระครบแล้ว (เขียว)
                            _isFuturePeriodPre // ยังไม่ถึงดิว (เทา/ฟ้า-อนาคต)
                          );
                          const isCellMasked = dueDateMonthMasked || dueDateExactMasked || debtSetMasked;
                          return groupCols.map((gc) => {
                            let v: any = "";
                            let annotation: string | null = null;
                            let annotationClass = "";
                            // Phase 23: if cell is masked by date filter, show "-" for all columns
                            // except "period" (always show period number for orientation)
                            if (isCellMasked && gc.key !== "period") {
                              const maskedStyle: Record<string, string | number> = {
                                width: gc.width,
                                textAlign: (gc as any).align === "right" ? "right" : "left",
                                color: "#d1d5db", // gray-300
                              };
                              return (
                                <div
                                  key={`c-${vr.index}-${i}-${gc.key}`}
                                  className="px-2 py-2 border-r whitespace-nowrap"
                                  style={maskedStyle}
                                >
                                  -
                                </div>
                              );
                            }
                            if (inst) {
                              if (gc.key === "period") {
                                // Period number stays visible on closed/suspended rows too.
                                v = inst.period ?? periodNo;
                              } else if (gc.key === "dueDate") {
                                // For suspended/bad-debt: show the status-change date
                                // (suspendedAt) instead of the scheduled due date —
                                // user rule 2026-04-23.
                                if (suspended && inst.suspendedAt) {
                                  v = fmtDate(inst.suspendedAt);
                                } else {
                                  v = fmtDate(inst.dueDate);
                                }
                              } else if (gc.key === "principal") {
                                v = dimmed ? "0" : fmtMoney(inst.principal);
                              } else if (gc.key === "interest") {
                                v = dimmed ? "0" : fmtMoney(inst.interest);
                              } else if (gc.key === "fee") {
                                v = dimmed ? "0" : fmtMoney(inst.fee);
                              } else if (gc.key === "penalty") {
                                // Bug 2 fix (Phase 9AA): Switch เฉพาะเงินต้น applies to ALL periods
                                // including past periods. The "past periods show real values" rule
                                // applies to principal/interest/fee/amount only, NOT penalty/unlockFee.
                                v = dimmed ? "0" : fmtMoney(principalOnly ? 0 : (inst.penalty ?? 0));
                              } else if (gc.key === "unlockFee") {
                                // Bug 2 fix (Phase 9AA): same as penalty — switch applies to all periods
                                v = dimmed ? "0" : fmtMoney(principalOnly ? 0 : (inst.unlockFee ?? 0));
                              } else if (gc.key === "amount") {
                                if (suspended) {
                                  // แสดงลาเบลสถานะในคอลัมน์ยอดรวม
                                  v = suspendLabel;
                                } else if (closed) {
                                  v = "ปิดค่างวดแล้ว";
                                } else {
                                  // Phase 9AJ: always build displayAmount from components
                                  // to ensure penalty/unlockFee from arrears pass are included.
                                  // inst.amount may not reflect accumulated penalty (API value).
                                  const netAmt = inst.netAmount ?? (inst.principal + inst.interest + inst.fee);
                                  const penaltyAmt = principalOnly ? 0 : (inst.penalty ?? 0);
                                  const unlockAmt = principalOnly ? 0 : (inst.unlockFee ?? 0);
                                  const displayAmount = netAmt + penaltyAmt + unlockAmt;
                                  v = fmtMoney(displayAmount);
                                  // Phase 27 fix: ตรวจสอบ overpaidApplied > 0 เพียงอย่างเดียว
                                  // เงื่อนไขเดิม (baselineAmount > amount) ไม่ทำงานเมื่อ penalty ถูกบวกเข้า amount
                                  // ทำให้ amount = baseline แม้จะมีการหักยอดเกินแล้ว
                                  if (inst.overpaidApplied > 0.009) {
                                    annotation = `(-หักชำระเกิน: ${fmtMoney(inst.overpaidApplied)})`;
                                    annotationClass = "text-emerald-600 font-semibold";
                                  }
                                }
                              }
                            }
                            // Phase 93: งวดที่ชำระล่วงหน้าครบแล้ว (isFuturePeriod + isPaid) → แสดง 0.00 ทุกคอลัมน์
                            // เพราะถูกหักออกจากการตั้งหนี้แล้ว (ไม่ใช่ dimmed เพราะยังต้องแสดงวันที่)
                            if (_isFuturePeriodPre && _isPaidPre && gc.key !== "period" && gc.key !== "dueDate") {
                              v = "0.00";
                              annotation = null;
                            }
                            const isArrears = !dimmed && !!inst?.isArrears;
                            // Phase 53/66: ซ่อน BG สีฟ้าสำหรับสัญญาสถานะ ระงับสัญญา / สิ้นสุดสัญญา / ขายเครื่อง / หนี้เสีย
                            const isSpecialContractStatus = r.debtStatus === 'ระงับสัญญา' || r.debtStatus === 'สิ้นสุดสัญญา' || r.debtStatus === 'ขายเครื่อง' || r.debtStatus === 'หนี้เสีย';
                            const isCurrentPeriod = !dimmed && !isSpecialContractStatus && !!inst?.isCurrentPeriod;
                            // Phase 9AI: future period = dueDate > today (not closed/suspended)
                            const todayStr = new Date().toISOString().slice(0, 10);
                            const isFuturePeriod = !dimmed && !isArrears && !isCurrentPeriod &&
                              !!inst?.dueDate && inst.dueDate > todayStr;
                            // Phase 85: isPaid = ชำระครบแล้ว (ใช้ backend isPaid flag)
                            const isPaid = !dimmed && !!inst?.isPaid;
                            // Phase 85: isPartialPaid = จ่ายบางส่วน (paid > 0 แต่ยังไม่ครบ)
                            const paidAmt = inst?.paid ?? 0;
                            const amtForCheck = inst?.amount ?? 0;
                            const isPartialPaid = !dimmed && !isPaid && paidAmt > 0.009 && amtForCheck > 0.009 && paidAmt < amtForCheck - 0.5;
                            const baseStyle: Record<string, string | number> = {
                              width: gc.width,
                              textAlign:
                                (gc as any).align === "right"
                                  ? "right"
                                  : "left",
                            };
                            // Phase 92: Color priority (top = highest priority)
                            // 1. dimmed (isClosed / isSuspended) → เทา + ตัวเอียง
                            // 2. isSpecialContractStatus + isPartialPaid → ส้มเสมอ (ไม่สนใจ dueDate)
                            // 3. isCurrentPeriod + isPartialPaid → BG ฟ้า (sky-50) + ส้ม (เสมอ แม้ isArrears=true)
                            // 4. isCurrentPeriod + isPaid → BG ฟ้า (sky-50) + เขียว
                            // 5. isArrears (ไม่ใช่ isCurrentPeriod+partial/paid) → amber bg + amber bold
                            // 6. isFuturePeriod + isPaid → ฟ้าตัวตรง
                            // 7. isFuturePeriod + isPartialPaid → ฟ้าตัวเอียง (สัญญาปกติเท่านั้น)
                            // 8. isFuturePeriod (paid=0) → เทา
                            // 9. isPaid (งวดก่อนหน้า ชำระครบ) → เขียว
                            // 10. isPartialPaid (งวดก่อนหน้า บางส่วน) → ส้ม
                            // 11. isCurrentPeriod (paid=0) → sky-50 bg + ดำ
                            // 12. งวดก่อนหน้า (paid=0, overdue) → ส้ม
                            if (dimmed) {
                              baseStyle.background = "#f3f4f6"; // gray-100
                              baseStyle.color = "#9ca3af"; // gray-400
                              baseStyle.fontStyle = "italic";
                            } else if (isSpecialContractStatus && isPartialPaid) {
                              // Phase 92: งวดสุดท้ายที่ชำระไม่ครบใน special status → ส้มเสมอ
                              // (ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย / ขายเครื่อง)
                              // ไม่สนใจว่า dueDate ผ่านไปแล้วหรือยัง
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isCurrentPeriod && isPartialPaid) {
                              // งวดปัจจุบัน + ชำระบางส่วน: BG ฟ้า + ส้ม (เสมอ แม้ isArrears=true)
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isCurrentPeriod && isPaid) {
                              // งวดปัจจุบัน + ชำระครบ: BG ฟ้า + เขียว
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#15803d"; // green-700
                            } else if (isArrears) {
                              // Arrears carry (ไม่ใช่ currentPeriod+partial/paid): amber-100 bg + amber-800 bold
                              baseStyle.background = "#fef3c7"; // amber-100
                              baseStyle.color = "#92400e"; // amber-800
                              baseStyle.fontWeight = "700";
                            } else if (isFuturePeriod && isPaid) {
                              // งวดอนาคตที่ชำระครบแล้ว: ฟ้าตัวตรง
                              baseStyle.color = "#0369a1"; // sky-700
                            } else if (isFuturePeriod && isPartialPaid) {
                              // งวดอนาคตที่จ่ายบางส่วน: ฟ้าตัวเอียง
                              baseStyle.color = "#0369a1"; // sky-700
                              baseStyle.fontStyle = "italic";
                            } else if (isFuturePeriod) {
                              // งวดอนาคตที่ยังไม่จ่าย: เทา
                              baseStyle.color = "#9ca3af"; // gray-400
                            } else if (isPaid) {
                              // งวดก่อนหน้าที่ชำระครบแล้ว: เขียว
                              baseStyle.color = "#15803d"; // green-700
                            } else if (isPartialPaid) {
                              // งวดก่อนหน้าที่จ่ายบางส่วน: ส้ม
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isCurrentPeriod) {
                              // งวดปัจจุบัน ยังไม่จ่าย: sky-50 bg + ดำ
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#111827"; // gray-900 (ดำ)
                            } else {
                              // งวดก่อนหน้า ยังไม่จ่าย (overdue): ส้ม (ถือว่าค้างชำระ)
                              baseStyle.color = "#c2410c"; // orange-700
                            }
                            const tooltip = suspended
                              ? suspendLabel
                              : closed
                              ? "ปิดค่างวดแล้ว"
                              : (annotation ?? undefined);
                            return (
                              <div
                                key={`c-${vr.index}-${i}-${gc.key}`}
                                className={
                                  dimmed
                                    ? "px-2 py-2 border-r whitespace-nowrap"
                                    : "px-2 py-2 border-r whitespace-nowrap tabular-nums"
                                }
                                style={baseStyle}
                                title={tooltip}
                              >
                                <div>{v}</div>
                                {annotation && (
                                  <div
                                    className={`text-[10px] leading-tight ${annotationClass}`}
                                  >
                                    {annotation}
                                  </div>
                                )}
                              </div>
                            );
                          });
                        }
                      })}
                    </div>
                  );
                })}
              </div>
              {filteredRows.length === 0 && (
                <div className="text-center py-12 text-gray-500 text-sm">
                  ไม่พบข้อมูล
                </div>
              )}
            </div>
          </div>

        )}

        {/* Phase 125: Pagination removed — ใช้ Virtual Scroll กับ filteredRows ทั้งหมด */}
      </div>

      {/* Color Legend Dialog */}
      <Dialog open={showColorLegend} onOpenChange={setShowColorLegend}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Info className="w-4 h-4 text-blue-500" />
              {tab === "target" ? "คำอธิบายสีตัวเลข — เป้าเก็บหนี้" : "คำอธิบายสีตัวเลข — ยอดเก็บหนี้"}
            </DialogTitle>
          </DialogHeader>

          {tab === "target" ? (
            <div className="space-y-4 text-sm">
              <p className="text-gray-500 text-xs">สีของตัวเลขแต่ละงวดบอกสถานะการชำระเงินของงวดนั้นๆ</p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="text-left p-2 border border-gray-200 font-semibold">สี</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ความหมาย</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ตัวอย่าง</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-green-600 inline-block"></span>
                        <span className="text-green-700 font-semibold">เขียว</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ชำระครบแล้ว</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ลูกค้าจ่ายเงินครบถ้วนแล้ว</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-orange-500 inline-block"></span>
                        <span className="text-orange-700 font-semibold">ส้ม</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ค้างชำระ / เกินกำหนด</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ผ่านวันครบกำหนดแล้วแต่ยังไม่ได้ชำระ</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-900 inline-block"></span>
                        <span className="text-gray-900 font-semibold">ดำ</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ถึงกำหนดชำระวันนี้</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดปัจจุบันที่ยังไม่ได้ชำระ (ตรงกำหนดวันนี้)</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-sky-500 inline-block"></span>
                        <span className="text-sky-700 font-semibold">ฟ้า</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ชำระล่วงหน้า</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ยังไม่ถึงกำหนดแต่ชำระเงินมาแล้ว</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-400 inline-block"></span>
                        <span className="text-gray-500 font-semibold">เทา</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยังไม่ถึงกำหนดชำระ</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดในอนาคตที่ยังไม่ถึงวันกำหนดชำระ</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-300 inline-block border border-gray-400"></span>
                        <span className="text-gray-400 font-semibold italic">เทาอ่อน (ตัวเอียง)</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ปิดค่างวด / ระงับสัญญา</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ถูกปิดค่างวดหรืออยู่ในสัญญาที่ระงับ/สิ้นสุด</td>
                  </tr>
                </tbody>
              </table>

              <div className="mt-3">
                <p className="text-xs font-semibold text-gray-600 mb-2">พื้นหลังแถว (Row Background)</p>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left p-2 border border-gray-200 font-semibold">สีพื้นหลัง</th>
                      <th className="text-left p-2 border border-gray-200 font-semibold">ความหมาย</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-2 border border-gray-200">
                        <span className="inline-block w-16 h-5 rounded" style={{background: '#f0f9ff', border: '1px solid #bae6fd'}}></span>
                        <span className="ml-2 text-sky-700">ฟ้าอ่อน</span>
                      </td>
                      <td className="p-2 border border-gray-200">งวดปัจจุบันที่ต้องชำระ (เดือนนี้)</td>
                    </tr>
                    <tr className="bg-gray-50">
                      <td className="p-2 border border-gray-200">
                        <span className="inline-block w-16 h-5 rounded" style={{background: '#fef3c7', border: '1px solid #fcd34d'}}></span>
                        <span className="ml-2 text-amber-700">เหลืองอ่อน</span>
                      </td>
                      <td className="p-2 border border-gray-200">มีค่าปรับ/ค่าปลดล็อกค้างชำระสะสมจากงวดก่อนหน้า</td>
                    </tr>
                    <tr>
                      <td className="p-2 border border-gray-200">
                        <span className="inline-block w-16 h-5 rounded" style={{background: '#f3f4f6', border: '1px solid #d1d5db'}}></span>
                        <span className="ml-2 text-gray-500">เทาอ่อน</span>
                      </td>
                      <td className="p-2 border border-gray-200">งวดที่ปิดค่างวดแล้ว / สัญญาระงับ</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <p className="text-gray-500 text-xs">สีของตัวเลขแต่ละรายการชำระเงินบอกสถานะของรายการนั้นๆ</p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="text-left p-2 border border-gray-200 font-semibold">สี</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ความหมาย</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ตัวอย่าง</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-900 inline-block"></span>
                        <span className="text-gray-900 font-semibold">ดำ</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดชำระปกติ</td>
                    <td className="p-2 border border-gray-200 text-gray-500">รายการชำระเงินทั่วไป</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-red-500 inline-block"></span>
                        <span className="text-red-600 font-semibold">แดง</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดหนี้เสีย</td>
                    <td className="p-2 border border-gray-200 text-gray-500">รายการที่ถูกตัดสินเป็นหนี้เสีย</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-orange-500 inline-block"></span>
                        <span className="text-orange-600 font-semibold">ส้ม</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดค่าปรับ / ค่าปลดล็อก</td>
                    <td className="p-2 border border-gray-200 text-gray-500">รายการชำระที่มีค่าปรับหรือค่าปลดล็อก</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-blue-500 inline-block"></span>
                        <span className="text-blue-600 font-semibold">น้ำเงิน</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดชำระล่วงหน้า / ยอดเกิน</td>
                    <td className="p-2 border border-gray-200 text-gray-500">ชำระเกินยอดที่ต้องชำระในงวดนั้น</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-green-500 inline-block"></span>
                        <span className="text-green-600 font-semibold">เขียว</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดส่วนลด</td>
                    <td className="p-2 border border-gray-200 text-gray-500">ยอดที่ได้รับส่วนลดจากราคาทุน</td>
                  </tr>
                </tbody>
              </table>

              <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-xs font-semibold text-blue-700 mb-1">หมายเหตุ</p>
                <ul className="text-xs text-blue-600 space-y-1 list-disc list-inside">
                  <li>รายการหนึ่งสัญญาอาจมีหลายสีในครั้งเดียวกัน เช่น ชำระปกติ + ค่าปรับ</li>
                  <li>ตัวเลขสีแดงคือยอดหนี้เสียที่ถูกตัดสินและไม่ต้องชำระแล้ว</li>
                </ul>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}


/**
 * DebtOverview — ภาพรวมหนี้รายเดือน
 * แสดงตารางสรุปต่อเดือน-ปีที่ทำสัญญา
 * ใช้ข้อมูลจาก stream เดียวกับ DebtReport (target + collected)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BadgeDollarSign,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Coins,
  Eye,
  EyeOff,
  FileDown,
  Gavel,
  LockOpen,
  Percent,
  Search,
  Smartphone,
  Tag,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { StreamLoadingOverlay } from "@/components/StreamLoadingOverlay";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */
const DEBT_STATUSES = [
  "ปกติ", "เกิน 1-7", "เกิน 8-14", "เกิน 15-30",
  "เกิน 31-60", "เกิน 61-90", "เกิน >90",
  "ระงับสัญญา", "สิ้นสุดสัญญา", "หนี้เสีย",
] as const;
type DebtStatus = (typeof DEBT_STATUSES)[number];

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const num = Number(n);
  if (num === 0) return "0.00";
  return num.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

/** แปลง YYYY-MM เป็น เดือน-ปี ไทย เช่น "ส.ค. 24" */
function fmtMonthYear(ym: string): string {
  const [y, m] = ym.split("-");
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const monthIdx = parseInt(m, 10) - 1;
  const yearShort = (parseInt(y, 10) + 543).toString().slice(-2);
  return `${MONTHS[monthIdx] ?? m} ${yearShort}`;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
type InstallmentCell = {
  period: number | null;
  dueDate: string | null;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  unlockFee?: number;
  amount: number;
  paid: number;
  baselineAmount: number;
  overpaidApplied: number;
  isClosed: boolean;
  isSuspended?: boolean;
  netAmount?: number;
};
type PaymentCell = {
  period: number | null;
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
  financeAmount?: number | null;   // Phase 9X: ใช้คำนวณ breakdown สำหรับสัญญา suspended
  commissionNet?: number | null;
};
type CollectedRow = TargetRow & { payments: PaymentCell[] };

/* ------------------------------------------------------------------ */
/* MonthMultiSelect                                                    */
/* ------------------------------------------------------------------ */
function MonthMultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
  const displayLabel =
    selected.size === 0 ? label :
    selected.size === 1 ? fmtMonthYear(Array.from(selected)[0]) :
    `${selected.size} เดือน`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[160px] justify-between"
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-[200px] bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.size === 0 ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
              {selected.size === 0 && <Check className="w-3 h-3 text-white" />}
            </span>
            ทั้งหมด
          </button>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
            >
              <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.has(opt) ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
                {selected.has(opt) && <Check className="w-3 h-3 text-white" />}
              </span>
              {fmtMonthYear(opt)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* YearMultiSelect                                                     */
/* ------------------------------------------------------------------ */
function YearMultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
  // แปลง YYYY → ปีพุทธศักราช (2-digit)
  const fmtYear = (y: string) => {
    const be = parseInt(y, 10) + 543;
    return `ปี ${be.toString().slice(-2)}`;
  };
  const displayLabel =
    selected.size === 0 ? label :
    selected.size === 1 ? fmtYear(Array.from(selected)[0]) :
    `${selected.size} ปี`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex items-center gap-2 h-9 px-3 py-2 rounded-md border text-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[130px] justify-between",
          selected.size > 0 ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-700",
        ].join(" ")}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="w-4 h-4 flex-shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-[160px] bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-60 overflow-y-auto">
          <button
            type="button"
            onClick={() => { onChange(new Set()); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.size === 0 ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
              {selected.size === 0 && <Check className="w-3 h-3 text-white" />}
            </span>
            ทั้งหมด
          </button>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
            >
              <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.has(opt) ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
                {selected.has(opt) && <Check className="w-3 h-3 text-white" />}
              </span>
              {fmtYear(opt)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* StatusMultiSelect                                                   */
/* ------------------------------------------------------------------ */
function StatusMultiSelect({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
    selected.size === 0 ? "ทุกสถานะหนี้" :
    selected.size === 1 ? Array.from(selected)[0] :
    `${selected.size} สถานะ`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[160px] justify-between"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-[200px] bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.size === 0 ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
              {selected.size === 0 && <Check className="w-3 h-3 text-white" />}
            </span>
            ทุกสถานะ
          </button>
          {DEBT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
            >
              <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.has(s) ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
                {selected.has(s) && <Check className="w-3 h-3 text-white" />}
              </span>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ProductTypeMultiSelect                                              */
/* ------------------------------------------------------------------ */
function ProductTypeMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
    selected.size === 0 ? "ทุกประเภทเครื่อง" :
    selected.size === 1 ? Array.from(selected)[0] :
    `${selected.size} ประเภท`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[160px] justify-between"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-[200px] bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.size === 0 ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
              {selected.size === 0 && <Check className="w-3 h-3 text-white" />}
            </span>
            ทั้งหมด
          </button>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
            >
              <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.has(opt) ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
                {selected.has(opt) && <Check className="w-3 h-3 text-white" />}
              </span>
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge Row Component                                                 */
/* ------------------------------------------------------------------ */
type BadgeItem = {
  key: string;
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string; // Tailwind bg+text classes
  canToggle?: boolean;
};

function BadgeRow({
  title,
  items,
  visibility,
  onToggle,
  totalLabel,
  totalValue,
  totalColor,
}: {
  title: string;
  items: BadgeItem[];
  visibility: Record<string, boolean>;
  onToggle: (key: string) => void;
  totalLabel: string;
  totalValue: number;
  totalColor: string;
}) {
  return (
    <div className="mb-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 px-1">{title}</div>
      <div className="flex flex-wrap gap-2 items-center">
        {items.map((item) => {
          const visible = visibility[item.key] !== false;
          const canToggle = item.canToggle !== false;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => canToggle && onToggle(item.key)}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all",
                item.color,
                !visible ? "opacity-40" : "",
                canToggle ? "cursor-pointer hover:opacity-80" : "cursor-default",
              ].join(" ")}
              title={canToggle ? (visible ? "คลิกเพื่อซ่อน" : "คลิกเพื่อแสดง") : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
              <span className="font-bold">{fmtMoney(item.value)}</span>
              {canToggle && (visible ? <Eye className="w-3 h-3 ml-0.5" /> : <EyeOff className="w-3 h-3 ml-0.5" />)}
            </button>
          );
        })}
        {/* Total badge */}
        <div className={["flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border", totalColor].join(" ")}>
          <Wallet className="w-3.5 h-3.5" />
          <span>{totalLabel}</span>
          <span>{fmtMoney(totalValue)}</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Per-month aggregated row                                            */
/* ------------------------------------------------------------------ */
type MonthRow = {
  monthKey: string; // YYYY-MM
  contractCount: number;
  // ยอดผ่อนรวม = SUM(baselineAmount) ทุกงวด (principal+interest+fee ก่อนหักชำระเกิน)
  installPrincipal: number;
  installInterest: number;
  installFee: number;
  installTotal: number;
  // เป้าเก็บหนี้ = นับเฉพาะงวดที่ถึงกำหนดแล้ว + ไม่ suspended
  debtTargetPrincipal: number;
  debtTargetInterest: number;
  debtTargetFee: number;
  debtTargetPenalty: number;
  debtTargetUnlockFee: number;
  debtTargetTotal: number;
  // ยอดเก็บหนี้
  collectedPrincipal: number;
  collectedInterest: number;
  collectedFee: number;
  collectedPenalty: number;
  collectedUnlockFee: number;
  collectedDiscount: number;
  collectedOverpaid: number;
  collectedBadDebt: number;
  collectedTotal: number; // computed from visible badges
  // ยอดขายเครื่อง (= badDebt sum)
  deviceSaleAmount: number;
  // ต้นทุน = financeAmount - commissionNet
  cost: number;
  // ยังไม่ถึงกำหนด (principal only, dueDate > today)
  notYetDue: number;
};

/* ------------------------------------------------------------------ */
/* Main Page                                                           */
/* ------------------------------------------------------------------ */
export default function DebtOverview() {
  const { can } = useAppAuth();
  const { section } = useSection();
  const { setActions } = useNavActions();
  const canView = can("debt_overview", "view");

  /* ---- Phase 125: Global Cache ---- */
  const debtCache = useDebtCache();
  // Local loading/error/progress state (UI only — data lives in global cache)
  const [streamLoading, setStreamLoading] = useState({ target: false, collected: false });
  const [streamError, setStreamError] = useState<{ target: string | null; collected: string | null }>({ target: null, collected: null });
  const [streamProgress, setStreamProgress] = useState({ target: 0, collected: 0 });
  const [streamTotal, setStreamTotal] = useState({ target: 0, collected: 0 });
  // อ่านข้อมูลจาก Global Cache
  const cachedEntry = section ? debtCache.getCache(section as any) : { target: null, collected: null, loadedAt: 0 };
  const streamData = { target: cachedEntry.target, collected: cachedEntry.collected };

  /* ---- Filter state (เหมือน DebtReport collected tab) ---- */
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [approveDateFilter, setApproveDateFilter] = useState<Set<string>>(new Set());
  const [dueDateFilter, setDueDateFilter] = useState<Set<string>>(new Set());
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  const [dueDateExact, setDueDateExact] = useState<string | null>(null);
  const [principalOnly, setPrincipalOnly] = useState(false);
  // ฟิลเตอร์ปีที่อนุมัติ (multi-select)
  const [approveYearFilter, setApproveYearFilter] = useState<Set<string>>(new Set());
  // Badge visibility — collected group
  const [badgeVisibility, setBadgeVisibility] = useState<Record<string, boolean>>({
    principal: true,
    interest: true,
    fee: true,
    penalty: true,
    unlockFee: true,
    overpaid: true,
    badDebt: true,
    discount: false,
  });
  // Badge visibility — target group
  const [targetBadgeVisibility, setTargetBadgeVisibility] = useState<Record<string, boolean>>({
    principal: true,
    interest: true,
    fee: true,
    penalty: false,   // default ปิดตา
    unlockFee: false, // default ปิดตา
  });
  // Toggle ยอดขายเครื่อง (มีผลต่อ รายรับรวม)
  const [showDeviceSale, setShowDeviceSale] = useState(true);
  // Sort direction for month column: "asc" = เก่าสุดบนสุด, "desc" = ใหม่สุดบนสุด
  const [monthSortDir, setMonthSortDir] = useState<"asc" | "desc">("asc");
  // Hidden months (eye toggle per row)
  const [hiddenMonths, setHiddenMonths] = useState<Set<string>>(new Set());
  // Export loading state
  const [isExporting, setIsExporting] = useState(false);
  const [showColumnInfo, setShowColumnInfo] = useState(false);
  // ซ่อน/ขยาย Badge section
  const [badgesCollapsed, setBadgesCollapsed] = useState(false);

  const toggleBadge = (key: string) => {
    setBadgeVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const toggleTargetBadge = (key: string) => {
    setTargetBadgeVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /* ---- Phase 122: tRPC chunk loop + retry (CHUNK_SIZE=500 เพื่อลด Cloudflare timeout) ---- */
  const utils = trpc.useUtils();
  const fetchChunkWithRetry = useCallback(async (
    t: "target" | "collected",
    offset: number,
    limit: number,
    maxRetries = 5,
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
          // exponential backoff: 2s, 4s, 8s, 16s (รอ cache warm)
          await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
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
  }, [canView, section, fetchChunkWithRetry, debtCache]);

  // Auto-fetch both streams on mount
  useEffect(() => {
    if (!canView || !section) return;
    if (!streamData.target && !streamLoading.target) fetchStream("target");
    if (!streamData.collected && !streamLoading.collected) fetchStream("collected");
  }, [section, canView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset local UI state when section changes
  // ไม่ล้าง Global Cache เพราะแต่ละ section มี cache แยกกัน
  useEffect(() => {
    setStreamError({ target: null, collected: null });
    setStreamLoading({ target: false, collected: false });
    setStreamProgress({ target: 0, collected: 0 });
    setStreamTotal({ target: 0, collected: 0 });
  }, [section]);

  const isLoading = streamLoading.target || streamLoading.collected;
  const isError = !!streamError.target || !!streamError.collected;

  /* ---- Elapsed time ---- */
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isLoading) { setElapsedSec(0); return; }
    const t0 = Date.now();
    const interval = setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(interval);
  }, [isLoading]);

  const targetRows: TargetRow[] = streamData.target?.rows ?? [];
  const collectedRows: CollectedRow[] = streamData.collected?.rows ?? [];
  const hasPrincipalBreakdown = streamData.collected?.hasPrincipalBreakdown !== false;

  /* ---- Dynamic filter options ---- */
  const allRows = targetRows; // use target rows for filter options (same contracts)
  const approveDateOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of allRows) if (r.approveDate) s.add(r.approveDate.slice(0, 7));
    return Array.from(s).sort().reverse();
  }, [allRows]);

  const approveYearOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of allRows) if (r.approveDate) s.add(r.approveDate.slice(0, 4));
    return Array.from(s).sort().reverse();
  }, [allRows]);

  const dueDateOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of collectedRows) {
      for (const p of r.payments ?? []) if (p.paidAt) s.add(p.paidAt.slice(0, 7));
    }
    return Array.from(s).sort().reverse();
  }, [collectedRows]);

  const productTypeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of allRows) if (r.productType) s.add(r.productType);
    return Array.from(s).sort();
  }, [allRows]);

  /* ---- Filter rows (same logic as DebtReport collected tab) ---- */
  const filteredTargetRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return targetRows.filter((r) => {
      if (approveYearFilter.size > 0 && !(r.approveDate && approveYearFilter.has(r.approveDate.slice(0, 4)))) return false;
      if (approveDateFilter.size > 0 && !(r.approveDate && approveDateFilter.has(r.approveDate.slice(0, 7)))) return false;
      if (dueDateExact) {
        const hasMatch = r.installments.some((inst) => inst.dueDate && inst.dueDate.slice(0, 10) === dueDateExact);
        if (!hasMatch) return false;
      }
      if (dueDateFilter.size > 0) {
        const hasMatch = r.installments.some((inst) => inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7)));
        if (!hasMatch) return false;
      }
      if (statusFilter.size > 0 && !statusFilter.has(r.debtStatus)) return false;
      if (productTypeFilter.size > 0 && !productTypeFilter.has(r.productType ?? "")) return false;
      if (!q) return true;
      return (
        (r.contractNo ?? "").toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q)
      );
    });
  }, [targetRows, search, statusFilter, approveYearFilter, approveDateFilter, dueDateFilter, productTypeFilter, dueDateExact]);

  const filteredCollectedRows = useMemo(() => {
    // กรองตาม contractExternalId ของ filteredTargetRows เสมอ
    // เพื่อให้ยอดเก็บหนี้ตรงกับสัญญาที่แสดงในตาราง (รวมถึงกรณี search เฉพาะสัญญา)
    const targetIds = new Set(filteredTargetRows.map((r) => r.contractExternalId));
    return collectedRows.filter((r) => {
      // ต้องอยู่ใน filteredTargetRows เสมอ
      if (!targetIds.has(r.contractExternalId)) return false;
      if (dueDateExact) {
        const hasMatch = (r.payments ?? []).some((p) => p.paidAt && p.paidAt.slice(0, 10) === dueDateExact);
        if (!hasMatch) return false;
      }
      if (dueDateFilter.size > 0) {
        const hasMatch = (r.payments ?? []).some((p) => p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)));
        if (!hasMatch) return false;
      }
      return true;
    });
  }, [collectedRows, filteredTargetRows, dueDateFilter, dueDateExact]);

  /* ---- Today for "ยังไม่ถึงกำหนด" ---- */
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  /* ---- Cache-based summary (ยอดเก็บหนี้ + ยังไม่ถึงกำหนด จาก DB cache เหมือน MonthlySummary) ---- */
  const approveMonthsForCache = useMemo(() => {
    const months = new Set<string>(approveDateFilter);
    if (approveYearFilter.size > 0) {
      Array.from(approveYearFilter).forEach((yr) => {
        for (let m = 1; m <= 12; m++) {
          months.add(`${yr}-${String(m).padStart(2, "0")}`);
        }
      });
    }
    return months.size > 0 ? Array.from(months).sort() : undefined;
  }, [approveDateFilter, approveYearFilter]);

  const productTypeForCache = useMemo(() => {
    if (productTypeFilter.size === 1) return Array.from(productTypeFilter)[0];
    return undefined;
  }, [productTypeFilter]);

  const cacheSummaryInput = useMemo(() => {
    if (!section) return null;
    return {
      section: section as "Boonphone" | "Fastfone365",
      paidApproveMonths: approveMonthsForCache,
      paidProductType: productTypeForCache,
      notYetDueApproveMonths: approveMonthsForCache,
      notYetDueProductType: productTypeForCache,
    };
  }, [section, approveMonthsForCache, productTypeForCache]);

  const { data: cacheSummaryData } = trpc.monthlySummary.get.useQuery(
    cacheSummaryInput ?? { section: "Boonphone" as const },
    { enabled: !!cacheSummaryInput, staleTime: 5 * 60 * 1000 },
  );

  // Map: approveMonth → { paidTotal, notYetDueTotal, breakdown }
  const cacheByMonth = useMemo(() => {
    const m = new Map<string, {
      paidTotal: number; notYetDueTotal: number;
      principal: number; interest: number; fee: number;
      penalty: number; unlockFee: number; overpaid: number;
    }>();
    if (!cacheSummaryData?.rowsJson) return m;
    try {
      const rows = JSON.parse(cacheSummaryData.rowsJson) as Array<{
        approveMonth: string;
        bucket: string;
        paidTotal: number;
        notYetDueTotal: number;
        paidPrincipal?: number;
        paidInterest?: number;
        paidFee?: number;
        paidPenalty?: number;
        paidUnlockFee?: number;
        paidOverpaid?: number;
      }>;
      for (const r of rows) {
        if (r.bucket !== "__total__") continue;
        m.set(r.approveMonth, {
          paidTotal: r.paidTotal ?? 0,
          notYetDueTotal: r.notYetDueTotal ?? 0,
          principal: r.paidPrincipal ?? 0,
          interest: r.paidInterest ?? 0,
          fee: r.paidFee ?? 0,
          penalty: r.paidPenalty ?? 0,
          unlockFee: r.paidUnlockFee ?? 0,
          overpaid: r.paidOverpaid ?? 0,
        });
      }
    } catch { /* ignore */ }
    return m;
  }, [cacheSummaryData]);

  /* ---- Aggregate by month ---- */
  const monthRows = useMemo(() => {
    const map = new Map<string, MonthRow>();

    const getOrCreate = (monthKey: string): MonthRow => {
      if (!map.has(monthKey)) {
        map.set(monthKey, {
          monthKey,
          contractCount: 0,
          installPrincipal: 0, installInterest: 0, installFee: 0, installTotal: 0,
          debtTargetPrincipal: 0, debtTargetInterest: 0, debtTargetFee: 0, debtTargetPenalty: 0, debtTargetUnlockFee: 0, debtTargetTotal: 0,
          collectedPrincipal: 0, collectedInterest: 0, collectedFee: 0, collectedPenalty: 0,
          collectedUnlockFee: 0, collectedDiscount: 0, collectedOverpaid: 0, collectedBadDebt: 0, collectedTotal: 0,
          deviceSaleAmount: 0,
          cost: 0,
          notYetDue: 0,
        });
      }
      return map.get(monthKey)!;
    };

    // --- Target rows ---
    const seenContracts = new Map<string, string>(); // contractId → monthKey
    for (const r of filteredTargetRows) {
      const monthKey = r.approveDate ? r.approveDate.slice(0, 7) : "ไม่ระบุ";
      const row = getOrCreate(monthKey);

      // นับสัญญา (unique per contract) — รวมทุกสัญญาไม่ว่าจะมีงวดถึงกำหนดหรือไม่
      if (!seenContracts.has(r.contractExternalId)) {
        seenContracts.set(r.contractExternalId, monthKey);
        row.contractCount += 1;
        // ต้นทุน = financeAmount + commissionNet
        const fa = r.financeAmount ?? 0;
        const cn = r.commissionNet ?? 0;
        row.cost += fa + cn;
      }

      // ยังไม่ถึงกำหนด: ยอดค่างวด (principal+interest+fee) ของงวดที่ยังไม่ถึง dueDate
      for (const inst of r.installments) {
        if (inst.isSuspended) continue;
        if (!inst.isClosed) {
          const dueStr = inst.dueDate ? inst.dueDate.slice(0, 10) : null;
          const isFuture = dueStr ? dueStr > todayStr : false;
          if (isFuture) {
            row.notYetDue += (inst.principal ?? 0) + (inst.interest ?? 0) + (inst.fee ?? 0);
          }
        }
      }

      // ยอดผ่อนรวม = installmentAmount × installmentCount (Phase 9AK fix)
      // ไม่ต้องสนใจสถานะงวด เพราะ installmentAmount × installmentCount = ยอดผ่อนรวมตามสัญญาเสมอ
      // Breakdown: Phase 9X ต่องวด × installmentCount
      {
        const finAmt = r.financeAmount ?? 0;
        const installCount = r.installmentCount ?? r.installments.length;
        const instAmt = r.installmentAmount ?? 0;
        if (installCount > 0 && instAmt > 0) {
          if (finAmt > 0) {
            // สูตร Phase 9X: principal/งวด = CEIL(finance / count), fee = 100, interest = instAmt - principal - 100
            const basePrincipal = Math.ceil(finAmt / installCount);
            const baseFee = 100;
            const baseInterest = Math.max(0, instAmt - basePrincipal - baseFee);
            row.installPrincipal += basePrincipal * installCount;
            row.installInterest  += baseInterest  * installCount;
            row.installFee       += baseFee        * installCount;
          } else {
            // fallback: ไม่มี financeAmount ใส่ทั้งหมดใน principal
            row.installPrincipal += instAmt * installCount;
          }
        }
      }

      // เป้าเก็บหนี้ = SUM งวดที่ถึงกำหนดแล้ว (dueDate <= today) และไม่ suspended
      for (const inst of r.installments) {
        if (inst.isSuspended) continue;
        const dueStr = inst.dueDate ? inst.dueDate.slice(0, 10) : null;
        const isDue = dueStr ? dueStr <= todayStr : false;
        if (!isDue) continue;
        row.debtTargetPrincipal += inst.principal ?? 0;
        row.debtTargetInterest  += inst.interest  ?? 0;
        row.debtTargetFee       += inst.fee       ?? 0;
        row.debtTargetPenalty   += inst.penalty   ?? 0;
        row.debtTargetUnlockFee += inst.unlockFee ?? 0;
      }
    }

    // --- Collected rows ---
    for (const r of filteredCollectedRows) {
      const monthKey = r.approveDate ? r.approveDate.slice(0, 7) : "ไม่ระบุ";
      const row = getOrCreate(monthKey);

      for (const p of r.payments ?? []) {
        if (dueDateExact && (p.paidAt?.slice(0, 10) ?? null) !== dueDateExact) continue;
        if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
        row.collectedPrincipal += p.principal ?? 0;
        row.collectedInterest += p.interest ?? 0;
        row.collectedFee += p.fee ?? 0;
        row.collectedPenalty += p.penalty ?? 0;
        row.collectedUnlockFee += p.unlockFee ?? 0;
        row.collectedDiscount += p.discount ?? 0;
        row.collectedOverpaid += p.overpaid ?? 0;
        row.collectedBadDebt += p.badDebt ?? 0;
        row.deviceSaleAmount += p.badDebt ?? 0;
      }
    }

    // Compute totals
    map.forEach((row) => {
      // ยอดผ่อนรวม = SUM(principal+interest+fee) ทุกงวด (baseline)
      const bv = targetBadgeVisibility;
      row.installTotal =
        (bv.principal ? row.installPrincipal : 0) +
        (bv.interest ? row.installInterest : 0) +
        (bv.fee ? row.installFee : 0);

      // เป้าเก็บหนี้ total
      row.debtTargetTotal =
        (bv.principal ? row.debtTargetPrincipal : 0) +
        (bv.interest ? row.debtTargetInterest : 0) +
        (bv.fee ? row.debtTargetFee : 0) +
        (bv.penalty ? row.debtTargetPenalty : 0) +
        (bv.unlockFee ? row.debtTargetUnlockFee : 0);

      const cv = badgeVisibility;
      // ยอดเก็บหนี้ = ค่างวดปกติที่ชำระแล้ว ไม่รวม badDebt (ยอดขายเครื่อง)
      row.collectedTotal =
        (cv.principal ? row.collectedPrincipal : 0) +
        (cv.interest ? row.collectedInterest : 0) +
        (cv.fee ? row.collectedFee : 0) +
        (cv.penalty ? row.collectedPenalty : 0) +
        (cv.unlockFee ? row.collectedUnlockFee : 0) +
        (cv.overpaid ? row.collectedOverpaid : 0);
      // หมายเหตุ: badDebt (ยอดขายเครื่อง) แยกไปอยู่ใน deviceSaleAmount แล้ว ไม่รวมใน collectedTotal

      // Override ด้วยค่าจาก cache (DB) เหมือน MonthlySummary
      // ใช้ cache เฉพาะเมื่อไม่มีการ search/statusFilter ที่ทำให้สัญญาลดลงจากทั้งเดือน
      const isFullMonth = !search.trim() && statusFilter.size === 0;
      const cached = isFullMonth ? cacheByMonth.get(row.monthKey) : undefined;
      if (cached) {
        // ถ้า cache มี breakdown → sync breakdown ลง row และคำนวณ collectedTotal จาก breakdown × badge visibility
        // เพื่อให้ badge toggle มีผลต่อยอดในตารางด้วย
        const hasCacheBreakdown = cached.principal > 0 || cached.interest > 0 || cached.fee > 0 ||
          cached.penalty > 0 || cached.unlockFee > 0 || cached.overpaid > 0;
        if (hasCacheBreakdown) {
          row.collectedPrincipal = cached.principal;
          row.collectedInterest = cached.interest;
          row.collectedFee = cached.fee;
          row.collectedPenalty = cached.penalty;
          row.collectedUnlockFee = cached.unlockFee;
          row.collectedOverpaid = cached.overpaid;
          row.collectedTotal =
            (cv.principal ? cached.principal : 0) +
            (cv.interest ? cached.interest : 0) +
            (cv.fee ? cached.fee : 0) +
            (cv.penalty ? cached.penalty : 0) +
            (cv.unlockFee ? cached.unlockFee : 0) +
            (cv.overpaid ? cached.overpaid : 0);
        } else {
          // fallback: ใช้ paidTotal จาก cache โดยตรง (กรณี breakdown ยังไม่มีใน cache เก่า)
          row.collectedTotal = cached.paidTotal;
        }
        row.notYetDue = cached.notYetDueTotal;
      }
    });

    // Sort by monthKey (default asc = เก่าสุดบนสุด)
    const result: MonthRow[] = [];
    map.forEach((v) => result.push(v));
    return result.sort((a, b) =>
      monthSortDir === "asc"
        ? a.monthKey.localeCompare(b.monthKey)
        : b.monthKey.localeCompare(a.monthKey)
    );
  }, [filteredTargetRows, filteredCollectedRows, principalOnly, dueDateFilter, dueDateExact, badgeVisibility, targetBadgeVisibility, todayStr, monthSortDir, cacheByMonth, search, statusFilter]);

  /* ---- Grand totals (for badge display) ---- */
  const grandInstall = useMemo(() => {
    let principal = 0, interest = 0, fee = 0;
    let debtTargetPrincipal = 0, debtTargetInterest = 0, debtTargetFee = 0, debtTargetPenalty = 0, debtTargetUnlockFee = 0;
    for (const row of monthRows) {
      if (hiddenMonths.has(row.monthKey)) continue;
      principal += row.installPrincipal;
      interest += row.installInterest;
      fee += row.installFee;
      debtTargetPrincipal += row.debtTargetPrincipal;
      debtTargetInterest += row.debtTargetInterest;
      debtTargetFee += row.debtTargetFee;
      debtTargetPenalty += row.debtTargetPenalty;
      debtTargetUnlockFee += row.debtTargetUnlockFee;
    }
    const bv = targetBadgeVisibility;
    // เมื่อ principalOnly=true ให้แสดงยอดเป้าเก็บหนี้ (งวดที่ถึงกำหนดแล้ว) แทนยอดผ่อนรวมทั้งสัญญา
    const displayPrincipal = principalOnly ? debtTargetPrincipal : principal;
    const displayInterest = principalOnly ? debtTargetInterest : interest;
    const displayFee = principalOnly ? debtTargetFee : fee;
    const displayPenalty = principalOnly ? debtTargetPenalty : 0;
    const displayUnlockFee = principalOnly ? debtTargetUnlockFee : 0;
    const total = (bv.principal ? displayPrincipal : 0) + (bv.interest ? displayInterest : 0) + (bv.fee ? displayFee : 0) + (bv.penalty ? displayPenalty : 0) + (bv.unlockFee ? displayUnlockFee : 0);
    return { principal: displayPrincipal, interest: displayInterest, fee: displayFee, penalty: displayPenalty, unlockFee: displayUnlockFee, total };
  }, [monthRows, hiddenMonths, targetBadgeVisibility, principalOnly]);

  const grandCollected = useMemo(() => {
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0, discount = 0, overpaid = 0, badDebt = 0;
    for (const row of monthRows) {
      if (hiddenMonths.has(row.monthKey)) continue;
      principal += row.collectedPrincipal;
      interest += row.collectedInterest;
      fee += row.collectedFee;
      penalty += row.collectedPenalty;
      unlockFee += row.collectedUnlockFee;
      discount += row.collectedDiscount;
      overpaid += row.collectedOverpaid;
      badDebt += row.collectedBadDebt;
    }
    const bv = badgeVisibility;
    const total = (bv.principal ? principal : 0) + (bv.interest ? interest : 0) + (bv.fee ? fee : 0) + (bv.penalty ? penalty : 0) + (bv.unlockFee ? unlockFee : 0) + (bv.overpaid ? overpaid : 0) + (bv.badDebt ? badDebt : 0);
    return { principal, interest, fee, penalty, unlockFee, discount, overpaid, badDebt, total };
  }, [monthRows, hiddenMonths, badgeVisibility]);

  /* ---- TopNav actions ---- */
  useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar />
      </div>,
    );
    return () => setActions(null);
  }, [setActions]);

  /* ---- Render ---- */
  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64 text-gray-500">
          คุณไม่มีสิทธิ์เข้าถึงหน้านี้
        </div>
      </AppShell>
    );
  }

  const hasData = streamData.target !== null && streamData.collected !== null;

  return (
    <AppShell fullHeight>
      {/* ---- Column Info Dialog ---- */}
      <Dialog open={showColumnInfo} onOpenChange={setShowColumnInfo}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Info className="w-4 h-4 text-blue-500" />
              คำอธิบายคอลัมน์ในตารางภาพรวม
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
              {[
              {
                label: "เดือน-ปีที่อนุมัติ",
                color: "bg-slate-100 text-slate-700",
                desc: "เดือนและปีที่อนุมัติสัญญา กดลูกศรที่หัวคอลัมน์เพื่อเรียงลำดับเก่า-ใหม่ได้",
              },
              {
                label: "สัญญา",
                color: "bg-slate-100 text-slate-700",
                desc: "จำนวนสัญญาทั้งหมดที่อนุมัติในเดือนนั้น",
              },
              {
                label: "ยอดผ่อนรวม",
                color: "bg-purple-50 text-purple-700",
                desc: "ยอดรวมที่ลูกค้าต้องชำระตลอดสัญญา (เงินต้น + ดอกเบี้ย + ค่าดำเนินการ ทุกงวด) หากเปิดสวิตช์ 'เป้าเก็บหนี้' จะแสดงเฉพาะยอดของงวดที่ถึงกำหนดชำระแล้ว",
              },
              {
                label: "ยอดเก็บหนี้",
                color: "bg-green-50 text-green-700",
                desc: "ยอดค่างวดที่ลูกค้าชำระเข้ามาแล้ว รวมค่าปรับและค่าปลดล็อก (ถ้ามี) ไม่รวมยอดขายเครื่อง — % ในช่องนี้คืออัตราที่เก็บได้เทียบกับยอดผ่อนรวม (หรือเป้าเก็บหนี้ถ้าเปิดสวิตช์)",
              },
              {
                label: "ยอดขายเครื่อง",
                color: "bg-red-50 text-red-700",
                desc: "ยอดรวมจากการขายเครื่องคืน (หนี้เสีย) กดไอคอนตาที่หัวคอลัมน์เพื่อซ่อน/แสดง — % คือสัดส่วนเทียบกับยอดที่ยังไม่ถึงกำหนดชำระ",
              },
              {
                label: "รายรับรวม",
                color: "bg-emerald-50 text-emerald-700",
                desc: "ยอดเก็บหนี้ + ยอดขายเครื่อง รวมกัน คือรายรับทั้งหมดที่ได้รับจริงในเดือนนั้น — % คือสัดส่วนเทียบกับยอดผ่อนรวมตามสัญญา",
              },
              {
                label: "ต้นทุน",
                color: "bg-slate-50 text-slate-700",
                desc: "ยอดจัดไฟแนนซ์รวมค่าคอมมิชชั่น คือเงินที่บริษัทลงทุนไปกับสัญญาในเดือนนั้น",
              },
              {
                label: "กำไรขั้นต้น",
                color: "bg-amber-50 text-amber-700",
                desc: "รายรับรวม − ต้นทุน ถ้าเป็นบวกคือมีกำไร ถ้าเป็นลบคือยังขาดทุน — % คือสัดส่วนกำไรเทียบกับต้นทุนที่ลงทุนไป",
              },
              {
                label: "ยังไม่ถึงกำหนด",
                color: "bg-sky-50 text-sky-700",
                desc: "ยอดค่างวดของสัญญาที่ยังไม่ถึงวันครบกำหนดชำระ บอกให้รู้ว่ายังมีเงินค้างรับอีกเท่าไหร่ในอนาคต — % คือสัดส่วนเทียบกับยอดผ่อนรวมตามสัญญา",
              },
            ].map(({ label, color, desc }) => (
              <div key={label} className="flex gap-3 items-start">
                <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}</span>
                <span className="text-gray-600 leading-relaxed">{desc}</span>
              </div>
            ))}
            <div className="mt-4 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-500 font-medium mb-2">เคล็ดลับการใช้งาน</p>
              <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
                <li>กดไอคอนตาที่หัวแถวเดือน เพื่อซ่อนเดือนนั้นออกจากยอดรวม</li>
                <li>เปิดสวิตช์ 'เป้าเก็บหนี้' เพื่อดูเฉพาะยอดที่ถึงกำหนดชำระแล้ว</li>
                <li>กด Badge ยอดเก็บหนี้ เพื่อเลือกว่าจะรวมค่าปรับ/ค่าปลดล็อกหรือไม่</li>
                <li>% ในแต่ละช่อง ชี้เมาส์ค้างไว้เพื่อดูรายละเอียดการคำนวณ</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col h-full bg-gray-50 overflow-hidden">
        {/* ---- Header ---- */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingDown className="w-5 h-5 text-blue-600" />
              <h1 className="text-lg font-bold text-gray-900">ภาพรวมหนี้</h1>
              {section && (
                <span className="text-sm text-gray-500 font-normal">— {section}</span>
              )}
              <button
                onClick={() => setShowColumnInfo(true)}
                className="ml-1 text-gray-400 hover:text-blue-500 transition-colors"
                title="คำอธิบายคอลัมน์"
              >
                <Info className="w-4 h-4" />
              </button>
            </div>

          </div>

          {/* ---- Filters ---- */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* ค้นหา */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="ค้นหาสัญญา / ลูกค้า / โทร"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 w-56 text-sm"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X className="w-3.5 h-3.5 text-gray-400" />
                </button>
              )}
            </div>
            {/* เดือน-ปีที่อนุมัติ (ย้ายมาหลัง search box) */}
            <MonthMultiSelect
              label="เดือน-ปีที่อนุมัติ"
              options={approveDateOptions}
              selected={approveDateFilter}
              onChange={setApproveDateFilter}
            />
            {/* ปีที่อนุมัติ (ย้ายมาหลัง search box) */}
            <YearMultiSelect
              label="ปีที่อนุมัติ"
              options={approveYearOptions}
              selected={approveYearFilter}
              onChange={setApproveYearFilter}
            />
            {/* วันที่ */}
            <div className="flex items-center gap-1">
              <CalendarDays className="w-4 h-4 text-gray-400" />
              <input
                type="date"
                value={dueDateExact ?? ""}
                onChange={(e) => setDueDateExact(e.target.value || null)}
                className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {dueDateExact && (
                <button onClick={() => setDueDateExact(null)}>
                  <X className="w-3.5 h-3.5 text-gray-400" />
                </button>
              )}
            </div>
            {/* เดือน-ปีที่ชำระ */}
            <MonthMultiSelect
              label="เดือน-ปีที่ชำระ"
              options={dueDateOptions}
              selected={dueDateFilter}
              onChange={setDueDateFilter}
            />
            {/* สถานะหนี้ */}
            <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
            {/* ประเภทเครื่อง */}
            <ProductTypeMultiSelect options={productTypeOptions} selected={productTypeFilter} onChange={setProductTypeFilter} />
            {/* เป้าเก็บหนี้ toggle */}
            <div className={["flex items-center gap-1.5 h-9 px-3 rounded-md border cursor-pointer select-none", principalOnly ? "border-blue-400 bg-blue-100" : "border-blue-200 bg-blue-50"].join(" ")}
              onClick={() => setPrincipalOnly((v) => !v)}
              title="เปิด: แสดงเฉพาะยอดที่ถึงกำหนดชำระแล้ว (เป้าเก็บหนี้) | ปิด: แสดงยอดผ่อนรวมทั้งหมดตามสัญญา"
            >
              <Switch checked={principalOnly} onCheckedChange={setPrincipalOnly} id="principalOnly" onClick={(e) => e.stopPropagation()} />
              <label htmlFor="principalOnly" className="text-xs text-blue-700 font-medium cursor-pointer">เป้าเก็บหนี้</label>
            </div>
            {/* Export Excel */}
            {hasData && (
              <Button
                variant="default"
                size="sm"
                className="gap-1.5 h-9 text-xs bg-green-600 hover:bg-green-700 text-white border-0"
                disabled={isExporting}
                onClick={async () => {
                  if (!section) return;
                  setIsExporting(true);
                  const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
                  try {
                    const rows = monthRows.filter((r) => !hiddenMonths.has(r.monthKey));
                    const XLSX = await import("xlsx");
                    const wb = XLSX.utils.book_new();
                    const wsData = [
                      ["เดือน-ปีที่อนุมัติ", "สัญญา", "ยอดผ่อนรวม", "ยอดเก็บหนี้", "% เก็บ/ยอดผ่อนรวม", "ยอดขายเครื่อง", "รายรับรวม", "% รายรับรวม/ยอดผ่อนรวม", "ต้นทุน", "กำไรขั้นต้น", "ยังไม่ถึงกำหนด", "% ยังไม่ถึง/ยอดผ่อนรวม"],
                      ...rows.map((r) => {
                        const deviceSale = showDeviceSale ? r.deviceSaleAmount : 0;
                        const revenue = r.collectedTotal + deviceSale;
                        const profit = revenue - r.cost;
                        const pctCollect = r.installTotal > 0 ? Math.round(r.collectedTotal / r.installTotal * 10000) / 100 : 0;
                        const pctRevenue = r.installTotal > 0 ? Math.round(revenue / r.installTotal * 10000) / 100 : 0;
                        const pctNotYetDue = r.installTotal > 0 ? Math.round(r.notYetDue / r.installTotal * 10000) / 100 : 0;
                        return [
                          fmtMonthYear(r.monthKey), r.contractCount, r.installTotal,
                          r.collectedTotal, pctCollect,
                          r.deviceSaleAmount, revenue, pctRevenue,
                          r.cost, profit,
                          r.notYetDue, pctNotYetDue,
                        ];
                      }),
                      // ผลรวม
                      (()=>{
                        const totalInstall=rows.reduce((s,r)=>s+r.installTotal,0);
                        const totalCollect=rows.reduce((s,r)=>s+r.collectedTotal,0);
                        const totalDeviceSale=rows.reduce((s,r)=>s+r.deviceSaleAmount,0);
                        const totalRevenue=rows.reduce((s,r)=>s+r.collectedTotal+(showDeviceSale?r.deviceSaleAmount:0),0);
                        const totalCost=rows.reduce((s,r)=>s+r.cost,0);
                        const totalNotYetDue=rows.reduce((s,r)=>s+r.notYetDue,0);
                        return[
                          "รวมทั้งหมด",
                          rows.reduce((s,r)=>s+r.contractCount,0),
                          totalInstall, totalCollect,
                          totalInstall>0?Math.round(totalCollect/totalInstall*10000)/100:0,
                          totalDeviceSale, totalRevenue,
                          totalInstall>0?Math.round(totalRevenue/totalInstall*10000)/100:0,
                          totalCost, totalRevenue-totalCost,
                          totalNotYetDue,
                          totalInstall>0?Math.round(totalNotYetDue/totalInstall*10000)/100:0,
                        ];
                      })(),
                    ];
                    const ws = XLSX.utils.aoa_to_sheet(wsData);
                    XLSX.utils.book_append_sheet(wb, ws, "ภาพรวมหนี้");
                    XLSX.writeFile(wb, `ภาพรวมหนี้_${section}_${new Date().toISOString().slice(0,10)}.xlsx`);
                    toast.success("ดาวน์โหลดสำเร็จ", { id: toastId });
                  } catch (e: any) {
                    toast.error("เกิดข้อผิดพลาด: " + (e?.message ?? ""), { id: toastId });
                  } finally {
                    setIsExporting(false);
                  }
                }}
              >
                <FileDown className="w-4 h-4" />
                Export Excel
              </Button>
            )}
            {/* Clear all */}
            {(search || statusFilter.size > 0 || approveYearFilter.size > 0 || approveDateFilter.size > 0 || dueDateFilter.size > 0 || productTypeFilter.size > 0 || dueDateExact) && (
              <button
                type="button"
                onClick={() => {
                  setSearch(""); setStatusFilter(new Set()); setApproveYearFilter(new Set()); setApproveDateFilter(new Set());
                  setDueDateFilter(new Set()); setProductTypeFilter(new Set()); setDueDateExact(null);
                }}
                className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded border border-red-200 hover:bg-red-50"
              >
                <X className="w-3 h-3" /> ล้างตัวกรอง
              </button>
            )}
          </div>
        </div>

        {/* ---- Badges ---- */}
        {hasData && (
          <div className="flex-shrink-0 bg-white border-b border-gray-200">
            {/* Toggle badge button */}
            <div className="flex items-center justify-between px-4 pt-2 pb-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">สรุปยอด</span>
              <button
                onClick={() => setBadgesCollapsed((v) => !v)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-0.5 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
                title={badgesCollapsed ? "ขยาย Badge" : "ซ่อน Badge"}
              >
                {badgesCollapsed ? (
                  <><ChevronDown className="w-3.5 h-3.5" /> ขยาย</>
                ) : (
                  <><ChevronUp className="w-3.5 h-3.5" /> ซ่อน</>
                )}
              </button>
            </div>
            {!badgesCollapsed && (
              <div className="px-4 pb-3">
                {/* ยอดผ่อนรวม / เป้าเก็บหนี้ badges */}
                <BadgeRow
                  title={principalOnly ? "เป้าเก็บหนี้" : "ยอดผ่อนรวม"}
                  items={[
                    { key: "principal", label: "เงินต้น", value: grandInstall.principal, icon: <Coins className="w-3.5 h-3.5" />, color: "bg-blue-50 text-blue-800 border-blue-200" },
                    { key: "interest", label: "ดอกเบี้ย", value: grandInstall.interest, icon: <Percent className="w-3.5 h-3.5" />, color: principalOnly ? "bg-blue-50 text-blue-800 border-blue-200" : "bg-purple-50 text-purple-800 border-purple-200" },
                    { key: "fee", label: "ค่าดำเนินการ", value: grandInstall.fee, icon: <Tag className="w-3.5 h-3.5" />, color: principalOnly ? "bg-blue-50 text-blue-800 border-blue-200" : "bg-indigo-50 text-indigo-800 border-indigo-200" },
                    ...(principalOnly ? [
                      { key: "penalty", label: "ค่าปรับ", value: grandInstall.penalty, icon: <Gavel className="w-3.5 h-3.5" />, color: "bg-orange-50 text-orange-800 border-orange-200" },
                      { key: "unlockFee", label: "ค่าปลดล็อก", value: grandInstall.unlockFee, icon: <LockOpen className="w-3.5 h-3.5" />, color: "bg-amber-50 text-amber-800 border-amber-200" },
                    ] : []),
                  ]}
                  visibility={targetBadgeVisibility}
                  onToggle={toggleTargetBadge}
                  totalLabel={principalOnly ? "เป้าเก็บหนี้" : "ยอดผ่อนรวม"}
                  totalValue={grandInstall.total}
                  totalColor={principalOnly ? "bg-blue-600 text-white border-blue-700" : "bg-purple-600 text-white border-purple-700"}
                />
                {/* ยอดเก็บหนี้ badges */}
                <BadgeRow
                  title="ยอดเก็บหนี้"
                  items={[
                    { key: "principal", label: "เงินต้น", value: grandCollected.principal, icon: <Coins className="w-3.5 h-3.5" />, color: "bg-green-50 text-green-800 border-green-200" },
                    { key: "interest", label: "ดอกเบี้ย", value: grandCollected.interest, icon: <Percent className="w-3.5 h-3.5" />, color: "bg-teal-50 text-teal-800 border-teal-200" },
                    { key: "fee", label: "ค่าดำเนินการ", value: grandCollected.fee, icon: <Tag className="w-3.5 h-3.5" />, color: "bg-cyan-50 text-cyan-800 border-cyan-200" },
                    { key: "penalty", label: "ค่าปรับ", value: grandCollected.penalty, icon: <Gavel className="w-3.5 h-3.5" />, color: "bg-yellow-50 text-yellow-800 border-yellow-200" },
                    { key: "unlockFee", label: "ค่าปลดล็อก", value: grandCollected.unlockFee, icon: <LockOpen className="w-3.5 h-3.5" />, color: "bg-lime-50 text-lime-800 border-lime-200" },
                    { key: "overpaid", label: "ชำระเกิน", value: grandCollected.overpaid, icon: <TrendingUp className="w-3.5 h-3.5" />, color: "bg-emerald-50 text-emerald-800 border-emerald-200" },
                    { key: "badDebt", label: "ขายเครื่อง", value: grandCollected.badDebt, icon: <TrendingDown className="w-3.5 h-3.5" />, color: "bg-red-50 text-red-800 border-red-200" },
                    { key: "discount", label: "ส่วนลด", value: grandCollected.discount, icon: <Tag className="w-3.5 h-3.5" />, color: "bg-gray-50 text-gray-600 border-gray-200" },
                  ]}
                  visibility={badgeVisibility}
                  onToggle={toggleBadge}
                  totalLabel="ยอดเก็บหนี้รวม"
                  totalValue={grandCollected.total}
                  totalColor="bg-green-600 text-white border-green-700"
                />
              </div>
            )}
          </div>
        )}

        {/* ---- Loading / Error ---- */}
        {isLoading && (
          <div className="flex-shrink-0 py-4">
            {streamLoading.target && (
              <StreamLoadingOverlay
                loading={true}
                progress={streamProgress.target}
                total={streamTotal.target}
                label={`กำลังโหลดข้อมูลเป้าเก็บหนี้...${elapsedSec > 0 ? ` (${elapsedSec} วินาที)` : ""}`}
                elapsedSec={undefined}
              />
            )}
            {streamLoading.collected && (
              <StreamLoadingOverlay
                loading={true}
                progress={streamProgress.collected}
                total={streamTotal.collected}
                label={`กำลังโหลดข้อมูลยอดเก็บหนี้...${elapsedSec > 0 ? ` (${elapsedSec} วินาที)` : ""}`}
                elapsedSec={undefined}
              />
            )}
          </div>
        )}
        {isError && !isLoading && (
          <div className="flex-shrink-0 flex flex-col items-center justify-center py-16 gap-3 text-red-500">
            <div className="text-sm font-medium">เกิดข้อผิดพลาด</div>
            {streamError.target && <div className="text-xs">{streamError.target}</div>}
            {streamError.collected && <div className="text-xs">{streamError.collected}</div>}
            <Button variant="outline" size="sm" onClick={() => { fetchStream("target"); fetchStream("collected"); }}>
              ลองใหม่
            </Button>
          </div>
        )}

        {/* ---- Table ---- */}
        {!isLoading && hasData && (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
            <div style={{ minWidth: '1200px' }} className="h-full">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-gradient-to-r from-slate-700 to-slate-800 text-white">
                    <th className="px-3 py-3 text-left font-semibold whitespace-nowrap sticky left-0 bg-slate-700 z-10 min-w-[120px]">
                      <button
                        type="button"
                        onClick={() => setMonthSortDir((d) => d === "asc" ? "desc" : "asc")}
                        className="flex items-center gap-1 text-white hover:text-blue-200 transition-colors"
                        title={`เรียงลำดับ: ${`เดือน-ปีที่อนุมัติ ${`เก่าสุดบนสุด`}`}`}
                      >
                        เดือน-ปีที่อนุมัติ
                        {monthSortDir === "asc" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                      </button>
                    </th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[90px]">สัญญา</th>
                    <th className={["px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[160px]", principalOnly ? "bg-blue-700" : "bg-purple-700"].join(" ")}>
                      {principalOnly ? "เป้าเก็บหนี้" : "ยอดผ่อนรวม"}
                    </th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-green-700">ยอดเก็บหนี้</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px]">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setShowDeviceSale((v) => !v)}
                          className="opacity-70 hover:opacity-100 transition-opacity text-white"
                          title={showDeviceSale ? "ซ่อนยอดขายเครื่อง" : "แสดงยอดขายเครื่อง"}
                        >
                          {showDeviceSale ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                        </button>
                        ยอดขายเครื่อง
                      </div>
                    </th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-emerald-800">รายรับรวม</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px]">ต้นทุน</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-amber-700">กำไรขั้นต้น</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-sky-700">ยังไม่ถึงกำหนด</th>
                  </tr>
                </thead>
                <tbody>
                  {monthRows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="text-center py-12 text-gray-400">ไม่มีข้อมูล</td>
                    </tr>
                  )}
                  {monthRows.map((row, idx) => {
                    const isHidden = hiddenMonths.has(row.monthKey);
                    const displayInstall = principalOnly ? row.debtTargetTotal : row.installTotal;
                    const collectionRate = displayInstall > 0 ? (row.collectedTotal / displayInstall) * 100 : 0;
                    const deviceSale = showDeviceSale ? row.deviceSaleAmount : 0;
                    const revenue = row.collectedTotal + deviceSale;
                    const grossProfit = revenue - row.cost;
                    const isEven = idx % 2 === 0;

                    // Color for collection rate
                    const rateBg =
                      collectionRate >= 100 ? "text-green-700 font-bold" :
                      collectionRate >= 80 ? "text-blue-700 font-semibold" :
                      collectionRate >= 60 ? "text-amber-700 font-semibold" :
                      "text-red-600 font-semibold";

                    // Color for gross profit
                    const profitColor = grossProfit > 0 ? "text-emerald-700 font-semibold" : grossProfit < 0 ? "text-red-600 font-semibold" : "text-gray-600";

                    return (
                      <React.Fragment key={row.monthKey}>
                      <tr
                        className={[
                          "border-b border-gray-100 hover:bg-blue-50/40 transition-colors",
                          isHidden ? "opacity-50" : "",
                          isEven ? "bg-white" : "bg-slate-50/60",
                        ].join(" ")}
                      >
                        {/* เดือน + Eye toggle */}
                        <td className={["px-3 py-2.5 font-semibold text-slate-700 sticky left-0 z-10 whitespace-nowrap", isHidden ? "text-gray-400" : "", isEven ? "bg-white" : "bg-slate-50"].join(" ")}>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setHiddenMonths((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.monthKey)) next.delete(row.monthKey);
                                else next.add(row.monthKey);
                                return next;
                              })}
                              className={[
                                "p-0.5 rounded transition-colors flex-shrink-0",
                                hiddenMonths.has(row.monthKey)
                                  ? "text-gray-300 hover:text-gray-500"
                                  : "text-slate-400 hover:text-slate-600",
                              ].join(" ")}
                              title={hiddenMonths.has(row.monthKey) ? "แสดงเดือนนี้" : "ซ่อนเดือนนี้"}
                            >
                              {hiddenMonths.has(row.monthKey)
                                ? <EyeOff className="w-3.5 h-3.5" />
                                : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            {fmtMonthYear(row.monthKey)}
                          </div>
                        </td>
                        {/* จำนวนสัญญา */}
                        <td className="px-3 py-2.5 text-right text-slate-600">
                          <span className={["inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-semibold", isHidden ? "bg-gray-100 text-gray-400" : "bg-slate-100 text-slate-700"].join(" ")}>
                            {row.contractCount.toLocaleString()}
                          </span>
                        </td>
                        {/* ยอดผ่อนรวม / เป้าเก็บหนี้ */}
                        <td className={["px-3 py-2.5 text-right font-medium", principalOnly ? "bg-blue-50/30" : "bg-purple-50/30", isHidden ? "text-gray-400" : principalOnly ? "text-blue-800" : "text-purple-800"].join(" ")}>
                          {principalOnly ? fmtMoney(row.debtTargetTotal) : fmtMoney(row.installTotal)}
                        </td>
                        {/* ยอดเก็บหนี้ + % การเก็บ tag */}
                        <td className={["px-3 py-2.5 text-right font-medium bg-green-50/30", isHidden ? "text-gray-400" : "text-green-800"].join(" ")}>
                          <div className="flex items-center justify-end gap-1.5">
                            <span>{fmtMoney(row.collectedTotal)}</span>
                            {!isHidden && displayInstall > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", collectionRate >= 100 ? "bg-green-100 text-green-700" : collectionRate >= 80 ? "bg-blue-100 text-blue-700" : collectionRate >= 60 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"].join(" ")}>
                                    {fmtPct(collectionRate)}
                                    {collectionRate >= 100 && <TrendingUp className="w-3 h-3 ml-0.5" />}
                                    {collectionRate < 60 && collectionRate > 0 && <TrendingDown className="w-3 h-3 ml-0.5" />}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[260px] text-xs">
                                  <p className="font-semibold mb-1">อัตราการเก็บหนี้</p>
                                  <p className="text-gray-200">เก็บได้จริงเทียบกับ{principalOnly ? "ยอดที่ถึงกำหนดชำระ" : "ยอดผ่อนรวมทั้งหมด"}</p>
                                  <p className="mt-1.5 font-mono">{fmtMoney(row.collectedTotal)} ÷ {fmtMoney(displayInstall)}</p>
                                  <p className="mt-1 text-gray-400 text-[10px]">เขียว ≥100% · น้ำเงิน ≥80% · เหลือง ≥60% · แดง &lt;60%</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                        {/* ยอดขายเครื่อง + % tag */}
                        {(() => {
                          const denominator = row.installTotal - row.debtTargetTotal;
                          const devicePct = denominator > 0 ? (row.deviceSaleAmount / denominator) * 100 : 0;
                          return (
                            <td className={["px-3 py-2.5 text-right", isHidden ? "text-gray-400" : showDeviceSale ? "text-red-700" : "text-gray-300 line-through"].join(" ")}>
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(row.deviceSaleAmount)}</span>
                                {!isHidden && showDeviceSale && denominator > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", devicePct >= 80 ? "bg-green-100 text-green-700" : devicePct >= 60 ? "bg-blue-100 text-blue-700" : devicePct >= 40 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"].join(" ")}>
                                        {fmtPct(devicePct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">สัดส่วนยอดขายเครื่อง</p>
                                      <p className="text-gray-200">ยอดขายเครื่องเทียบกับส่วนที่ยังไม่ถึงกำหนดชำระ</p>
                                      <p className="text-gray-400 text-[10px] mt-0.5">(ยอดผ่อนรวม − ยอดที่ถึงกำหนดแล้ว)</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(row.deviceSaleAmount)} ÷ {fmtMoney(denominator)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">เขียว ≥80% · น้ำเงิน ≥60% · เหลือง ≥40% · แดง &lt;40%</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                        {/* รายรับรวม + % tag */}
                        {(() => {
                          const revenuePct = row.installTotal > 0 ? (revenue / row.installTotal) * 100 : 0;
                          return (
                            <td className={["px-3 py-2.5 text-right font-semibold bg-emerald-50/30", isHidden ? "text-gray-400" : "text-emerald-800"].join(" ")}>
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(revenue)}</span>
                                {!isHidden && row.installTotal > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", revenuePct >= 100 ? "bg-green-100 text-green-700" : revenuePct >= 80 ? "bg-blue-100 text-blue-700" : revenuePct >= 60 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"].join(" ")}>
                                        {fmtPct(revenuePct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">สัดส่วนรายรับรวม</p>
                                      <p className="text-gray-200">รายรับทั้งหมด (เก็บหนี้ + ขายเครื่อง) เทียบกับยอดผ่อนรวมตามสัญญา</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(revenue)} ÷ {fmtMoney(row.installTotal)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">เขียว ≥100% · น้ำเงิน ≥80% · เหลือง ≥60% · แดง &lt;60%</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                        {/* ต้นทุน */}
                        <td className={["px-3 py-2.5 text-right", isHidden ? "text-gray-400" : "text-slate-700"].join(" ")}>
                          {fmtMoney(row.cost)}
                        </td>
                        {/* กำไรขั้นต้น + % tag */}
                        {(() => {
                          const profitPct = row.cost > 0 ? (grossProfit / row.cost) * 100 : 0;
                          return (
                            <td className={["px-3 py-2.5 text-right bg-amber-50/30", isHidden ? "text-gray-400" : profitColor].join(" ")}>
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(grossProfit)}</span>
                                {!isHidden && row.cost > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", profitPct >= 0 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"].join(" ")}>
                                        {fmtPct(profitPct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">อัตรากำไรขั้นต้น</p>
                                      <p className="text-gray-200">กำไรที่ได้ (รายรับ − ต้นทุน) เทียบกับต้นทุนที่ลงทุนไป</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(grossProfit)} ÷ {fmtMoney(row.cost)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">บวก = มีกำไร · ลบ = ขาดทุน</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                        {/* ยังไม่ถึงกำหนด + % tag */}
                        {(() => {
                          const notDuePct = row.installTotal > 0 ? (row.notYetDue / row.installTotal) * 100 : 0;
                          return (
                            <td className={["px-3 py-2.5 text-right font-medium bg-sky-50/30", isHidden ? "text-gray-400" : "text-sky-700"].join(" ")}>
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(row.notYetDue)}</span>
                                {!isHidden && row.installTotal > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help bg-sky-100 text-sky-700">
                                        {fmtPct(notDuePct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">สัดส่วนยอดที่ยังไม่ถึงกำหนด</p>
                                      <p className="text-gray-200">ยอดงวดที่ยังไม่ถึงกำหนดชำระ เทียบกับยอดผ่อนรวมทั้งสัญญา</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(row.notYetDue)} ÷ {fmtMoney(row.installTotal)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">ยิ่งสูง = ลูกค้ายังผ่อนอยู่นาน · ยิ่งต่ำ = ใกล้ปิดสัญญา</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                      </tr>

                      </React.Fragment>
                    );
                  })}
                </tbody>
                {/* Summary row — sticky bottom */}
                {monthRows.length > 0 && (() => {
                  const visibleRows = monthRows.filter((r) => !hiddenMonths.has(r.monthKey));
                  const totalContracts = visibleRows.reduce((s, r) => s + r.contractCount, 0);
                  const totalInstall = visibleRows.reduce((s, r) => s + r.installTotal, 0);
                  const totalCollected = visibleRows.reduce((s, r) => s + r.collectedTotal, 0);
                  const totalDeviceSale = showDeviceSale ? visibleRows.reduce((s, r) => s + r.deviceSaleAmount, 0) : 0;
                  const totalRevenue = totalCollected + totalDeviceSale;
                  const totalCost = visibleRows.reduce((s, r) => s + r.cost, 0);
                  const totalProfit = totalRevenue - totalCost;
                  const totalNotYetDue = visibleRows.reduce((s, r) => s + r.notYetDue, 0);
                  const totalDebtTarget = visibleRows.reduce((s, r) => s + r.debtTargetTotal, 0);
                  const displayTotalInstall = principalOnly ? totalDebtTarget : totalInstall;
                  const overallRate = displayTotalInstall > 0 ? (totalCollected / displayTotalInstall) * 100 : 0;
                  return (
                    <tfoot className="sticky bottom-0 z-20 border-t-2 border-slate-400 shadow-[0_-2px_8px_rgba(0,0,0,0.12)]">
                      <tr className="bg-slate-800 text-white font-bold">
                        <td className="px-3 py-3 sticky left-0 z-30 bg-slate-800">รวมทั้งหมด</td>
                        <td className="px-3 py-3 text-right">
                          <span className="inline-flex items-center justify-center bg-white/20 rounded-full px-2.5 py-0.5 text-xs font-bold">
                            {totalContracts.toLocaleString()}
                          </span>
                        </td>
                        {/* ยอดผ่อนรวม / เป้าเก็บหนี้ */}
                        <td className={["px-3 py-3 text-right", principalOnly ? "text-blue-200" : "text-purple-200"].join(" ")}>
                          {fmtMoney(displayTotalInstall)}
                        </td>
                        {/* ยอดเก็บหนี้รวม + % tag */}
                        <td className="px-3 py-3 text-right text-green-200">
                          <div className="flex items-center justify-end gap-1.5">
                            <span>{fmtMoney(totalCollected)}</span>
                            {displayTotalInstall > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", overallRate >= 100 ? "bg-green-900/60 text-green-200" : overallRate >= 80 ? "bg-blue-900/60 text-blue-200" : overallRate >= 60 ? "bg-amber-900/60 text-amber-200" : "bg-red-900/60 text-red-200"].join(" ")}>
                                    {fmtPct(overallRate)}
                                    {overallRate >= 100 && <TrendingUp className="w-3 h-3 ml-0.5" />}
                                    {overallRate < 60 && overallRate > 0 && <TrendingDown className="w-3 h-3 ml-0.5" />}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[280px] text-xs">
                                  <p className="font-semibold mb-1">อัตราการเก็บหนี้ (ภาพรวม)</p>
                                  <p className="text-gray-200">เก็บได้จริงทั้งหมดเทียบกับ{principalOnly ? "ยอดที่ถึงกำหนดชำระทั้งหมด" : "ยอดผ่อนรวมทุกสัญญา"}</p>
                                  <p className="mt-1.5 font-mono">{fmtMoney(totalCollected)} ÷ {fmtMoney(displayTotalInstall)}</p>
                                  <p className="mt-1 text-gray-400 text-[10px]">เขียว ≥100% · น้ำเงิน ≥80% · เหลือง ≥60% · แดง &lt;60%</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                        {/* ยอดขายเครื่อง + % tag */}
                        {(() => {
                          const totalDenominator = totalInstall - totalDebtTarget;
                          const totalDevicePct = totalDenominator > 0 ? (totalDeviceSale / totalDenominator) * 100 : 0;
                          return (
                            <td className={["px-3 py-3 text-right", showDeviceSale ? "text-red-200" : "text-gray-500"].join(" ")}>
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(totalDeviceSale)}</span>
                                {showDeviceSale && totalDenominator > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", totalDevicePct >= 80 ? "bg-green-900/60 text-green-200" : totalDevicePct >= 60 ? "bg-blue-900/60 text-blue-200" : totalDevicePct >= 40 ? "bg-amber-900/60 text-amber-200" : "bg-red-900/60 text-red-200"].join(" ")}>
                                        {fmtPct(totalDevicePct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">สัดส่วนยอดขายเครื่อง (ภาพรวม)</p>
                                      <p className="text-gray-200">ยอดขายเครื่องทั้งหมดเทียบกับส่วนที่ยังไม่ถึงกำหนดชำระ</p>
                                      <p className="text-gray-400 text-[10px] mt-0.5">(ยอดผ่อนรวม − ยอดที่ถึงกำหนดแล้ว)</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(totalDeviceSale)} ÷ {fmtMoney(totalDenominator)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">เขียว ≥80% · น้ำเงิน ≥60% · เหลือง ≥40% · แดง &lt;40%</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                        {/* รายรับรวม + % tag */}
                        {(() => {
                          const totalRevenuePct = totalInstall > 0 ? (totalRevenue / totalInstall) * 100 : 0;
                          return (
                            <td className="px-3 py-3 text-right text-emerald-200">
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(totalRevenue)}</span>
                                {totalInstall > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", totalRevenuePct >= 100 ? "bg-green-900/60 text-green-200" : totalRevenuePct >= 80 ? "bg-blue-900/60 text-blue-200" : totalRevenuePct >= 60 ? "bg-amber-900/60 text-amber-200" : "bg-red-900/60 text-red-200"].join(" ")}>
                                        {fmtPct(totalRevenuePct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">สัดส่วนรายรับรวม (ภาพรวม)</p>
                                      <p className="text-gray-200">รายรับทั้งหมด (เก็บหนี้ + ขายเครื่อง) เทียบกับยอดผ่อนรวมทุกสัญญา</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(totalRevenue)} ÷ {fmtMoney(totalInstall)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">เขียว ≥100% · น้ำเงิน ≥80% · เหลือง ≥60% · แดง &lt;60%</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                        <td className="px-3 py-3 text-right text-slate-200">{fmtMoney(totalCost)}</td>
                        {/* กำไรขั้นต้น + % tag */}
                        {(() => {
                          const totalProfitPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
                          return (
                            <td className={["px-3 py-3 text-right", totalProfit >= 0 ? "text-amber-200" : "text-red-300"].join(" ")}>
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(totalProfit)}</span>
                                {totalCost > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={["inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help", totalProfitPct >= 0 ? "bg-amber-900/60 text-amber-200" : "bg-red-900/60 text-red-200"].join(" ")}>
                                        {fmtPct(totalProfitPct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[280px] text-xs">
                                      <p className="font-semibold mb-1">อัตรากำไรขั้นต้น (ภาพรวม)</p>
                                      <p className="text-gray-200">กำไรรวมทั้งหมด (รายรับ − ต้นทุน) เทียบกับต้นทุนที่ลงทุนไปทั้งหมด</p>
                                      <p className="mt-1.5 font-mono">{fmtMoney(totalProfit)} ÷ {fmtMoney(totalCost)}</p>
                                      <p className="mt-1 text-gray-400 text-[10px]">บวก = มีกำไร · ลบ = ขาดทุน</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                        {/* ยังไม่ถึงกำหนด + % tag */}
                        {(() => {
                          const totalNotDuePct = totalInstall > 0 ? (totalNotYetDue / totalInstall) * 100 : 0;
                          return (
                            <td className="px-3 py-3 text-right text-sky-200">
                              <div className="flex items-center justify-end gap-1.5">
                                <span>{fmtMoney(totalNotYetDue)}</span>
                                {totalInstall > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center text-sm px-1.5 py-0.5 rounded font-medium cursor-help bg-sky-900/60 text-sky-200">
                                        {fmtPct(totalNotDuePct)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[220px] text-xs">
                                      <p className="font-semibold mb-1">% ยังไม่ถึงกำหนด (รวม)</p>
                                      <p>ยอดที่ยังไม่ถึงกำหนด ÷ ยอดผ่อนรวม</p>
                                      <p className="mt-1 text-gray-300">{fmtMoney(totalNotYetDue)} ÷ {fmtMoney(totalInstall)}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                          );
                        })()}
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>
          </div>
        )}
        {hasData && !isLoading && (
          <div className="flex-shrink-0 px-4 py-1.5 text-xs text-gray-400 text-right bg-white border-t border-gray-100">
            แสดง {monthRows.length} เดือน จาก {filteredTargetRows.length.toLocaleString()} สัญญา (target) / {filteredCollectedRows.length.toLocaleString()} สัญญา (collected)
          </div>
        )}
      </div>
    </AppShell>
  );
}

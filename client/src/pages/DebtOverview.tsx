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
  RefreshCw,
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
  const [principalOnly, setPrincipalOnly] = useState(true);
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
    penalty: true,
    unlockFee: true,
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

  // Map: approveMonth → { paidTotal, notYetDueTotal }
  const cacheByMonth = useMemo(() => {
    const m = new Map<string, { paidTotal: number; notYetDueTotal: number }>();
    if (!cacheSummaryData?.rowsJson) return m;
    try {
      const rows = JSON.parse(cacheSummaryData.rowsJson) as Array<{
        approveMonth: string;
        bucket: string;
        paidTotal: number;
        notYetDueTotal: number;
      }>;
      for (const r of rows) {
        if (r.bucket !== "__total__") continue;
        m.set(r.approveMonth, { paidTotal: r.paidTotal ?? 0, notYetDueTotal: r.notYetDueTotal ?? 0 });
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

      // ยอดผ่อนรวม = ผ่อนงวดละ × จำนวนงวดทั้งหมดตามสัญญา
      // ใช้ r.installmentCount (จาก contract header) เพราะ cache อาจเก็บไม่ครบทุกงวด
      // ใช้งวดแรก (period=1) ที่ไม่ suspended เป็น template ค่าต่องวด
      // หา template งวด: งวดแรก (period=1) ที่ไม่ suspended
      // fallback: งวดแรกที่ไม่ suspended ใดก็ได้
      // fallback สุดท้าย: งวดแรกสุด (แม้ suspended) เพื่อดึง baseline_amount
      const firstInst = r.installments.find((inst) => !inst.isSuspended && inst.period === 1)
        ?? r.installments.find((inst) => !inst.isSuspended)
        ?? r.installments.find((inst) => inst.period === 1)
        ?? r.installments[0];
      const installCount = r.installmentCount ?? r.installments.length;
      if (firstInst && installCount > 0) {
        const pPerPeriod = (firstInst.principal ?? 0);
        const iPerPeriod = (firstInst.interest ?? 0);
        const fPerPeriod = (firstInst.fee ?? 0);
        // ถ้า p+i+f = 0 (เช่น สัญญา suspended ทั้งหมด Phase 9AK)
        // ให้คำนวณ breakdown จากสูตร Phase 9X:
        //   basePrincipal = CEIL(financeAmount / installmentCount)
        //   baseFee       = 100 (ตายตัวต่องวด)
        //   baseInterest  = baselineAmount - basePrincipal - baseFee
        if (pPerPeriod + iPerPeriod + fPerPeriod === 0 && (firstInst.baselineAmount ?? 0) > 0) {
          const baseline = firstInst.baselineAmount ?? 0;
          const finAmt = r.financeAmount ?? 0;
          const periods = installCount;
          if (finAmt > 0 && periods > 0) {
            // สูตร Phase 9X (เหมือนกับ debtDb.ts)
            const basePrincipal = Math.ceil(finAmt / periods);
            const baseFee = 100;
            const baseInterest = Math.max(0, baseline - basePrincipal - baseFee);
            row.installPrincipal += basePrincipal * installCount;
            row.installInterest  += baseInterest  * installCount;
            row.installFee       += baseFee        * installCount;
          } else {
            // fallback: ใส่ทั้งหมดใน principal ถ้าไม่มี financeAmount
            row.installPrincipal += baseline * installCount;
          }
        } else {
          row.installPrincipal += pPerPeriod * installCount;
          row.installInterest += iPerPeriod * installCount;
          row.installFee += fPerPeriod * installCount;
        }
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
        row.collectedTotal = cached.paidTotal;
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
    for (const row of monthRows) {
      if (hiddenMonths.has(row.monthKey)) continue;
      principal += row.installPrincipal;
      interest += row.installInterest;
      fee += row.installFee;
    }
    const bv = targetBadgeVisibility;
    const total = (bv.principal ? principal : 0) + (bv.interest ? interest : 0) + (bv.fee ? fee : 0);
    return { principal, interest, fee, total };
  }, [monthRows, hiddenMonths, targetBadgeVisibility]);

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
                desc: "เดือนและปีที่อนุมัติสัญญา ใช้เป็นตัวกำหนดกลุ่มของสัญญา",
              },
              {
                label: "จำนวนสัญญา",
                color: "bg-slate-100 text-slate-700",
                desc: "จำนวนสัญญาทั้งหมดที่อนุมัติในเดือน-ปีนั้น",
              },
              {
                label: "ยอดผ่อนรวม",
                color: "bg-blue-50 text-blue-700",
                desc: "ยอดรวมที่ลูกค้าต้องผ่อนทั้งสัญญา (SUM ทุกงวด เงินต้น+ดอกเบี้ย+ค่าดำเนินการ ก่อนหักชำระเกิน)",
              },
              {
                label: "ยอดเก็บหนี้",
                color: "bg-green-50 text-green-700",
                desc: "ยอดค่างวดที่ลูกค้าชำระแล้ว ไม่รวมยอดขายเครื่อง",
              },
              {
                label: "อัตราเก็บ",
                color: "bg-purple-50 text-purple-700",
                desc: "ยอดเก็บหนี้ ÷ ยอดผ่อนรวม × 100",
              },
              {
                label: "ยอดขายเครื่อง",
                color: "bg-red-50 text-red-700",
                desc: "ยอดรวมการขายเครื่อง",
              },
              {
                label: "รายรับรวม",
                color: "bg-emerald-50 text-emerald-700",
                desc: "ยอดเก็บหนี้ + ยอดขายเครื่อง (ถ้าเปิดแสดง)",
              },
              {
                label: "ต้นทุน",
                color: "bg-slate-50 text-slate-700",
                desc: "ยอดจัดไฟแนนซ์ + ค่าคอมมิชชั่น",
              },
              {
                label: "กำไรขั้นต้น",
                color: "bg-amber-50 text-amber-700",
                desc: "รายรับรวม − ต้นทุน",
              },
              {
                label: "ยังไม่ถึงกำหนด",
                color: "bg-sky-50 text-sky-700",
                desc: "ยอดเงินต้นของงวดที่ยังไม่ถึงวันครบกำหนดชำระ",
              },
            ].map(({ label, color, desc }) => (
              <div key={label} className="flex gap-3 items-start">
                <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}</span>
                <span className="text-gray-600 leading-relaxed">{desc}</span>
              </div>
            ))}
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // ล้าง Global Cache เพื่อ force refetch
                if (section) debtCache.clearCache(section as any);
                setStreamError({ target: null, collected: null });
                setTimeout(() => {
                  fetchStream("target");
                  fetchStream("collected");
                }, 50);
              }}
              disabled={isLoading}
              className="gap-1.5"
            >
              <RefreshCw className={["w-4 h-4", isLoading ? "animate-spin" : ""].join(" ")} />
              รีเฟรช
            </Button>
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
            {/* เดือน-ปีที่ชำระ (สลับมาก่อน) */}
            <MonthMultiSelect
              label="เดือน-ปีที่ชำระ"
              options={dueDateOptions}
              selected={dueDateFilter}
              onChange={setDueDateFilter}
            />
            {/* เดือน-ปีที่อนุมัติ */}
            <MonthMultiSelect
              label="เดือน-ปีที่อนุมัติ"
              options={approveDateOptions}
              selected={approveDateFilter}
              onChange={setApproveDateFilter}
            />
            {/* ปีที่อนุมัติ (multi-select) */}
            <YearMultiSelect
              label="ปีที่อนุมัติ"
              options={approveYearOptions}
              selected={approveYearFilter}
              onChange={setApproveYearFilter}
            />
            {/* สถานะหนี้ */}
            <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
            {/* ประเภทเครื่อง */}
            <ProductTypeMultiSelect options={productTypeOptions} selected={productTypeFilter} onChange={setProductTypeFilter} />
            {/* เฉพาะเงินต้น toggle */}
            <div className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-gray-200 bg-white cursor-pointer select-none"
              onClick={() => setPrincipalOnly((v) => !v)}
              title="เปิด/ปิด เฉพาะเงินต้น (ไม่รวมค่าปรับ+ค่าปลดล็อกในเป้า)"
            >
              <Switch checked={principalOnly} onCheckedChange={setPrincipalOnly} id="principalOnly" onClick={(e) => e.stopPropagation()} />
              <label htmlFor="principalOnly" className="text-xs text-gray-600 cursor-pointer">เฉพาะเงินต้น</label>
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
                      ["เดือน", "จำนวนสัญญา", "ยอดผ่อนรวม", "ยอดเก็บหนี้", "% การเก็บ", "ยอดขายเครื่อง", "รายรับรวม", "ต้นทุน", "กำไรขั้นต้น", "ยังไม่ถึงกำหนด"],
                      ...rows.map((r) => {
                        const deviceSale = showDeviceSale ? r.deviceSaleAmount : 0;
                        const revenue = r.collectedTotal + deviceSale;
                        const profit = revenue - r.cost;
                        const rate = r.installTotal > 0 ? ((r.collectedTotal / r.installTotal) * 100).toFixed(1) + "%" : "0%";
                        return [
                          fmtMonthYear(r.monthKey), r.contractCount, r.installTotal, r.collectedTotal, rate,
                          r.deviceSaleAmount, revenue, r.cost, profit, r.notYetDue,
                        ];
                      }),
                      // ผลรวม
                      [
                        "รวมทั้งหมด",
                        rows.reduce((s, r) => s + r.contractCount, 0),
                        rows.reduce((s, r) => s + r.installTotal, 0),
                        rows.reduce((s, r) => s + r.collectedTotal, 0),
                        rows.reduce((s, r) => s + r.installTotal, 0) > 0
                          ? (rows.reduce((s, r) => s + r.collectedTotal, 0) / rows.reduce((s, r) => s + r.installTotal, 0) * 100).toFixed(1) + "%"
                          : "0%",
                        rows.reduce((s, r) => s + r.deviceSaleAmount, 0),
                        rows.reduce((s, r) => s + r.collectedTotal + (showDeviceSale ? r.deviceSaleAmount : 0), 0),
                        rows.reduce((s, r) => s + r.cost, 0),
                        rows.reduce((s, r) => s + r.collectedTotal + (showDeviceSale ? r.deviceSaleAmount : 0) - r.cost, 0),
                        rows.reduce((s, r) => s + r.notYetDue, 0),
                      ],
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
                {/* ยอดผ่อนรวม badges */}
                <BadgeRow
                  title="ยอดผ่อนรวม"
                  items={[
                    { key: "principal", label: "เงินต้น", value: grandInstall.principal, icon: <Coins className="w-3.5 h-3.5" />, color: "bg-blue-50 text-blue-800 border-blue-200" },
                    { key: "interest", label: "ดอกเบี้ย", value: grandInstall.interest, icon: <Percent className="w-3.5 h-3.5" />, color: "bg-purple-50 text-purple-800 border-purple-200" },
                    { key: "fee", label: "ค่าดำเนินการ", value: grandInstall.fee, icon: <Tag className="w-3.5 h-3.5" />, color: "bg-indigo-50 text-indigo-800 border-indigo-200" },
                  ]}
                  visibility={targetBadgeVisibility}
                  onToggle={toggleTargetBadge}
                  totalLabel="ยอดผ่อนรวม"
                  totalValue={grandInstall.total}
                  totalColor="bg-blue-600 text-white border-blue-700"
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
                        title={`เรียงลำดับ: ${`เดือน ${`เก่าสุดบนสุด`}`}`}
                      >
                        เดือน
                        {monthSortDir === "asc" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                      </button>
                    </th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[90px]">จำนวนสัญญา</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-blue-700">ยอดผ่อนรวม</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-green-700">ยอดเก็บหนี้</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[90px]">% การเก็บ</th>
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
                      <td colSpan={11} className="text-center py-12 text-gray-400">ไม่มีข้อมูล</td>
                    </tr>
                  )}
                  {monthRows.map((row, idx) => {
                    const isHidden = hiddenMonths.has(row.monthKey);
                    const collectionRate = row.installTotal > 0 ? (row.collectedTotal / row.installTotal) * 100 : 0;
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
                        {/* ยอดผ่อนรวม */}
                        <td className={["px-3 py-2.5 text-right font-medium bg-blue-50/30", isHidden ? "text-gray-400" : "text-blue-800"].join(" ")}>
                          {fmtMoney(row.installTotal)}
                        </td>
                        {/* ยอดเก็บหนี้ */}
                        <td className={["px-3 py-2.5 text-right font-medium bg-green-50/30", isHidden ? "text-gray-400" : "text-green-800"].join(" ")}>
                          {fmtMoney(row.collectedTotal)}
                        </td>
                        {/* % การเก็บ */}
                        <td className={["px-3 py-2.5 text-right", isHidden ? "text-gray-400" : rateBg].join(" ")}>
                          <div className="flex items-center justify-end gap-1">
                            {fmtPct(collectionRate)}
                            {!isHidden && collectionRate >= 100 && <TrendingUp className="w-3.5 h-3.5 text-green-600" />}
                            {!isHidden && collectionRate < 60 && collectionRate > 0 && <TrendingDown className="w-3.5 h-3.5 text-red-500" />}
                          </div>
                        </td>
                        {/* ยอดขายเครื่อง */}
                        <td className={["px-3 py-2.5 text-right", isHidden ? "text-gray-400" : showDeviceSale ? "text-red-700" : "text-gray-300 line-through"].join(" ")}>
                          {fmtMoney(row.deviceSaleAmount)}
                        </td>
                        {/* รายรับรวม */}
                        <td className={["px-3 py-2.5 text-right font-semibold bg-emerald-50/30", isHidden ? "text-gray-400" : "text-emerald-800"].join(" ")}>
                          {fmtMoney(revenue)}
                        </td>
                        {/* ต้นทุน */}
                        <td className={["px-3 py-2.5 text-right", isHidden ? "text-gray-400" : "text-slate-700"].join(" ")}>
                          {fmtMoney(row.cost)}
                        </td>
                        {/* กำไรขั้นต้น */}
                        <td className={["px-3 py-2.5 text-right bg-amber-50/30", isHidden ? "text-gray-400" : profitColor].join(" ")}>
                          {fmtMoney(grossProfit)}
                        </td>
                        {/* ยังไม่ถึงกำหนด */}
                        <td className={["px-3 py-2.5 text-right font-medium bg-sky-50/30", isHidden ? "text-gray-400" : "text-sky-700"].join(" ")}>
                          {fmtMoney(row.notYetDue)}
                        </td>
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
                  const overallRate = totalInstall > 0 ? (totalCollected / totalInstall) * 100 : 0;
                  return (
                    <tfoot className="sticky bottom-0 z-20 border-t-2 border-slate-400 shadow-[0_-2px_8px_rgba(0,0,0,0.12)]">
                      <tr className="bg-slate-800 text-white font-bold">
                        <td className="px-3 py-3 sticky left-0 z-30 bg-slate-800">รวมทั้งหมด</td>
                        <td className="px-3 py-3 text-right">
                          <span className="inline-flex items-center justify-center bg-white/20 rounded-full px-2.5 py-0.5 text-xs font-bold">
                            {totalContracts.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-blue-200">{fmtMoney(totalInstall)}</td>
                        <td className="px-3 py-3 text-right text-green-200">{fmtMoney(totalCollected)}</td>
                        <td className="px-3 py-3 text-right text-yellow-200">{fmtPct(overallRate)}</td>
                        <td className={["px-3 py-3 text-right", showDeviceSale ? "text-red-200" : "text-gray-500"].join(" ")}>{fmtMoney(totalDeviceSale)}</td>
                        <td className="px-3 py-3 text-right text-emerald-200">{fmtMoney(totalRevenue)}</td>
                        <td className="px-3 py-3 text-right text-slate-200">{fmtMoney(totalCost)}</td>
                        <td className={["px-3 py-3 text-right", totalProfit >= 0 ? "text-amber-200" : "text-red-300"].join(" ")}>{fmtMoney(totalProfit)}</td>
                        <td className="px-3 py-3 text-right text-sky-200">{fmtMoney(totalNotYetDue)}</td>
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

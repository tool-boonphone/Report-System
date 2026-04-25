/**
 * DebtOverview — ภาพรวมหนี้รายเดือน
 * แสดงตารางสรุปต่อเดือน-ปีที่ทำสัญญา
 * ใช้ข้อมูลจาก stream เดียวกับ DebtReport (target + collected)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
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
  financeAmount?: number | null;
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
                !visible ? "opacity-40 line-through" : "",
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
  // เป้าเก็บหนี้
  targetPrincipal: number;
  targetInterest: number;
  targetFee: number;
  targetPenalty: number;
  targetUnlockFee: number;
  targetTotal: number;
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
  // ยังไม่ครบกำหนด (principal only, dueDate > today)
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

  /* ---- Stream state ---- */
  const [streamData, setStreamData] = useState<{
    target: { rows: TargetRow[] } | null;
    collected: { rows: CollectedRow[]; hasPrincipalBreakdown: boolean } | null;
  }>({ target: null, collected: null });
  const [streamLoading, setStreamLoading] = useState({ target: false, collected: false });
  const [streamError, setStreamError] = useState<{ target: string | null; collected: string | null }>({ target: null, collected: null });
  const [streamProgress, setStreamProgress] = useState({ target: 0, collected: 0 });

  /* ---- Filter state (เหมือน DebtReport collected tab) ---- */
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [approveDateFilter, setApproveDateFilter] = useState<Set<string>>(new Set());
  const [dueDateFilter, setDueDateFilter] = useState<Set<string>>(new Set());
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  const [dueDateExact, setDueDateExact] = useState<string | null>(null);
  const [principalOnly, setPrincipalOnly] = useState(true);
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

  const toggleBadge = (key: string) => {
    setBadgeVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const toggleTargetBadge = (key: string) => {
    setTargetBadgeVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /* ---- Fetch stream ---- */
  const fetchStream = useCallback(async (t: "target" | "collected") => {
    if (!canView || !section) return;
    setStreamLoading((prev) => ({ ...prev, [t]: true }));
    setStreamError((prev) => ({ ...prev, [t]: null }));
    setStreamProgress((prev) => ({ ...prev, [t]: 0 }));
    try {
      const resp = await fetch(`/api/debt/stream/${t}?section=${encodeURIComponent(section)}`, {
        credentials: "include",
        signal: AbortSignal.timeout(300_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      const reader = resp.body?.getReader();
      if (!reader) {
        const json = await resp.json();
        setStreamData((prev) => ({ ...prev, [t]: json }));
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let bytesReceived = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesReceived += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        setStreamProgress((prev) => ({ ...prev, [t]: bytesReceived }));
      }
      buffer += decoder.decode();
      const json = JSON.parse(buffer);
      setStreamData((prev) => ({ ...prev, [t]: json }));
    } catch (err: any) {
      setStreamError((prev) => ({ ...prev, [t]: err?.message ?? "เกิดข้อผิดพลาด" }));
    } finally {
      setStreamLoading((prev) => ({ ...prev, [t]: false }));
    }
  }, [canView, section]);

  // Auto-fetch both streams on mount
  useEffect(() => {
    if (!canView || !section) return;
    if (!streamData.target && !streamLoading.target) fetchStream("target");
    if (!streamData.collected && !streamLoading.collected) fetchStream("collected");
  }, [section, canView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset when section changes
  useEffect(() => {
    setStreamData({ target: null, collected: null });
    setStreamError({ target: null, collected: null });
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
  }, [targetRows, search, statusFilter, approveDateFilter, dueDateFilter, productTypeFilter, dueDateExact]);

  const filteredCollectedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return collectedRows.filter((r) => {
      if (approveDateFilter.size > 0 && !(r.approveDate && approveDateFilter.has(r.approveDate.slice(0, 7)))) return false;
      if (dueDateExact) {
        const hasMatch = (r.payments ?? []).some((p) => p.paidAt && p.paidAt.slice(0, 10) === dueDateExact);
        if (!hasMatch) return false;
      }
      if (dueDateFilter.size > 0) {
        const hasMatch = (r.payments ?? []).some((p) => p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)));
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
  }, [collectedRows, search, statusFilter, approveDateFilter, dueDateFilter, productTypeFilter, dueDateExact]);

  /* ---- Today for "ยังไม่ครบกำหนด" ---- */
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  /* ---- Aggregate by month ---- */
  const monthRows = useMemo(() => {
    const map = new Map<string, MonthRow>();

    const getOrCreate = (monthKey: string): MonthRow => {
      if (!map.has(monthKey)) {
        map.set(monthKey, {
          monthKey,
          contractCount: 0,
          targetPrincipal: 0, targetInterest: 0, targetFee: 0, targetPenalty: 0, targetUnlockFee: 0, targetTotal: 0,
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

      // นับสัญญา (unique per contract)
      if (!seenContracts.has(r.contractExternalId)) {
        seenContracts.set(r.contractExternalId, monthKey);
        row.contractCount += 1;
        // ต้นทุน = financeAmount - commissionNet
        const fa = r.financeAmount ?? 0;
        const cn = r.commissionNet ?? 0;
        row.cost += fa - cn;
      }

      // เป้าเก็บหนี้ — sum installments ที่ผ่าน filter
      // หมายเหตุ: isClosed installments ยังอาจมี penalty/unlockFee ค้างอยู่
      for (const inst of r.installments) {
        if (inst.isSuspended) continue;
        if (dueDateFilter.size > 0 && !(inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7)))) continue;
        if (dueDateExact && inst.dueDate?.slice(0, 10) !== dueDateExact) continue;
        if (!inst.isClosed) {
          // งวดที่ยังไม่ปิด: sum ทุก component
          row.targetPrincipal += inst.principal ?? 0;
          row.targetInterest += inst.interest ?? 0;
          row.targetFee += inst.fee ?? 0;
          // ยังไม่ครบกำหนด: principal only, dueDate > today
          if (inst.dueDate && inst.dueDate.slice(0, 10) > todayStr) {
            row.notYetDue += inst.principal ?? 0;
          }
        }
        // penalty/unlockFee: sum จากทุกงวด (รวม isClosed) เพราะอาจมีค้างอยู่
        row.targetPenalty += principalOnly ? 0 : (inst.penalty ?? 0);
        row.targetUnlockFee += principalOnly ? 0 : (inst.unlockFee ?? 0);
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
      const bv = targetBadgeVisibility;
      row.targetTotal =
        (bv.principal ? row.targetPrincipal : 0) +
        (bv.interest ? row.targetInterest : 0) +
        (bv.fee ? row.targetFee : 0) +
        (bv.penalty ? row.targetPenalty : 0) +
        (bv.unlockFee ? row.targetUnlockFee : 0);

      const cv = badgeVisibility;
      row.collectedTotal =
        (cv.principal ? row.collectedPrincipal : 0) +
        (cv.interest ? row.collectedInterest : 0) +
        (cv.fee ? row.collectedFee : 0) +
        (cv.penalty ? row.collectedPenalty : 0) +
        (cv.unlockFee ? row.collectedUnlockFee : 0) +
        (cv.overpaid ? row.collectedOverpaid : 0) +
        (cv.badDebt ? row.collectedBadDebt : 0);
    });

    // Sort by monthKey (default asc = เก่าสุดบนสุด)
    const result: MonthRow[] = [];
    map.forEach((v) => result.push(v));
    return result.sort((a, b) =>
      monthSortDir === "asc"
        ? a.monthKey.localeCompare(b.monthKey)
        : b.monthKey.localeCompare(a.monthKey)
    );
  }, [filteredTargetRows, filteredCollectedRows, principalOnly, dueDateFilter, dueDateExact, badgeVisibility, targetBadgeVisibility, todayStr, monthSortDir]);

  /* ---- Grand totals (for badge display) ---- */
  const grandTarget = useMemo(() => {
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0;
    for (const row of monthRows) {
      principal += row.targetPrincipal;
      interest += row.targetInterest;
      fee += row.targetFee;
      penalty += row.targetPenalty;
      unlockFee += row.targetUnlockFee;
    }
    const bv = targetBadgeVisibility;
    const total = (bv.principal ? principal : 0) + (bv.interest ? interest : 0) + (bv.fee ? fee : 0) + (bv.penalty ? penalty : 0) + (bv.unlockFee ? unlockFee : 0);
    return { principal, interest, fee, penalty, unlockFee, total };
  }, [monthRows, targetBadgeVisibility]);

  const grandCollected = useMemo(() => {
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0, discount = 0, overpaid = 0, badDebt = 0;
    for (const row of monthRows) {
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
  }, [monthRows, badgeVisibility]);

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
    <AppShell>
      <div className="flex flex-col h-full bg-gray-50">
        {/* ---- Header ---- */}
        <div className="bg-white border-b border-gray-200 px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingDown className="w-5 h-5 text-blue-600" />
              <h1 className="text-lg font-bold text-gray-900">ภาพรวมหนี้</h1>
              {section && (
                <span className="text-sm text-gray-500 font-normal">— {section}</span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStreamData({ target: null, collected: null });
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
            {/* เดือน-ปีที่อนุมัติ */}
            <MonthMultiSelect
              label="เดือน-ปีที่อนุมัติ"
              options={approveDateOptions}
              selected={approveDateFilter}
              onChange={setApproveDateFilter}
            />
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
                variant="outline"
                size="sm"
                className="gap-1.5 h-9 text-xs"
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
                      ["เดือน", "จำนวนสัญญา", "เป้าเก็บหนี้", "ยอดเก็บหนี้", "% การเก็บ", "ยอดขายเครื่อง", "รายรับรวม", "ต้นทุน", "กำไรขั้นต้น", "ยังไม่ครบกำหนด"],
                      ...rows.map((r) => {
                        const deviceSale = showDeviceSale ? r.deviceSaleAmount : 0;
                        const revenue = r.collectedTotal + deviceSale;
                        const profit = revenue - r.cost;
                        const rate = r.targetTotal > 0 ? ((r.collectedTotal / r.targetTotal) * 100).toFixed(1) + "%" : "0%";
                        return [
                          fmtMonthYear(r.monthKey), r.contractCount, r.targetTotal, r.collectedTotal, rate,
                          r.deviceSaleAmount, revenue, r.cost, profit, r.notYetDue,
                        ];
                      }),
                      // ผลรวม
                      [
                        "รวมทั้งหมด",
                        rows.reduce((s, r) => s + r.contractCount, 0),
                        rows.reduce((s, r) => s + r.targetTotal, 0),
                        rows.reduce((s, r) => s + r.collectedTotal, 0),
                        rows.reduce((s, r) => s + r.targetTotal, 0) > 0
                          ? (rows.reduce((s, r) => s + r.collectedTotal, 0) / rows.reduce((s, r) => s + r.targetTotal, 0) * 100).toFixed(1) + "%"
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
            {(search || statusFilter.size > 0 || approveDateFilter.size > 0 || dueDateFilter.size > 0 || productTypeFilter.size > 0 || dueDateExact) && (
              <button
                type="button"
                onClick={() => {
                  setSearch(""); setStatusFilter(new Set()); setApproveDateFilter(new Set());
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
          <div className="bg-white border-b border-gray-200 px-4 py-3">
            {/* เป้าเก็บหนี้ badges */}
            <BadgeRow
              title="เป้าเก็บหนี้"
              items={[
                { key: "principal", label: "เงินต้น", value: grandTarget.principal, icon: <Coins className="w-3.5 h-3.5" />, color: "bg-blue-50 text-blue-800 border-blue-200" },
                { key: "interest", label: "ดอกเบี้ย", value: grandTarget.interest, icon: <Percent className="w-3.5 h-3.5" />, color: "bg-purple-50 text-purple-800 border-purple-200" },
                { key: "fee", label: "ค่าดำเนินการ", value: grandTarget.fee, icon: <Tag className="w-3.5 h-3.5" />, color: "bg-indigo-50 text-indigo-800 border-indigo-200" },
                { key: "penalty", label: "ค่าปรับ", value: grandTarget.penalty, icon: <Gavel className="w-3.5 h-3.5" />, color: "bg-orange-50 text-orange-800 border-orange-200" },
                { key: "unlockFee", label: "ค่าปลดล็อก", value: grandTarget.unlockFee, icon: <LockOpen className="w-3.5 h-3.5" />, color: "bg-amber-50 text-amber-800 border-amber-200" },
              ]}
              visibility={targetBadgeVisibility}
              onToggle={toggleTargetBadge}
              totalLabel="เป้าเก็บหนี้รวม"
              totalValue={grandTarget.total}
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
                { key: "badDebt", label: "หนี้เสีย", value: grandCollected.badDebt, icon: <TrendingDown className="w-3.5 h-3.5" />, color: "bg-red-50 text-red-800 border-red-200" },
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

        {/* ---- Loading / Error ---- */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-500">
            <Spinner className="w-8 h-8 text-blue-500" />
            <div className="text-sm">
              กำลังโหลดข้อมูล{elapsedSec > 0 ? ` (${elapsedSec}s)` : ""}…
            </div>
            <div className="text-xs text-gray-400 flex gap-4">
              {streamLoading.target && <span>เป้าเก็บหนี้: {(streamProgress.target / 1024).toFixed(0)} KB</span>}
              {streamLoading.collected && <span>ยอดเก็บหนี้: {(streamProgress.collected / 1024).toFixed(0)} KB</span>}
            </div>
          </div>
        )}
        {isError && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-red-500">
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
          <div className="flex-1 overflow-auto px-4 py-3">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <table className="w-full text-sm border-collapse min-w-[1200px]">
                <thead>
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
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-blue-800">เป้าเก็บหนี้</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px] bg-green-800">ยอดเก็บหนี้</th>
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
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[140px]">ยังไม่ครบกำหนด</th>
                    <th className="px-3 py-3 text-center font-semibold whitespace-nowrap text-white min-w-[50px]">แสดง</th>
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
                    const collectionRate = row.targetTotal > 0 ? (row.collectedTotal / row.targetTotal) * 100 : 0;
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
                          isEven ? "bg-white" : "bg-slate-50/60",
                        ].join(" ")}
                      >
                        {/* เดือน */}
                        <td className={["px-3 py-2.5 font-semibold text-slate-700 sticky left-0 z-10 whitespace-nowrap", isEven ? "bg-white" : "bg-slate-50"].join(" ")}>
                          {fmtMonthYear(row.monthKey)}
                        </td>
                        {/* จำนวนสัญญา */}
                        <td className="px-3 py-2.5 text-right text-slate-600">
                          <span className="inline-flex items-center justify-center bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-semibold">
                            {row.contractCount.toLocaleString()}
                          </span>
                        </td>
                        {/* เป้าเก็บหนี้ */}
                        <td className="px-3 py-2.5 text-right text-blue-800 font-medium bg-blue-50/30">
                          {fmtMoney(row.targetTotal)}
                        </td>
                        {/* ยอดเก็บหนี้ */}
                        <td className="px-3 py-2.5 text-right text-green-800 font-medium bg-green-50/30">
                          {fmtMoney(row.collectedTotal)}
                        </td>
                        {/* % การเก็บ */}
                        <td className={["px-3 py-2.5 text-right", rateBg].join(" ")}>
                          <div className="flex items-center justify-end gap-1">
                            {fmtPct(collectionRate)}
                            {collectionRate >= 100 && <TrendingUp className="w-3.5 h-3.5 text-green-600" />}
                            {collectionRate < 60 && collectionRate > 0 && <TrendingDown className="w-3.5 h-3.5 text-red-500" />}
                          </div>
                        </td>
                        {/* ยอดขายเครื่อง */}
                        <td className={["px-3 py-2.5 text-right", showDeviceSale ? "text-red-700" : "text-gray-300 line-through"].join(" ")}>
                          {fmtMoney(row.deviceSaleAmount)}
                        </td>
                        {/* รายรับรวม */}
                        <td className="px-3 py-2.5 text-right text-emerald-800 font-semibold bg-emerald-50/30">
                          {fmtMoney(revenue)}
                        </td>
                        {/* ต้นทุน */}
                        <td className="px-3 py-2.5 text-right text-slate-700">
                          {fmtMoney(row.cost)}
                        </td>
                        {/* กำไรขั้นต้น */}
                        <td className={["px-3 py-2.5 text-right bg-amber-50/30", profitColor].join(" ")}>
                          {fmtMoney(grossProfit)}
                        </td>
                        {/* ยังไม่ครบกำหนด */}
                        <td className="px-3 py-2.5 text-right text-slate-500">
                          {fmtMoney(row.notYetDue)}
                        </td>
                        {/* Eye toggle */}
                        <td className="px-3 py-2.5 text-center">
                          <button
                            type="button"
                            onClick={() => setHiddenMonths((prev) => {
                              const next = new Set(prev);
                              if (next.has(row.monthKey)) next.delete(row.monthKey);
                              else next.add(row.monthKey);
                              return next;
                            })}
                            className={[
                              "p-1 rounded transition-colors",
                              hiddenMonths.has(row.monthKey)
                                ? "text-gray-300 hover:text-gray-500"
                                : "text-slate-500 hover:text-slate-700",
                            ].join(" ")}
                            title={hiddenMonths.has(row.monthKey) ? "แสดงเดือนนี้" : "ซ่อนเดือนนี้"}
                          >
                            {hiddenMonths.has(row.monthKey)
                              ? <EyeOff className="w-4 h-4" />
                              : <Eye className="w-4 h-4" />}
                          </button>
                        </td>
                      </tr>
                      {/* Hidden month detail row */}
                      {isHidden && (
                        <tr className={isEven ? "bg-white" : "bg-slate-50/60"}>
                          <td colSpan={11} className="px-6 py-1.5 text-xs text-gray-400 italic border-b border-gray-100">
                            ซ่อนแล้ว — คลิกไอคอนตาเพื่อแสดงอีกครั้ง
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                {/* Summary row */}
                {monthRows.length > 0 && (() => {
                  const totalContracts = monthRows.reduce((s, r) => s + r.contractCount, 0);
                  const totalTarget = monthRows.reduce((s, r) => s + r.targetTotal, 0);
                  const totalCollected = monthRows.reduce((s, r) => s + r.collectedTotal, 0);
                  const totalDeviceSale = showDeviceSale ? monthRows.reduce((s, r) => s + r.deviceSaleAmount, 0) : 0;
                  const totalRevenue = totalCollected + totalDeviceSale;
                  const totalCost = monthRows.reduce((s, r) => s + r.cost, 0);
                  const totalProfit = totalRevenue - totalCost;
                  const totalNotYetDue = monthRows.reduce((s, r) => s + r.notYetDue, 0);
                  const overallRate = totalTarget > 0 ? (totalCollected / totalTarget) * 100 : 0;
                  return (
                    <tfoot>
                      <tr className="bg-gradient-to-r from-slate-800 to-slate-900 text-white font-bold border-t-2 border-slate-600">
                        <td className="px-3 py-3 sticky left-0 bg-slate-800 z-10">รวมทั้งหมด</td>
                        <td className="px-3 py-3 text-right">
                          <span className="inline-flex items-center justify-center bg-white/20 rounded-full px-2.5 py-0.5 text-xs font-bold">
                            {totalContracts.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-blue-200">{fmtMoney(totalTarget)}</td>
                        <td className="px-3 py-3 text-right text-green-200">{fmtMoney(totalCollected)}</td>
                        <td className="px-3 py-3 text-right text-yellow-200">{fmtPct(overallRate)}</td>
                        <td className={["px-3 py-3 text-right", showDeviceSale ? "text-red-200" : "text-gray-500"].join(" ")}>{fmtMoney(totalDeviceSale)}</td>
                        <td className="px-3 py-3 text-right text-emerald-200">{fmtMoney(totalRevenue)}</td>
                        <td className="px-3 py-3 text-right text-slate-200">{fmtMoney(totalCost)}</td>
                        <td className={["px-3 py-3 text-right", totalProfit >= 0 ? "text-amber-200" : "text-red-300"].join(" ")}>{fmtMoney(totalProfit)}</td>
                        <td className="px-3 py-3 text-right text-slate-300">{fmtMoney(totalNotYetDue)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>
            <div className="mt-2 text-xs text-gray-400 text-right">
              แสดง {monthRows.length} เดือน จาก {filteredTargetRows.length.toLocaleString()} สัญญา (target) / {filteredCollectedRows.length.toLocaleString()} สัญญา (collected)
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

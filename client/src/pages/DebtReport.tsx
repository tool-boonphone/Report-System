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
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BadgeDollarSign,
  Banknote,
  Check,
  ChevronsUpDown,
  CircleDollarSign,
  Coins,
  Download,
  Gavel,
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
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const { can } = useAppAuth();
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
  // Switch: true = เฉพาะเงินต้น (แสดง penalty/unlockFee = 0 ทุกงวด), false = รวมค่าปรับ+ค่าปลดล็อก
  const [principalOnly, setPrincipalOnly] = useState(true);
  // Pinned columns: set of LEFT_COLS keys that are sticky-left
  const [pinnedCols, setPinnedCols] = useState<Set<string>>(new Set());
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const togglePin = (key: string) => {
    setPinnedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // One-shot load per tab. Query disables itself when user lacks permission.
  const targetQuery = trpc.debt.listTarget.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section && tab === "target" },
  );
  const collectedQuery = trpc.debt.listCollected.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section && tab === "collected" },
  );

  const isLoading =
    tab === "target" ? targetQuery.isLoading : collectedQuery.isLoading;

  const activeRows: (TargetRow | CollectedRow)[] =
    (tab === "target"
      ? (targetQuery.data?.rows as TargetRow[])
      : (collectedQuery.data?.rows as CollectedRow[])) ?? [];
  // hasPrincipalBreakdown: true = Boonphone (แสดง principal/interest/fee จริง)
  //                         false = Fastfone365 (แสดง "-" แทน 0.00)
  const hasPrincipalBreakdown = collectedQuery.data?.hasPrincipalBreakdown !== false;

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
    for (const r of activeRows) {
      for (const inst of r.installments) {
        if (inst.dueDate) s.add(inst.dueDate.slice(0, 7));
      }
    }
    return Array.from(s).sort().reverse();
  }, [activeRows]);

  const productTypeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of activeRows) {
      if (r.productType) s.add(r.productType);
    }
    return Array.from(s).sort();
  }, [activeRows]);

  /* ---- Filter (client-side) ---- */
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeRows.filter((r) => {
      if (statusFilter.size > 0 && !statusFilter.has(r.debtStatus)) return false;
      if (productTypeFilter.size > 0 && !productTypeFilter.has(r.productType ?? "")) return false;
      if (approveDateFilter.size > 0) {
        const ym = r.approveDate ? r.approveDate.slice(0, 7) : "";
        if (!approveDateFilter.has(ym)) return false;
      }
      if (dueDateFilter.size > 0) {
        // Row passes if ANY installment's due_date month is in the filter
        const hasMatch = r.installments.some(
          (inst) => inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7))
        );
        if (!hasMatch) return false;
      }
      if (!q) return true;
      return (
        (r.contractNo ?? "").toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q)
      );
    });
  }, [activeRows, search, statusFilter, approveDateFilter, dueDateFilter, productTypeFilter]);

  /* ---- Max periods for the repeating group block ---- */
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

  /** Per row "line count" = max number of sub-rows that any of its periods has. */
  function rowLineCount(r: CollectedRow): number {
    if (tab !== "collected") return 1;
    let max = 1;
    const perPeriod = new Map<number, number>();
    for (const p of r.payments ?? []) {
      if (p.period == null) continue;
      perPeriod.set(p.period, (perPeriod.get(p.period) ?? 0) + 1);
    }
    perPeriod.forEach((v) => {
      if (v > max) max = v;
    });
    return max;
  }

  /* ---- Summary totals (computed from filteredRows, respects all filters) ---- */
  const targetSummary = useMemo(() => {
    if (tab !== "target") return null;
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0, total = 0;
    for (const r of filteredRows) {
      for (const inst of r.installments) {
        if (inst.isClosed || inst.isSuspended) continue;
        principal += inst.principal ?? 0;
        interest += inst.interest ?? 0;
        fee += inst.fee ?? 0;
        penalty += principalOnly ? 0 : (inst.penalty ?? 0);
        unlockFee += principalOnly ? 0 : (inst.unlockFee ?? 0);
      }
    }
    total = principal + interest + fee + penalty + unlockFee;
    return { principal, interest, fee, penalty, unlockFee, total };
  }, [filteredRows, tab, principalOnly]);

  const collectedSummary = useMemo(() => {
    if (tab !== "collected") return null;
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0;
    let discount = 0, overpaid = 0, badDebt = 0, total = 0;
    for (const r of filteredRows as CollectedRow[]) {
      for (const p of r.payments ?? []) {
        principal += p.principal ?? 0;
        interest += p.interest ?? 0;
        fee += p.fee ?? 0;
        penalty += p.penalty ?? 0;
        unlockFee += p.unlockFee ?? 0;
        discount += p.discount ?? 0;
        overpaid += p.overpaid ?? 0;
        badDebt += p.badDebt ?? 0;
        // ยอดที่ชำระรวม = total_paid_amount จาก API (รวม overpaid ด้วย ไม่รวม discount)
        total += p.total ?? 0;
      }
    }
    return { principal, interest, fee, penalty, unlockFee, discount, overpaid, badDebt, total };
  }, [filteredRows, tab]);

  /* ---- TopNav actions (sync + export) ---- */
  // Export handler (used inline in toolbar)
  const handleExport = React.useCallback(async () => {
    if (!section) return;
    const params = new URLSearchParams({ section, variant: tab });
    if (search) params.set("search", search);
    if (statusFilter.size > 0) params.set("status", Array.from(statusFilter).join(","));
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
  }, [section, tab, search, statusFilter]);

  useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar />
      </div>,
    );
    return () => setActions(null);
  }, [setActions]);

  /* ---- Virtual scroll ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 40;
  const SUB_ROW_HEIGHT = 32;
  // collected tab rows can have multiple sub-rows for split payments;
  // give the virtualizer an estimate per row for accurate scrollbar.
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      if (tab !== "collected") return ROW_HEIGHT;
      const r = filteredRows[i] as CollectedRow;
      const lines = rowLineCount(r);
      return ROW_HEIGHT + (lines - 1) * SUB_ROW_HEIGHT;
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
          { key: "penalty", label: "ค่าปรับ", width: 80, align: "right" },
          { key: "unlockFee", label: "ค่าปลดล็อก", width: 90, align: "right" },
          { key: "amount", label: "ยอดหนี้รวม", width: 115, align: "right" },
        ]
      : [
          // collected tab: ซ่อน closeInstallmentAmount (ซ้ำซ้อนกับ principal+interest+fee)
          { key: "period", label: "งวดที่", width: 55 },
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

        {/* Toolbar Row 1: Search + Status + Month-year + PrincipalOnly */}
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
              <MultiSelectFilter
                label="เดือน-ปีที่อนุมัติ"
                selected={approveDateFilter}
                onChange={setApproveDateFilter}
                options={approveDateOptions}
                placeholder="ทุกเดือน-ปีที่อนุมัติ"
              />
              <MultiSelectFilter
                label="เดือน-ปีที่ต้องชำระ"
                selected={dueDateFilter}
                onChange={setDueDateFilter}
                options={dueDateOptions}
                placeholder="ทุกเดือน-ปีที่ต้องชำระ"
              />
              <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
              <MultiSelectFilter
                label="ประเภทเครื่อง"
                selected={productTypeFilter}
                onChange={setProductTypeFilter}
                options={productTypeOptions}
                placeholder="ทุกประเภทเครื่อง"
              />
              {tab === "target" && (
                <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5">
                  <Switch id="principal-only" checked={principalOnly} onCheckedChange={setPrincipalOnly} />
                  <label htmlFor="principal-only" className="text-xs text-gray-600 cursor-pointer select-none whitespace-nowrap">
                    เฉพาะเงินต้น
                  </label>
                </div>
              )}
              {(statusFilter.size > 0 || approveDateFilter.size > 0 || dueDateFilter.size > 0 || productTypeFilter.size > 0) && (
                <button
                  type="button"
                  onClick={() => { setStatusFilter(new Set()); setApproveDateFilter(new Set()); setDueDateFilter(new Set()); setProductTypeFilter(new Set()); }}
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
            ทั้งหมด {activeRows.length.toLocaleString("th-TH")} สัญญา · แสดง{" "}
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
              {/* เงินต้น/ดอกเบี้ย/ค่าดำเนินการ: ซ่อนสำหรับ FF365 เพราะ API ไม่ส่ง breakdown */}
              {hasPrincipalBreakdown && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                  <Banknote className="w-3 h-3" />
                  เงินต้น: {fmtMoney(collectedSummary.principal)}
                </span>
              )}
              {hasPrincipalBreakdown && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200">
                  <Percent className="w-3 h-3" />
                  ดอกเบี้ย: {fmtMoney(collectedSummary.interest)}
                </span>
              )}
              {hasPrincipalBreakdown && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-cyan-50 text-cyan-700 border border-cyan-200">
                  <CircleDollarSign className="w-3 h-3" />
                  ค่าดำเนินการ: {fmtMoney(collectedSummary.fee)}
                </span>
              )}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700 border border-red-200">
                <Gavel className="w-3 h-3" />
                ค่าปรับ: {fmtMoney(collectedSummary.penalty)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-50 text-orange-700 border border-orange-200">
                <LockOpen className="w-3 h-3" />
                ค่าปลดล็อก: {fmtMoney(collectedSummary.unlockFee)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-teal-50 text-teal-700 border border-teal-200">
                <Tag className="w-3 h-3" />
                ส่วนลด: {fmtMoney(collectedSummary.discount)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <TrendingUp className="w-3 h-3" />
                ชำระเกิน: {fmtMoney(collectedSummary.overpaid)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700 border border-gray-300">
                <TrendingDown className="w-3 h-3" />
                หนี้เสีย: {fmtMoney(collectedSummary.badDebt)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                <Wallet className="w-3 h-3" />
                ยอดที่ชำระรวม: {fmtMoney(collectedSummary.total)}
              </span>
            </div>
          )}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Spinner />
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="border rounded-lg bg-white overflow-auto"
            style={{ maxHeight: "calc(100vh - 220px)" }}
          >
            <div style={{ width: LEFT_WIDTH + GROUP_WIDTH * maxPeriods }}>
              {/* Header row */}
              <div className="sticky top-0 z-20 bg-white">
                {/* Tier 1: group header over installment columns */}
                <div className="flex border-b bg-slate-100 text-[12px] font-semibold text-slate-700">
                  <div
                    className="bg-slate-100 border-r"
                    style={{ width: LEFT_WIDTH, height: 28 }}
                  />
                  {Array.from({ length: maxPeriods }, (_, i) => (
                    <div
                      key={`gh-${i}`}
                      className="border-r text-center flex items-center justify-center text-white"
                      style={{
                        width: GROUP_WIDTH,
                        height: 28,
                        background:
                          // amber-700 for target, emerald-700 for collected
                          tab === "target" ? "#b45309" : "#047857",
                      }}
                    >
                      ข้อมูลชำระงวดที่ {i + 1}
                    </div>
                  ))}
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
                  {Array.from({ length: maxPeriods }, (_, i) =>
                    groupCols.map((gc) => {
                      // Alternating tint per reference (indigo-50 / indigo-100 for target,
                      // rose-50 flat for collected).
                      const subBg =
                        // target: amber-50 / amber-100 alternating; collected: emerald-50 flat
                        tab === "target"
                          ? i % 2 === 0
                            ? "#fffbeb" // amber-50
                            : "#fef3c7" // amber-100
                          : "#ecfdf5"; // emerald-50
                      const subColor =
                        // amber-900 for target, emerald-900 for collected
                        tab === "target" ? "#78350f" : "#064e3b";
                      return (
                        <div
                          key={`h-${i}-${gc.key}`}
                          className="px-2 py-2 border-r whitespace-nowrap"
                          style={{
                            width: gc.width,
                            textAlign:
                              (gc as any).align === "right" ? "right" : "left",
                            background: subBg,
                            color: subColor,
                          }}
                        >
                          {gc.label}
                        </div>
                      );
                    }),
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
                  // Build per-period payments map for collected tab
                  const paymentsByPeriod = new Map<number, PaymentCell[]>();
                  if (tab === "collected") {
                    for (const p of (r as CollectedRow).payments ?? []) {
                      if (p.period == null) continue;
                      if (!paymentsByPeriod.has(p.period))
                        paymentsByPeriod.set(p.period, []);
                      paymentsByPeriod.get(p.period)!.push(p);
                    }
                  }
                  return (
                    <div
                      key={vr.key}
                      className={`flex border-b text-[12px] transition-colors cursor-default relative ${
                        hoveredRow === vr.index
                          ? "shadow-[inset_4px_0_0_0_#2563eb,inset_0_-1px_0_0_#93c5fd,0_-1px_0_0_#93c5fd]"
                          : ""
                      }`}
                      style={{ height: rowH }}
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
                        {r.installmentCount ?? "-"}
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
                      {/* Repeating groups */}
                      {Array.from({ length: maxPeriods }, (_, i) => {
                        const periodNo = i + 1;
                        if (tab === "target") {
                          const inst = r.installments[i];
                          const closed = !!inst?.isClosed;
                          const suspended = !!inst?.isSuspended;
                          const suspendLabel = inst?.suspendLabel ?? "ระงับสัญญา";
                          // Grey-out applies to both closed AND suspended cells.
                          const dimmed = closed || suspended;
                          return groupCols.map((gc) => {
                            let v: any = "";
                            let annotation: string | null = null;
                            let annotationClass = "";
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
                                  if (
                                    inst.overpaidApplied > 0.009 &&
                                    inst.baselineAmount > inst.amount + 0.009
                                  ) {
                                    annotation = `(-หักชำระเกิน: ${fmtMoney(inst.overpaidApplied)})`;
                                    annotationClass = "text-emerald-600 font-semibold";
                                  }
                                }
                              }
                            }
                            const isArrears = !dimmed && !!inst?.isArrears;
                            const isCurrentPeriod = !dimmed && !!inst?.isCurrentPeriod;
                            // Phase 9AI: future period = dueDate > today (not closed/suspended)
                            const todayStr = new Date().toISOString().slice(0, 10);
                            const isFuturePeriod = !dimmed && !isArrears && !isCurrentPeriod &&
                              !!inst?.dueDate && inst.dueDate > todayStr;
                            const baseStyle: Record<string, string | number> = {
                              width: gc.width,
                              textAlign:
                                (gc as any).align === "right"
                                  ? "right"
                                  : "left",
                            };
                            if (dimmed) {
                              baseStyle.background = "#f3f4f6"; // gray-100
                              baseStyle.color = "#9ca3af"; // gray-400
                              baseStyle.fontStyle = "italic";
                            } else if (isArrears) {
                              // Arrears carry: amber-100 bg + amber-800 bold text
                              // to signal "this amount includes unpaid from prior periods"
                              baseStyle.background = "#fef3c7"; // amber-100
                              baseStyle.color = "#92400e"; // amber-800
                              baseStyle.fontWeight = "700";
                            } else if (isCurrentPeriod) {
                              // Current period: sky-50 BG to make it easy to spot
                              // without needing to read the due date column.
                              baseStyle.background = "#f0f9ff"; // sky-50
                            } else if (isFuturePeriod) {
                              // Phase 9AI: future periods dimmed with gray text
                              baseStyle.color = "#9ca3af"; // gray-400
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
                        // ---------- Collected tab ----------
                        const pays = paymentsByPeriod.get(periodNo) ?? [];

                        // Phase 9N: "inactive period" in collected tab.
                        // A period is inactive (grey out) when:
                        //   1. periodNo > installmentCount — the contract has
                        //      fewer periods than the table's maxPeriods, so
                        //      this column doesn't apply to this contract.
                        //   2. The contract is suspended or bad-debt AND the
                        //      period has no payment recorded — no need to
                        //      collect, show as grey placeholder.
                        const instCount = r.installmentCount ?? maxPeriods;
                        const contractSuspended =
                          r.debtStatus === "ระงับสัญญา" ||
                          r.debtStatus === "หนี้เสีย";
                        const isInactivePeriod =
                          periodNo > instCount ||
                          (contractSuspended && pays.length === 0);

                        // Vertical stack: one cell per group sub-column,
                        // with N inner lines for N split payments.
                        return groupCols.map((gc, gcIdx) => {
                          return (
                            <div
                              key={`c-${vr.index}-${i}-${gc.key}`}
                              className="border-r tabular-nums"
                              style={{
                                width: gc.width,
                                textAlign:
                                  (gc as any).align === "right"
                                    ? "right"
                                    : "left",
                                // Grey background for inactive periods
                                background: isInactivePeriod ? "#f3f4f6" : undefined,
                              }}
                            >
                              {Array.from({ length: lineCount }, (_, li) => {
                                const pay = pays[li];
                                let v: any = "";
                                // Phase 9M: highlight close-contract payment
                                // rows with pink background + left accent
                                // on the first ("period") column of each
                                // group.
                                const isCloseCell = !!pay && pay.isCloseRow;
                                if (pay) {
                                  switch (gc.key) {
                                    case "period":
                                      // Always show the receipt's sequence per period.
                                      // First payment of period P → "P-1", second → "P-2", etc.
                                      v = `${periodNo}-${(pay.splitIndex ?? 0) + 1}`;
                                      break;
                                    case "paidAt":
                                      v = fmtDate(pay.paidAt);
                                      break;
                                    case "principal":
                                      // FF365: no breakdown available — show "-" instead of 0.00
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
                                      v = pay.isCloseRow
                                        ? fmtMoney(pay.closeInstallmentAmount)
                                        : fmtMoney(0);
                                      break;
                                    case "badDebt":
                                      v = fmtMoney(pay.badDebt || 0);
                                      break;
                                    case "total":
                                      v = fmtMoney(pay.total);
                                      break;
                                  }
                                }
                                // Grey-italic zero when cell is empty/zero so every
                                // row has a value, but visually muted.
                                const isZeroish =
                                  pay && (v === fmtMoney(0) || v === "0" || v === "0.00");
                                const isEmptyCell = !pay;

                                // Phase 9N: inactive period overrides all
                                // other styling — grey text, no close highlight.
                                let textClass: string;
                                let cellBg: string | undefined;
                                let cellBorderLeft: string | undefined;
                                if (isInactivePeriod) {
                                  textClass = "text-gray-400 italic";
                                  cellBg = undefined; // parent div already grey
                                  cellBorderLeft = undefined;
                                } else if (isCloseCell) {
                                  // TXRTC close row: rose-50 bg + rose-700 text
                                  // 0.00 values use rose-300 italic (faded)
                                  const isZeroInClose = isZeroish;
                                  textClass = isZeroInClose
                                    ? "text-rose-300 italic"
                                    : "text-rose-700";
                                  cellBg = "#fff1f2"; // rose-50
                                  cellBorderLeft =
                                    gcIdx === 0
                                      ? "4px solid #fb7185" // rose-400
                                      : undefined;
                                } else {
                                  // Per-field styling rules:
                                  //   penalty  → red text
                                  //   overpaid → green bold
                                  //   badDebt  → red bold
                                  //   total    → bold
                                  //   zero/empty → grey italic
                                  if (pay && !isZeroish) {
                                    if (gc.key === "penalty" && (pay.penalty ?? 0) > 0) {
                                      textClass = "text-red-600";
                                    } else if (gc.key === "unlockFee" && (pay.unlockFee ?? 0) > 0) {
                                      // Phase 9AI: ค่าปลดล็อก → สีฟ้า ไม่ตัวหนา
                                      textClass = "text-blue-500";
                                    } else if (gc.key === "discount" && (pay.discount ?? 0) > 0) {
                                      // Phase 9AG: ส่วนลด → สีเขียวอมฟ้า (teal)
                                      textClass = "text-teal-600";
                                    } else if (gc.key === "overpaid" && (pay.overpaid ?? 0) > 0) {
                                      textClass = "text-emerald-600 font-bold";
                                    } else if (gc.key === "badDebt" && (pay.badDebt ?? 0) > 0) {
                                      // Phase 9AG: หนี้เสีย → สีแดง ตัวหนา
                                      textClass = "text-red-700 font-bold";
                                    } else if (gc.key === "total") {
                                      textClass = "font-bold";
                                    } else {
                                      textClass = "";
                                    }
                                  } else {
                                    textClass =
                                      isEmptyCell || isZeroish
                                        ? "text-gray-400 italic"
                                        : "";
                                  }
                                  cellBg = undefined;
                                  cellBorderLeft = undefined;
                                }

                                return (
                                  <div
                                    key={`c-${vr.index}-${i}-${gc.key}-${li}`}
                                    className={`px-2 truncate py-2 ${textClass}`}
                                    style={{
                                      height:
                                        li === 0 ? ROW_HEIGHT : SUB_ROW_HEIGHT,
                                      lineHeight:
                                        li === 0 ? `${ROW_HEIGHT - 16}px` : `${SUB_ROW_HEIGHT - 12}px`,
                                      background: cellBg,
                                      borderLeft: cellBorderLeft,
                                    }}
                                    title={
                                      isInactivePeriod
                                        ? (periodNo > instCount
                                            ? "ไม่มีงวดนี้ในสัญญา"
                                            : "ระงับ/หนี้เสีย")
                                        : (pay?.remark ?? pay?.receiptNo ?? undefined)
                                    }
                                  >
                                    {v}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        });
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
      </div>
    </AppShell>
  );
}


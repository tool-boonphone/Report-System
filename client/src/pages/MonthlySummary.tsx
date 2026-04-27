/**
 * MonthlySummary — สรุปรายเดือน (Phase 79)
 *
 * ตาราง group by เดือนที่อนุมัติสัญญา × debt_status bucket
 * 3 แถบ:
 *   1. จำนวนสัญญา     — ไม่มี badge
 *   2. ยอดชำระแล้ว    — badge: เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ค่าปรับ/ส่วนลด(ปิดเสมอ)/ชำระเกิน + รวมยอดชำระ
 *   3. ยอดค้างชำระ    — badge: เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ค่าปรับ + รวมยอดค้างชำระ
 *
 * Column group hierarchy (3 กลุ่ม, แต่ละกลุ่มมี group eye toggle):
 *   ปกติ          → ปกติ, เกิน 1-7, เกิน 8-14, เกิน 15-30, เกิน 31-60
 *   สงสัยจะเสีย   → เกิน 61-90, เกิน >90, ระงับสัญญา, สิ้นสุดสัญญา
 *   หนี้เสีย       → หนี้เสีย (แถบ paid แบ่งเป็น 2 sub-col: ยอดชำระ + หนี้เสีย)
 *
 * Pin: เดือน + สัญญา (2 คอลัมน์แรก) ถูก pin ซ้ายเสมอ
 * Eye toggle ในหัวตาราง: มีผลต่อการคำนวณทั้งหมดในตารางและยอดใน badge
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Banknote,
  CalendarDays,
  Check,
  ChevronsUpDown,
  Coins,
  Download,
  Eye,
  EyeOff,
  Gavel,
  Percent,
  RefreshCw,
  Tag,
  TrendingUp,
  X,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

/* ─────────────────────────────────────────────────────────────────── */
/* Constants & types                                                   */
/* ─────────────────────────────────────────────────────────────────── */

const DEBT_BUCKETS = [
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
type DebtBucket = (typeof DEBT_BUCKETS)[number];

type ColGroup = {
  key: string;
  label: string;
  buckets: DebtBucket[];
  headerBg: string;
};

const COL_GROUPS: ColGroup[] = [
  {
    key: "normal",
    label: "ปกติ",
    buckets: ["ปกติ", "เกิน 1-7", "เกิน 8-14", "เกิน 15-30", "เกิน 31-60"],
    headerBg: "bg-green-700",
  },
  {
    key: "suspect",
    label: "สงสัยจะเสีย",
    buckets: ["เกิน 61-90", "เกิน >90", "ระงับสัญญา", "สิ้นสุดสัญญา"],
    headerBg: "bg-orange-700",
  },
  {
    key: "bad",
    label: "หนี้เสีย",
    buckets: ["หนี้เสีย"],
    headerBg: "bg-gray-800",
  },
];

type MoneyBreakdown = {
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  unlockFee: number;
  discount: number;
  overpaid: number;
  badDebt: number;
  total: number;
};

type SummaryCell = {
  contractCount: number;
  paid: MoneyBreakdown;
  due: MoneyBreakdown;
};

type SummaryRow = {
  approveMonth: string;
  buckets: Record<string, SummaryCell>;
  totalCount: number;
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
};

type TabKey = "count" | "paid" | "due";

/** Badge keys สำหรับแถบ "ยอดชำระแล้ว" */
type PaidBadgeKey = "principal" | "interest" | "fee" | "penalty" | "discount" | "overpaid";

/** Badge keys สำหรับแถบ "ยอดค้างชำระ" */
type DueBadgeKey = "principal" | "interest" | "fee" | "penalty";

/* ─────────────────────────────────────────────────────────────────── */
/* Badge definitions                                                   */
/* ─────────────────────────────────────────────────────────────────── */

const PAID_BADGE_ITEMS: Array<{
  key: PaidBadgeKey;
  label: string;
  icon: React.ReactNode;
  defaultOn: boolean;
  canToggle: boolean;
}> = [
  { key: "principal", label: "เงินต้น",      icon: <Banknote   className="w-3.5 h-3.5" />, defaultOn: true,  canToggle: true  },
  { key: "interest",  label: "ดอกเบี้ย",     icon: <Percent    className="w-3.5 h-3.5" />, defaultOn: true,  canToggle: true  },
  { key: "fee",       label: "ค่าดำเนินการ", icon: <Coins      className="w-3.5 h-3.5" />, defaultOn: true,  canToggle: true  },
  { key: "penalty",   label: "ค่าปรับ",      icon: <Gavel      className="w-3.5 h-3.5" />, defaultOn: true,  canToggle: true  },
  { key: "discount",  label: "ส่วนลด",       icon: <Tag        className="w-3.5 h-3.5" />, defaultOn: false, canToggle: false },
  { key: "overpaid",  label: "ชำระเกิน",     icon: <TrendingUp className="w-3.5 h-3.5" />, defaultOn: true,  canToggle: true  },
];

const DUE_BADGE_ITEMS: Array<{
  key: DueBadgeKey;
  label: string;
  icon: React.ReactNode;
  defaultOn: boolean;
  canToggle: boolean;
}> = [
  { key: "principal", label: "เงินต้น",      icon: <Banknote className="w-3.5 h-3.5" />, defaultOn: true, canToggle: true },
  { key: "interest",  label: "ดอกเบี้ย",     icon: <Percent  className="w-3.5 h-3.5" />, defaultOn: true, canToggle: true },
  { key: "fee",       label: "ค่าดำเนินการ", icon: <Coins    className="w-3.5 h-3.5" />, defaultOn: true, canToggle: true },
  { key: "penalty",   label: "ค่าปรับ",      icon: <Gavel    className="w-3.5 h-3.5" />, defaultOn: true, canToggle: true },
];

/* ─────────────────────────────────────────────────────────────────── */
/* Compute helpers                                                     */
/* ─────────────────────────────────────────────────────────────────── */

/** ยอดชำระแล้ว ตาม badge visibility (ไม่รวม discount และ badDebt — badDebt แสดงแยก) */
function computePaidTotal(money: MoneyBreakdown, vis: Record<PaidBadgeKey, boolean>): number {
  return (
    (vis.principal ? money.principal : 0) +
    (vis.interest  ? money.interest  : 0) +
    (vis.fee       ? money.fee       : 0) +
    (vis.penalty   ? money.penalty   : 0) +
    (vis.overpaid  ? money.overpaid  : 0)
    // discount ไม่รวมเสมอ
    // badDebt แสดงแยกในคอลัมน์ "หนี้เสีย"
  );
}

/** ยอดค้างชำระ ตาม badge visibility */
function computeDueTotal(money: MoneyBreakdown, vis: Record<DueBadgeKey, boolean>): number {
  return (
    (vis.principal ? money.principal : 0) +
    (vis.interest  ? money.interest  : 0) +
    (vis.fee       ? money.fee       : 0) +
    (vis.penalty   ? money.penalty   : 0)
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Color helpers                                                       */
/* ─────────────────────────────────────────────────────────────────── */

function bucketPillClasses(bucket: string): string {
  switch (bucket) {
    case "ปกติ":          return "bg-green-100 text-green-800 border-green-300";
    case "เกิน 1-7":      return "bg-yellow-100 text-yellow-900 border-yellow-300";
    case "เกิน 8-14":     return "bg-amber-200 text-amber-900 border-amber-400";
    case "เกิน 15-30":    return "bg-orange-200 text-orange-900 border-orange-400";
    case "เกิน 31-60":    return "bg-red-200 text-red-900 border-red-400";
    case "เกิน 61-90":    return "bg-red-300 text-red-900 border-red-500";
    case "เกิน >90":      return "bg-rose-700 text-white border-rose-800";
    case "ระงับสัญญา":    return "bg-gray-800 text-white border-gray-900";
    case "สิ้นสุดสัญญา":  return "bg-blue-100 text-blue-800 border-blue-300";
    case "หนี้เสีย":       return "bg-gray-700 text-white border-gray-800";
    default:              return "bg-gray-100 text-gray-700 border-gray-200";
  }
}

function bucketHeaderBg(bucket: string): string {
  switch (bucket) {
    case "ปกติ":          return "bg-green-700";
    case "เกิน 1-7":      return "bg-yellow-600";
    case "เกิน 8-14":     return "bg-amber-600";
    case "เกิน 15-30":    return "bg-orange-600";
    case "เกิน 31-60":    return "bg-red-600";
    case "เกิน 61-90":    return "bg-red-700";
    case "เกิน >90":      return "bg-rose-800";
    case "ระงับสัญญา":    return "bg-gray-700";
    case "สิ้นสุดสัญญา":  return "bg-blue-700";
    case "หนี้เสีย":       return "bg-gray-800";
    default:              return "bg-slate-600";
  }
}

function bucketCellBg(bucket: string): string {
  switch (bucket) {
    case "ปกติ":          return "bg-green-50/40";
    case "เกิน 1-7":      return "bg-yellow-50/40";
    case "เกิน 8-14":     return "bg-amber-50/40";
    case "เกิน 15-30":    return "bg-orange-50/40";
    case "เกิน 31-60":    return "bg-red-50/40";
    case "เกิน 61-90":    return "bg-red-100/40";
    case "เกิน >90":      return "bg-rose-100/40";
    case "ระงับสัญญา":    return "bg-gray-100/40";
    case "สิ้นสุดสัญญา":  return "bg-blue-50/40";
    case "หนี้เสีย":       return "bg-gray-200/40";
    default:              return "";
  }
}

/* ─────────────────────────────────────────────────────────────────── */
/* Format helpers                                                      */
/* ─────────────────────────────────────────────────────────────────── */

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const num = Number(n);
  if (num === 0) return "0.00";
  return num.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMonthYear(ym: string): string {
  const [y, m] = ym.split("-");
  const MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const monthIdx = parseInt(m, 10) - 1;
  const yearShort = (parseInt(y, 10) + 543).toString().slice(-2);
  return `${MONTHS[monthIdx] ?? m} ${yearShort}`;
}

/* ─────────────────────────────────────────────────────────────────── */
/* MultiSelectFilter                                                   */
/* ─────────────────────────────────────────────────────────────────── */

function MultiSelectFilter({
  label, selected, onChange, options, placeholder = "ทั้งหมด",
}: {
  label: string;
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (s: string) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s); else next.add(s);
    onChange(next);
  };
  const labelText = selected.size === 0 ? placeholder
    : selected.size === 1 ? Array.from(selected)[0]
    : `${selected.size} รายการ`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={`flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px] justify-between ${selected.size > 0 ? "border-indigo-400 bg-indigo-50 text-indigo-800 font-medium" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
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
              <CommandItem value="__all__" onSelect={() => { onChange(new Set()); setOpen(false); }}>
                <Check className={`mr-2 h-3.5 w-3.5 ${selected.size === 0 ? "opacity-100 text-indigo-600" : "opacity-0"}`} />
                <span className={selected.size === 0 ? "text-indigo-600 font-medium" : "text-gray-500"}>{placeholder}</span>
              </CommandItem>
              {options.map((opt) => (
                <CommandItem key={opt} value={opt} onSelect={(v) => { const o = options.find((x) => x.toLowerCase() === v) ?? v; toggle(o); }}>
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

/* ─────────────────────────────────────────────────────────────────── */
/* Main Component                                                      */
/* ─────────────────────────────────────────────────────────────────── */

export default function MonthlySummary() {
  const { can } = useAppAuth();
  const { section } = useSection();
  const { setActions } = useNavActions();
  const canView   = can("debt_report", "view");
  const canExport = can("debt_report", "export");

  /* ── Filter ── */
  const [paidAtFrom, setPaidAtFrom] = useState("");
  const [paidAtTo,   setPaidAtTo]   = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(true);

  /* ── Tab ── */
  const [tab, setTab] = useState<TabKey>("count");

  /* ── Badge visibility ── */
  const [paidVis, setPaidVis] = useState<Record<PaidBadgeKey, boolean>>({
    principal: true, interest: true, fee: true, penalty: true, discount: false, overpaid: true,
  });
  const [dueVis, setDueVis] = useState<Record<DueBadgeKey, boolean>>({
    principal: true, interest: true, fee: true, penalty: true,
  });

  /* ── Column (bucket) visibility ── */
  const [hiddenBuckets, setHiddenBuckets] = useState<Set<string>>(new Set());
  const toggleBucket = useCallback((b: string) => {
    setHiddenBuckets((prev) => { const n = new Set(prev); if (n.has(b)) n.delete(b); else n.add(b); return n; });
  }, []);
  const toggleGroup = useCallback((group: ColGroup) => {
    setHiddenBuckets((prev) => {
      const n = new Set(prev);
      const allHidden = group.buckets.every((b) => n.has(b));
      if (allHidden) group.buckets.forEach((b) => n.delete(b));
      else group.buckets.forEach((b) => n.add(b));
      return n;
    });
  }, []);

  /* ── tRPC query ── */
  const queryInput = useMemo(() => {
    if (!section) return null;
    return {
      section,
      paidAtFrom: paidAtFrom || undefined,
      paidAtTo:   paidAtTo   || undefined,
      productType: productTypeFilter.size === 1 ? Array.from(productTypeFilter)[0] : undefined,
    };
  }, [section, paidAtFrom, paidAtTo, productTypeFilter]);

  const query = trpc.monthlySummary.get.useQuery(
    queryInput as any,
    { enabled: canView && !!queryInput },
  );
  const { rows = [], productTypes = [] } = (query.data ?? {}) as { rows: SummaryRow[]; productTypes: string[] };

  /* ── Visible buckets ── */
  const visibleBuckets = useMemo(
    () => DEBT_BUCKETS.filter((b) => !hiddenBuckets.has(b)),
    [hiddenBuckets],
  );

  /* ── Grand total ── */
  const grandTotal = useMemo(() => {
    const emptyMoney = (): MoneyBreakdown => ({ principal:0,interest:0,fee:0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,total:0 });
    const bucketTotals: Record<string, { count: number; paid: MoneyBreakdown; due: MoneyBreakdown }> = {};
    for (const b of DEBT_BUCKETS) bucketTotals[b] = { count: 0, paid: emptyMoney(), due: emptyMoney() };
    let totalCount = 0;
    const totalPaid = emptyMoney();
    const totalDue  = emptyMoney();
    for (const row of rows) {
      totalCount += row.totalCount;
      for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
        totalPaid[k] += row.totalPaid[k];
        totalDue[k]  += row.totalDue[k];
      }
      for (const b of DEBT_BUCKETS) {
        const cell = row.buckets[b];
        if (!cell) continue;
        bucketTotals[b].count += cell.contractCount;
        for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
          bucketTotals[b].paid[k] += cell.paid[k];
          bucketTotals[b].due[k]  += cell.due[k];
        }
      }
    }
    return { bucketTotals, totalCount, totalPaid, totalDue };
  }, [rows]);

  /* ── Badge grand totals (only visible buckets) ── */
  const grandBadgePaid = useMemo(() => {
    const r: MoneyBreakdown = { principal:0,interest:0,fee:0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,total:0 };
    for (const b of visibleBuckets) {
      const bt = grandTotal.bucketTotals[b];
      if (!bt) continue;
      for (const k of Object.keys(r) as (keyof MoneyBreakdown)[]) r[k] += bt.paid[k];
    }
    return r;
  }, [grandTotal, visibleBuckets]);

  const grandBadgeDue = useMemo(() => {
    const r: MoneyBreakdown = { principal:0,interest:0,fee:0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,total:0 };
    for (const b of visibleBuckets) {
      const bt = grandTotal.bucketTotals[b];
      if (!bt) continue;
      for (const k of Object.keys(r) as (keyof MoneyBreakdown)[]) r[k] += bt.due[k];
    }
    return r;
  }, [grandTotal, visibleBuckets]);

  /* ── Export ── */
  const handleExport = useCallback(() => {
    if (!canExport) { toast.error("คุณไม่มีสิทธิ์ Export"); return; }
    try {
      const wb = XLSX.utils.book_new();
      const headers = ["เดือน-ปีที่อนุมัติ", "รวมสัญญา", ...DEBT_BUCKETS.map((b) => `${b}`)];
      const wsData: (string | number)[][] = [headers];
      for (const row of rows) {
        wsData.push([fmtMonthYear(row.approveMonth), row.totalCount, ...DEBT_BUCKETS.map((b) => row.buckets[b]?.contractCount ?? 0)]);
      }
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb, ws, "สรุปรายเดือน");
      XLSX.writeFile(wb, `monthly_summary_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ");
    } catch { toast.error("Export ล้มเหลว"); }
  }, [canExport, rows]);

  /* ── Nav actions ── */
  useEffect(() => {
    setActions(
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching} className="h-8 px-2.5 text-xs">
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${query.isFetching ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">รีเฟรช</span>
        </Button>
        {canExport && (
          <Button variant="outline" size="sm" onClick={handleExport} className="h-8 px-2.5 text-xs">
            <Download className="w-3.5 h-3.5 mr-1" />
            <span className="hidden sm:inline">Export</span>
          </Button>
        )}
      </div>,
    );
    return () => setActions(null);
  }, [setActions, query.isFetching, query.refetch, canExport, handleExport]);

  /* ─────────────────────────────────────────────────────────────── */
  /* Render                                                          */
  /* ─────────────────────────────────────────────────────────────── */

  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-0">
        <SyncStatusBar />

        {/* ── Filter bar ── */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            onClick={() => setFilterOpen((v) => !v)}
          >
            <span className="flex items-center gap-1.5">
              <CalendarDays className="w-4 h-4 text-blue-500" />
              ตัวกรอง
              {(paidAtFrom || paidAtTo || productTypeFilter.size > 0) && (
                <span className="ml-1 inline-flex items-center justify-center bg-blue-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">
                  {[paidAtFrom || paidAtTo ? 1 : 0, productTypeFilter.size > 0 ? 1 : 0].reduce((a, b) => a + b, 0)}
                </span>
              )}
            </span>
            <span className="text-xs text-gray-400">{filterOpen ? "▲ ซ่อน" : "▼ แสดง"}</span>
          </button>
          {filterOpen && (
            <div className="px-4 pb-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500 whitespace-nowrap">วันที่รับชำระ:</span>
                <div className="relative flex items-center">
                  <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <input type="date" value={paidAtFrom} onChange={(e) => setPaidAtFrom(e.target.value)}
                    className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]" />
                </div>
                <span className="text-xs text-gray-400">—</span>
                <div className="relative flex items-center">
                  <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <input type="date" value={paidAtTo} onChange={(e) => setPaidAtTo(e.target.value)}
                    className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]" />
                </div>
                {(paidAtFrom || paidAtTo) && (
                  <button type="button" onClick={() => { setPaidAtFrom(""); setPaidAtTo(""); }}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <MultiSelectFilter label="ประเภทสินค้า" selected={productTypeFilter} onChange={setProductTypeFilter} options={productTypes} placeholder="ทุกประเภทสินค้า" />
              {(paidAtFrom || paidAtTo || productTypeFilter.size > 0) && (
                <button type="button" onClick={() => { setPaidAtFrom(""); setPaidAtTo(""); setProductTypeFilter(new Set()); }}
                  className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                  <X className="w-3.5 h-3.5" /> ล้างทั้งหมด
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Tab switcher ── */}
        <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-0">
          {(["count", "paid", "due"] as TabKey[]).map((t) => {
            const labels: Record<TabKey, string> = { count: "จำนวนสัญญา", paid: "ยอดชำระแล้ว", due: "ยอดค้างชำระ" };
            const activeColors: Record<TabKey, string> = { count: "border-slate-600 text-slate-700", paid: "border-green-600 text-green-700", due: "border-orange-600 text-orange-700" };
            return (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={["px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  tab === t ? activeColors[t] : "border-transparent text-gray-400 hover:text-gray-600"].join(" ")}>
                {labels[t]}
              </button>
            );
          })}
        </div>

        {/* ── Badge panel: ยอดชำระแล้ว ── */}
        {tab === "paid" && (
          <div className="bg-green-50/60 border-b border-green-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {PAID_BADGE_ITEMS.map(({ key, label, icon, canToggle }) => {
              const isOn = paidVis[key];
              const val  = grandBadgePaid[key as keyof MoneyBreakdown];
              return (
                <button key={key} type="button"
                  onClick={() => { if (!canToggle) return; setPaidVis((prev) => ({ ...prev, [key]: !prev[key] })); }}
                  title={canToggle ? (isOn ? `ซ่อน${label}` : `แสดง${label}`) : `${label} (ปิดเสมอ)`}
                  className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",
                    !canToggle ? "opacity-40 cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400"
                    : isOn ? "bg-green-100 border-green-300 text-green-800 hover:bg-green-200"
                    : "bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                  {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {icon}
                  <span>{label}</span>
                  {isOn && <span className="font-semibold ml-0.5">{fmtMoney(val)}</span>}
                </button>
              );
            })}
            {/* รวมยอดชำระ */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-green-700 border-green-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5" />
              <span>รวมยอดชำระ</span>
              <span>{fmtMoney(computePaidTotal(grandBadgePaid, paidVis))}</span>
            </div>
          </div>
        )}

        {/* ── Badge panel: ยอดค้างชำระ ── */}
        {tab === "due" && (
          <div className="bg-orange-50/60 border-b border-orange-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {DUE_BADGE_ITEMS.map(({ key, label, icon, canToggle }) => {
              const isOn = dueVis[key];
              const val  = grandBadgeDue[key as keyof MoneyBreakdown];
              return (
                <button key={key} type="button"
                  onClick={() => { if (!canToggle) return; setDueVis((prev) => ({ ...prev, [key]: !prev[key] })); }}
                  title={isOn ? `ซ่อน${label}` : `แสดง${label}`}
                  className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",
                    isOn ? "bg-orange-100 border-orange-300 text-orange-800 hover:bg-orange-200"
                    : "bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                  {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {icon}
                  <span>{label}</span>
                  {isOn && <span className="font-semibold ml-0.5">{fmtMoney(val)}</span>}
                </button>
              );
            })}
            {/* รวมยอดค้างชำระ */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-orange-700 border-orange-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5" />
              <span>รวมยอดค้างชำระ</span>
              <span>{fmtMoney(computeDueTotal(grandBadgeDue, dueVis))}</span>
            </div>
          </div>
        )}

        {/* ── Table ── */}
        <div className="flex-1 min-h-0 overflow-auto">
          {!canView ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">คุณไม่มีสิทธิ์ดูข้อมูลนี้</div>
          ) : query.isLoading ? (
            <div className="flex items-center justify-center h-full gap-2 text-gray-400">
              <Spinner className="w-5 h-5" /><span className="text-sm">กำลังโหลด...</span>
            </div>
          ) : query.error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-red-500">
              <span className="text-sm">โหลดข้อมูลล้มเหลว: {query.error.message}</span>
              <Button variant="outline" size="sm" onClick={() => query.refetch()}><RefreshCw className="w-4 h-4 mr-1" /> ลองใหม่</Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">ไม่มีข้อมูล</div>
          ) : (
            <SummaryTable
              tab={tab}
              rows={rows}
              grandTotal={grandTotal}
              visibleBuckets={visibleBuckets}
              hiddenBuckets={hiddenBuckets}
              toggleBucket={toggleBucket}
              toggleGroup={toggleGroup}
              paidVis={paidVis}
              dueVis={dueVis}
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* SummaryTable                                                        */
/* ─────────────────────────────────────────────────────────────────── */

type GrandTotal = {
  bucketTotals: Record<string, { count: number; paid: MoneyBreakdown; due: MoneyBreakdown }>;
  totalCount: number;
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
};

function SummaryTable({
  tab, rows, grandTotal, visibleBuckets, hiddenBuckets, toggleBucket, toggleGroup, paidVis, dueVis,
}: {
  tab: TabKey;
  rows: SummaryRow[];
  grandTotal: GrandTotal;
  visibleBuckets: readonly string[];
  hiddenBuckets: Set<string>;
  toggleBucket: (b: string) => void;
  toggleGroup: (g: ColGroup) => void;
  paidVis: Record<PaidBadgeKey, boolean>;
  dueVis: Record<DueBadgeKey, boolean>;
}) {
  /** bucket "หนี้เสีย" ในแถบ paid แบ่งเป็น 2 sub-columns */
  const isPaidBadDebt = (b: string) => tab === "paid" && b === "หนี้เสีย";

  /** คำนวณ colspan ต่อ bucket */
  const bucketSpan = (b: string) => isPaidBadDebt(b) ? 2 : 1;

  /** minWidth รวม */
  const minWidth = useMemo(() => {
    let w = 130 + 90; // เดือน + สัญญา
    for (const b of visibleBuckets) w += isPaidBadDebt(b) ? 240 : 120;
    w += 130; // รวม
    return w;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleBuckets, tab]);

  return (
    <table className="w-full text-sm border-collapse" style={{ minWidth: `${minWidth}px` }}>
      <thead className="sticky top-0 z-20">
        {/* ── Row 1: Group headers ── */}
        <tr>
          {/* Pin col 1: เดือน */}
          <th rowSpan={3} className="sticky left-0 z-30 px-3 py-2 text-left font-semibold whitespace-nowrap bg-slate-800 text-white border-r border-slate-600 min-w-[130px]">
            เดือน-ปีที่อนุมัติ
          </th>
          {/* Pin col 2: สัญญา */}
          <th rowSpan={3} className="sticky left-[130px] z-30 px-3 py-2 text-right font-semibold whitespace-nowrap bg-slate-700 text-white border-r border-slate-500 min-w-[90px]">
            สัญญา
          </th>
          {/* Column groups */}
          {COL_GROUPS.map((group) => {
            const visInGroup = group.buckets.filter((b) => !hiddenBuckets.has(b));
            if (visInGroup.length === 0) return null;
            const span = visInGroup.reduce((acc, b) => acc + bucketSpan(b), 0);
            const allHidden = group.buckets.every((b) => hiddenBuckets.has(b));
            return (
              <th key={group.key} colSpan={span}
                className={`px-2 py-1.5 text-center text-xs font-bold text-white border-r border-white/20 ${group.headerBg}`}>
                <button type="button" onClick={() => toggleGroup(group)}
                  className="flex items-center justify-center gap-1.5 mx-auto hover:opacity-80 transition-opacity"
                  title={allHidden ? `แสดง${group.label}` : `ซ่อน${group.label}`}>
                  {allHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {group.label}
                </button>
              </th>
            );
          })}
          {/* รวม */}
          <th rowSpan={3} className="px-3 py-2 text-right font-semibold whitespace-nowrap text-white bg-slate-800 min-w-[130px]">
            รวมทั้งหมด
          </th>
        </tr>

        {/* ── Row 2: Bucket headers ── */}
        <tr>
          {visibleBuckets.map((b) => (
            <th key={b} colSpan={bucketSpan(b)}
              className={`px-2 py-1.5 text-center text-xs font-semibold text-white whitespace-nowrap min-w-[120px] border-r border-white/10 ${bucketHeaderBg(b)}`}>
              <div className="flex items-center justify-center gap-1">
                <button type="button" onClick={() => toggleBucket(b)} className="hover:opacity-80 transition-opacity"
                  title={hiddenBuckets.has(b) ? `แสดง${b}` : `ซ่อน${b}`}>
                  {hiddenBuckets.has(b) ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
              </div>
            </th>
          ))}
        </tr>

        {/* ── Row 3: Sub-column labels ── */}
        <tr>
          {visibleBuckets.map((b) => {
            if (isPaidBadDebt(b)) {
              return (
                <React.Fragment key={b}>
                  <th className={`px-2 py-1 text-center text-[10px] font-medium text-white/90 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>
                    ยอดชำระ
                  </th>
                  <th className={`px-2 py-1 text-center text-[10px] font-medium text-red-200 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>
                    หนี้เสีย
                  </th>
                </React.Fragment>
              );
            }
            return (
              <th key={b} className={`px-2 py-1 text-center text-[10px] font-medium text-white/70 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>
                {tab === "count" ? "สัญญา" : tab === "paid" ? "ยอดชำระ" : "ยอดค้าง"}
              </th>
            );
          })}
        </tr>
      </thead>

      <tbody>
        {rows.map((row, idx) => {
          const isEven = idx % 2 === 0;
          const rowBg    = isEven ? "bg-white" : "bg-slate-50/60";
          const pinBg    = isEven ? "bg-white" : "bg-slate-50";

          return (
            <tr key={row.approveMonth} className={`border-b border-gray-100 hover:bg-blue-50/30 transition-colors ${rowBg}`}>
              {/* Pin col 1: เดือน */}
              <td className={`sticky left-0 z-10 px-3 py-2.5 font-semibold text-slate-700 whitespace-nowrap border-r border-gray-200 ${pinBg}`}>
                {fmtMonthYear(row.approveMonth)}
              </td>
              {/* Pin col 2: จำนวนสัญญารวม */}
              <td className={`sticky left-[130px] z-10 px-3 py-2.5 text-right border-r border-gray-200 ${pinBg}`}>
                <span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2 py-0.5 text-xs font-bold">
                  {row.totalCount.toLocaleString()}
                </span>
              </td>

              {/* Bucket cells */}
              {visibleBuckets.map((b) => {
                const cell   = row.buckets[b];
                const cellBg = bucketCellBg(b);

                if (tab === "count") {
                  return (
                    <td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>
                      {cell?.contractCount ? (
                        <span className="inline-flex items-center justify-center bg-slate-200/80 text-slate-700 rounded-full px-2 py-0.5 text-xs font-semibold">
                          {cell.contractCount.toLocaleString()}
                        </span>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  );
                }

                if (tab === "paid") {
                  if (isPaidBadDebt(b)) {
                    const paidVal    = cell ? computePaidTotal(cell.paid, paidVis) : 0;
                    const badDebtVal = cell?.paid.badDebt ?? 0;
                    return (
                      <React.Fragment key={b}>
                        <td className={`px-3 py-2.5 text-right font-medium ${cellBg} ${paidVal > 0 ? "text-green-800" : "text-gray-300"}`}>
                          {fmtMoney(paidVal)}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-bold ${cellBg} ${badDebtVal > 0 ? "text-red-700" : "text-gray-300"}`}>
                          {fmtMoney(badDebtVal)}
                        </td>
                      </React.Fragment>
                    );
                  }
                  const val = cell ? computePaidTotal(cell.paid, paidVis) : 0;
                  return (
                    <td key={b} className={`px-3 py-2.5 text-right font-medium ${cellBg} ${val > 0 ? "text-green-800" : "text-gray-300"}`}>
                      {fmtMoney(val)}
                    </td>
                  );
                }

                // due
                const val = cell ? computeDueTotal(cell.due, dueVis) : 0;
                return (
                  <td key={b} className={`px-3 py-2.5 text-right font-medium ${cellBg} ${val > 0 ? "text-orange-800" : "text-gray-300"}`}>
                    {fmtMoney(val)}
                  </td>
                );
              })}

              {/* รวม */}
              {tab === "count" && (
                <td className="px-3 py-2.5 text-right bg-slate-100/60">
                  <span className="inline-flex items-center justify-center bg-slate-300 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">
                    {row.totalCount.toLocaleString()}
                  </span>
                </td>
              )}
              {tab === "paid" && (
                <td className="px-3 py-2.5 text-right font-bold text-green-900 bg-green-50/50">
                  {fmtMoney(computePaidTotal(row.totalPaid, paidVis))}
                </td>
              )}
              {tab === "due" && (
                <td className="px-3 py-2.5 text-right font-bold text-orange-900 bg-orange-50/50">
                  {fmtMoney(computeDueTotal(row.totalDue, dueVis))}
                </td>
              )}
            </tr>
          );
        })}

        {/* ── Grand total row ── */}
        <tr className="border-t-2 border-slate-400 bg-slate-100 font-bold sticky bottom-0 z-10">
          <td className="sticky left-0 z-20 px-3 py-2.5 text-slate-800 whitespace-nowrap border-r border-slate-300 bg-slate-200">
            รวมทั้งหมด
          </td>
          <td className="sticky left-[130px] z-20 px-3 py-2.5 text-right border-r border-slate-300 bg-slate-200">
            <span className="inline-flex items-center justify-center bg-slate-400 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">
              {grandTotal.totalCount.toLocaleString()}
            </span>
          </td>

          {visibleBuckets.map((b) => {
            const bt     = grandTotal.bucketTotals[b];
            const cellBg = bucketCellBg(b);

            if (tab === "count") {
              return (
                <td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>
                  <span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">
                    {bt.count.toLocaleString()}
                  </span>
                </td>
              );
            }

            if (tab === "paid") {
              if (isPaidBadDebt(b)) {
                const paidVal    = computePaidTotal(bt.paid, paidVis);
                const badDebtVal = bt.paid.badDebt;
                return (
                  <React.Fragment key={b}>
                    <td className={`px-3 py-2.5 text-right ${cellBg} ${paidVal > 0 ? "text-green-900" : "text-gray-400"}`}>
                      {fmtMoney(paidVal)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-bold ${cellBg} ${badDebtVal > 0 ? "text-red-700" : "text-gray-400"}`}>
                      {fmtMoney(badDebtVal)}
                    </td>
                  </React.Fragment>
                );
              }
              const val = computePaidTotal(bt.paid, paidVis);
              return (
                <td key={b} className={`px-3 py-2.5 text-right ${cellBg} ${val > 0 ? "text-green-900" : "text-gray-400"}`}>
                  {fmtMoney(val)}
                </td>
              );
            }

            const val = computeDueTotal(bt.due, dueVis);
            return (
              <td key={b} className={`px-3 py-2.5 text-right ${cellBg} ${val > 0 ? "text-orange-900" : "text-gray-400"}`}>
                {fmtMoney(val)}
              </td>
            );
          })}

          {tab === "count" && (
            <td className="px-3 py-2.5 text-right bg-slate-200">
              <span className="inline-flex items-center justify-center bg-slate-500 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">
                {grandTotal.totalCount.toLocaleString()}
              </span>
            </td>
          )}
          {tab === "paid" && (
            <td className="px-3 py-2.5 text-right font-bold text-green-900 bg-green-100">
              {fmtMoney(computePaidTotal(grandTotal.totalPaid, paidVis))}
            </td>
          )}
          {tab === "due" && (
            <td className="px-3 py-2.5 text-right font-bold text-orange-900 bg-orange-100">
              {fmtMoney(computeDueTotal(grandTotal.totalDue, dueVis))}
            </td>
          )}
        </tr>
      </tbody>
    </table>
  );
}

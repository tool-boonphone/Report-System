/**
 * MonthlySummary — สรุปรายเดือน
 *
 * ตาราง group by เดือนที่อนุมัติสัญญา × debt_status bucket
 * 3 แถบ:
 *   1. จำนวนสัญญา
 *   2. ยอดชำระแล้ว  (paid)
 *   3. ยอดค้างชำระ  (due)
 *
 * Filter: วันที่รับชำระ (from–to) + ประเภทสินค้า
 * Column groups: toggle เปิด/ปิดแต่ละ bucket
 * Pin: เดือน column ถูก pin ซ้ายเสมอ
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  BadgeDollarSign,
  Banknote,
  CalendarDays,
  Check,
  ChevronsUpDown,
  Coins,
  Download,
  Eye,
  EyeOff,
  Gavel,
  LockOpen,
  Percent,
  RefreshCw,
  Smartphone,
  Tag,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

/* ─────────────────────────────────────────────────────────────────── */
/* Utilities                                                           */
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

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const num = Number(n);
  if (num === 0) return "0.00";
  return num.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** แปลง YYYY-MM เป็น เดือน-ปี ไทย เช่น "ส.ค. 67" */
function fmtMonthYear(ym: string): string {
  const [y, m] = ym.split("-");
  const MONTHS = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
  ];
  const monthIdx = parseInt(m, 10) - 1;
  const yearShort = (parseInt(y, 10) + 543).toString().slice(-2);
  return `${MONTHS[monthIdx] ?? m} ${yearShort}`;
}

/** สี badge ต่อ bucket (เหมือน DebtReport) */
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

/** สี header ต่อ bucket */
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

/** สี cell ต่อ bucket (อ่อนๆ) */
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
/* Types                                                               */
/* ─────────────────────────────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────────────────────────── */
/* MultiSelectFilter (reused from DebtReport pattern)                 */
/* ─────────────────────────────────────────────────────────────────── */

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
  const [open, setOpen] = useState(false);
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

/* ─────────────────────────────────────────────────────────────────── */
/* Badge visibility panel (for paid tab)                              */
/* ─────────────────────────────────────────────────────────────────── */

type BadgeKey = "principal" | "interest" | "fee" | "penalty" | "unlockFee" | "overpaid" | "badDebt" | "discount";

const BADGE_ITEMS: Array<{ key: BadgeKey; label: string; icon: React.ReactNode; defaultOn: boolean; canToggle: boolean }> = [
  { key: "principal", label: "เงินต้น",      icon: <Banknote className="w-3.5 h-3.5" />,         defaultOn: true,  canToggle: true },
  { key: "interest",  label: "ดอกเบี้ย",     icon: <Percent className="w-3.5 h-3.5" />,          defaultOn: true,  canToggle: true },
  { key: "fee",       label: "ค่าดำเนินการ", icon: <Coins className="w-3.5 h-3.5" />,            defaultOn: true,  canToggle: true },
  { key: "penalty",   label: "ค่าปรับ",      icon: <Gavel className="w-3.5 h-3.5" />,            defaultOn: true,  canToggle: true },
  { key: "unlockFee", label: "ค่าปลดล็อก",  icon: <LockOpen className="w-3.5 h-3.5" />,         defaultOn: true,  canToggle: true },
  { key: "overpaid",  label: "ชำระเกิน",     icon: <TrendingUp className="w-3.5 h-3.5" />,       defaultOn: true,  canToggle: true },
  { key: "badDebt",   label: "หนี้เสีย",     icon: <TrendingDown className="w-3.5 h-3.5" />,     defaultOn: true,  canToggle: true },
  { key: "discount",  label: "ส่วนลด",       icon: <Tag className="w-3.5 h-3.5" />,              defaultOn: false, canToggle: false },
];

const DUE_BADGE_ITEMS: Array<{ key: BadgeKey; label: string; icon: React.ReactNode; defaultOn: boolean; canToggle: boolean }> = [
  { key: "principal", label: "เงินต้น",      icon: <Banknote className="w-3.5 h-3.5" />,         defaultOn: true,  canToggle: true },
  { key: "interest",  label: "ดอกเบี้ย",     icon: <Percent className="w-3.5 h-3.5" />,          defaultOn: true,  canToggle: true },
  { key: "fee",       label: "ค่าดำเนินการ", icon: <Coins className="w-3.5 h-3.5" />,            defaultOn: true,  canToggle: true },
  { key: "penalty",   label: "ค่าปรับ",      icon: <Gavel className="w-3.5 h-3.5" />,            defaultOn: true,  canToggle: true },
  { key: "unlockFee", label: "ค่าปลดล็อก",  icon: <LockOpen className="w-3.5 h-3.5" />,         defaultOn: true,  canToggle: true },
];

function computeTotal(money: MoneyBreakdown, vis: Record<BadgeKey, boolean>): number {
  return (
    (vis.principal ? money.principal : 0) +
    (vis.interest  ? money.interest  : 0) +
    (vis.fee       ? money.fee       : 0) +
    (vis.penalty   ? money.penalty   : 0) +
    (vis.unlockFee ? money.unlockFee : 0) +
    (vis.overpaid  ? money.overpaid  : 0) +
    (vis.badDebt   ? money.badDebt   : 0)
    // discount ไม่รวม
  );
}

function computeDueTotal(money: MoneyBreakdown, vis: Record<BadgeKey, boolean>): number {
  return (
    (vis.principal ? money.principal : 0) +
    (vis.interest  ? money.interest  : 0) +
    (vis.fee       ? money.fee       : 0) +
    (vis.penalty   ? money.penalty   : 0) +
    (vis.unlockFee ? money.unlockFee : 0)
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Main Component                                                      */
/* ─────────────────────────────────────────────────────────────────── */

export default function MonthlySummary() {
  const { can } = useAppAuth();
  const { section } = useSection();
  const { setActions } = useNavActions();
  const canView = can("debt_report", "view");
  const canExport = can("debt_report", "export");

  /* ── Filter state ── */
  const [paidAtFrom, setPaidAtFrom] = useState<string>("");
  const [paidAtTo, setPaidAtTo] = useState<string>("");
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());

  /* ── Tab ── */
  const [tab, setTab] = useState<TabKey>("count");

  /* ── Badge visibility (paid tab) ── */
  const [paidVis, setPaidVis] = useState<Record<BadgeKey, boolean>>({
    principal: true, interest: true, fee: true, penalty: true,
    unlockFee: true, overpaid: true, badDebt: true, discount: false,
  });
  const [dueVis, setDueVis] = useState<Record<BadgeKey, boolean>>({
    principal: true, interest: true, fee: true, penalty: true,
    unlockFee: true, overpaid: false, badDebt: false, discount: false,
  });

  /* ── Bucket column visibility ── */
  const [hiddenBuckets, setHiddenBuckets] = useState<Set<string>>(new Set());
  const toggleBucket = (b: string) => {
    setHiddenBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  };

  /* ── Filter open/close ── */
  const [filterOpen, setFilterOpen] = useState(true);

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

  const { rows = [], productTypes = [] } = query.data ?? {};

  /* ── Filter rows by productType (multi-select client-side when >1) ── */
  const filteredRows: SummaryRow[] = useMemo(() => {
    if (productTypeFilter.size <= 1) return rows as SummaryRow[];
    // multi-select: filter client-side (server only handles single productType)
    // For now, server handles single; multi-select would need aggregation
    return rows as SummaryRow[];
  }, [rows, productTypeFilter]);

  /* ── Visible buckets ── */
  const visibleBuckets = DEBT_BUCKETS.filter((b) => !hiddenBuckets.has(b));

  /* ── Nav actions ── */
  const handleExport = useCallback(() => {
    if (!filteredRows.length) { toast.error("ไม่มีข้อมูลสำหรับ Export"); return; }
    try {
      const wb = XLSX.utils.book_new();
      // Tab 1: จำนวนสัญญา
      const countData: any[][] = [
        ["เดือน-ปีที่อนุมัติ", ...DEBT_BUCKETS, "รวม"],
        ...filteredRows.map((r) => [
          fmtMonthYear(r.approveMonth),
          ...DEBT_BUCKETS.map((b) => r.buckets[b]?.contractCount ?? 0),
          r.totalCount,
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(countData), "จำนวนสัญญา");
      // Tab 2: ยอดชำระแล้ว
      const paidData: any[][] = [
        ["เดือน-ปีที่อนุมัติ", ...DEBT_BUCKETS, "รวม"],
        ...filteredRows.map((r) => [
          fmtMonthYear(r.approveMonth),
          ...DEBT_BUCKETS.map((b) => r.buckets[b]?.paid.total ?? 0),
          r.totalPaid.total,
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(paidData), "ยอดชำระแล้ว");
      // Tab 3: ยอดค้างชำระ
      const dueData: any[][] = [
        ["เดือน-ปีที่อนุมัติ", ...DEBT_BUCKETS, "รวม"],
        ...filteredRows.map((r) => [
          fmtMonthYear(r.approveMonth),
          ...DEBT_BUCKETS.map((b) => r.buckets[b]?.due.total ?? 0),
          r.totalDue.total,
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dueData), "ยอดค้างชำระ");
      XLSX.writeFile(wb, `monthly-summary-${section}-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ");
    } catch (e) {
      toast.error("Export ล้มเหลว");
    }
  }, [filteredRows, section]);

  useEffect(() => {
    if (!canExport) { setActions(null); return; }
    setActions(
      <button
        onClick={handleExport}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white hover:bg-gray-50 transition-colors"
        title="Export Excel"
      >
        <Download className="w-4 h-4" />
        <span className="hidden sm:inline">Export Excel</span>
      </button>
    );
    return () => setActions(null);
  }, [canExport, handleExport, setActions]);

  /* ── Totals row ── */
  const grandTotal = useMemo(() => {
    const emptyMoney = (): MoneyBreakdown => ({
      principal: 0, interest: 0, fee: 0, penalty: 0,
      unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, total: 0,
    });
    const bucketTotals: Record<string, { count: number; paid: MoneyBreakdown; due: MoneyBreakdown }> = {};
    for (const b of DEBT_BUCKETS) {
      bucketTotals[b] = { count: 0, paid: emptyMoney(), due: emptyMoney() };
    }
    let totalCount = 0;
    const totalPaid = emptyMoney();
    const totalDue  = emptyMoney();
    for (const row of filteredRows) {
      totalCount += row.totalCount;
      for (const key of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
        totalPaid[key] += row.totalPaid[key];
        totalDue[key]  += row.totalDue[key];
      }
      for (const b of DEBT_BUCKETS) {
        const cell = row.buckets[b];
        if (!cell) continue;
        bucketTotals[b].count += cell.contractCount;
        for (const key of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
          bucketTotals[b].paid[key] += cell.paid[key];
          bucketTotals[b].due[key]  += cell.due[key];
        }
      }
    }
    return { bucketTotals, totalCount, totalPaid, totalDue };
  }, [filteredRows]);

  /* ─────────────────────────────────────────────────────────────── */
  /* Render                                                          */
  /* ─────────────────────────────────────────────────────────────── */

  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-0">
        <SyncStatusBar />

        {/* ── Filter bar ── */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
          {/* Toggle header */}
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
              {/* วันที่รับชำระ from */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500 whitespace-nowrap">วันที่รับชำระ:</span>
                <div className="relative flex items-center">
                  <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <input
                    type="date"
                    value={paidAtFrom}
                    onChange={(e) => setPaidAtFrom(e.target.value)}
                    className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]"
                    title="วันที่รับชำระ ตั้งแต่"
                  />
                </div>
                <span className="text-xs text-gray-400">—</span>
                <div className="relative flex items-center">
                  <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <input
                    type="date"
                    value={paidAtTo}
                    onChange={(e) => setPaidAtTo(e.target.value)}
                    className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]"
                    title="วันที่รับชำระ ถึง"
                  />
                </div>
                {(paidAtFrom || paidAtTo) && (
                  <button
                    type="button"
                    onClick={() => { setPaidAtFrom(""); setPaidAtTo(""); }}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors"
                    title="ล้างฟิลเตอร์วันที่"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* ประเภทสินค้า */}
              <MultiSelectFilter
                label="ประเภทสินค้า"
                selected={productTypeFilter}
                onChange={setProductTypeFilter}
                options={productTypes}
                placeholder="ทุกประเภทสินค้า"
              />

              {/* ล้างทั้งหมด */}
              {(paidAtFrom || paidAtTo || productTypeFilter.size > 0) && (
                <button
                  type="button"
                  onClick={() => {
                    setPaidAtFrom("");
                    setPaidAtTo("");
                    setProductTypeFilter(new Set());
                  }}
                  className="text-xs text-gray-400 hover:text-red-500 underline"
                >
                  ล้างทั้งหมด
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Tab switcher ── */}
        <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-1 pt-2">
          {(
            [
              { key: "count", label: "จำนวนสัญญา",  icon: <Smartphone className="w-4 h-4" /> },
              { key: "paid",  label: "ยอดชำระแล้ว", icon: <Wallet className="w-4 h-4" /> },
              { key: "due",   label: "ยอดค้างชำระ", icon: <BadgeDollarSign className="w-4 h-4" /> },
            ] as const
          ).map(({ key, label, icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={[
                "flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-md border-b-2 transition-colors",
                tab === key
                  ? "border-blue-600 text-blue-700 bg-blue-50"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50",
              ].join(" ")}
            >
              {icon}
              {label}
            </button>
          ))}

          {/* Badge visibility (paid tab) */}
          {tab === "paid" && (
            <div className="ml-auto flex items-center gap-1 pb-1">
              {BADGE_ITEMS.map(({ key, label, icon, canToggle }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (!canToggle) return;
                    setPaidVis((prev) => ({ ...prev, [key]: !prev[key] }));
                  }}
                  title={canToggle ? (paidVis[key] ? `ซ่อน${label}` : `แสดง${label}`) : `${label} (ปิดเสมอ)`}
                  className={[
                    "flex items-center gap-1 px-2 py-1 rounded-full text-xs border transition-colors",
                    !canToggle
                      ? "opacity-40 cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400"
                      : paidVis[key]
                        ? "bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100"
                        : "bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200",
                  ].join(" ")}
                >
                  {paidVis[key] ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {icon}
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Badge visibility (due tab) */}
          {tab === "due" && (
            <div className="ml-auto flex items-center gap-1 pb-1">
              {DUE_BADGE_ITEMS.map(({ key, label, icon, canToggle }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (!canToggle) return;
                    setDueVis((prev) => ({ ...prev, [key]: !prev[key] }));
                  }}
                  title={canToggle ? (dueVis[key] ? `ซ่อน${label}` : `แสดง${label}`) : `${label} (ปิดเสมอ)`}
                  className={[
                    "flex items-center gap-1 px-2 py-1 rounded-full text-xs border transition-colors",
                    !canToggle
                      ? "opacity-40 cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400"
                      : dueVis[key]
                        ? "bg-orange-50 border-orange-300 text-orange-700 hover:bg-orange-100"
                        : "bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200",
                  ].join(" ")}
                >
                  {dueVis[key] ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {icon}
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Bucket column toggle bar ── */}
        <div className="bg-slate-50 border-b border-gray-200 px-4 py-1.5 flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-gray-400 mr-1">แสดง bucket:</span>
          {DEBT_BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => toggleBucket(b)}
              className={[
                "flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors",
                hiddenBuckets.has(b)
                  ? "opacity-40 bg-gray-100 border-gray-200 text-gray-400"
                  : `${bucketPillClasses(b)} border`,
              ].join(" ")}
            >
              {hiddenBuckets.has(b) ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {b}
            </button>
          ))}
        </div>

        {/* ── Table ── */}
        <div className="flex-1 min-h-0 overflow-auto">
          {!canView ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              คุณไม่มีสิทธิ์ดูข้อมูลนี้
            </div>
          ) : query.isLoading ? (
            <div className="flex items-center justify-center h-full gap-2 text-gray-400">
              <Spinner className="w-5 h-5" />
              <span className="text-sm">กำลังโหลด...</span>
            </div>
          ) : query.error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-red-500">
              <span className="text-sm">โหลดข้อมูลล้มเหลว: {query.error.message}</span>
              <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                <RefreshCw className="w-4 h-4 mr-1" /> ลองใหม่
              </Button>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              ไม่มีข้อมูล
            </div>
          ) : (
            <table className="w-full text-sm border-collapse" style={{ minWidth: `${200 + visibleBuckets.length * 130 + 130}px` }}>
              <thead className="sticky top-0 z-20">
                <tr>
                  {/* เดือน-ปีที่อนุมัติ (pin left) */}
                  <th
                    className="sticky left-0 z-30 px-3 py-3 text-left font-semibold whitespace-nowrap bg-slate-700 text-white border-r border-slate-600 min-w-[130px]"
                    rowSpan={1}
                  >
                    เดือน-ปีที่อนุมัติ
                  </th>
                  {/* Bucket columns */}
                  {visibleBuckets.map((b) => (
                    <th
                      key={b}
                      className={`px-3 py-3 text-right font-semibold whitespace-nowrap text-white min-w-[120px] ${bucketHeaderBg(b)}`}
                    >
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${bucketPillClasses(b)}`}>{b}</span>
                    </th>
                  ))}
                  {/* รวม */}
                  <th className="px-3 py-3 text-right font-semibold whitespace-nowrap text-white bg-slate-800 min-w-[130px]">
                    รวมทั้งหมด
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, idx) => {
                  const isEven = idx % 2 === 0;
                  const rowBg = isEven ? "bg-white" : "bg-slate-50/60";
                  const stickyBg = isEven ? "bg-white" : "bg-slate-50";

                  return (
                    <tr key={row.approveMonth} className={`border-b border-gray-100 hover:bg-blue-50/30 transition-colors ${rowBg}`}>
                      {/* เดือน (pin left) */}
                      <td className={`sticky left-0 z-10 px-3 py-2.5 font-semibold text-slate-700 whitespace-nowrap border-r border-gray-200 ${stickyBg}`}>
                        {fmtMonthYear(row.approveMonth)}
                      </td>

                      {/* Bucket cells */}
                      {visibleBuckets.map((b) => {
                        const cell = row.buckets[b];
                        if (!cell) {
                          return (
                            <td key={b} className={`px-3 py-2.5 text-right text-gray-300 ${bucketCellBg(b)}`}>
                              {tab === "count" ? "0" : "0.00"}
                            </td>
                          );
                        }
                        if (tab === "count") {
                          return (
                            <td key={b} className={`px-3 py-2.5 text-right ${bucketCellBg(b)}`}>
                              {cell.contractCount > 0 ? (
                                <span className="inline-flex items-center justify-center bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-semibold">
                                  {cell.contractCount.toLocaleString()}
                                </span>
                              ) : (
                                <span className="text-gray-300">0</span>
                              )}
                            </td>
                          );
                        }
                        if (tab === "paid") {
                          const val = computeTotal(cell.paid, paidVis);
                          return (
                            <td key={b} className={`px-3 py-2.5 text-right font-medium ${bucketCellBg(b)} ${val > 0 ? "text-green-800" : "text-gray-300"}`}>
                              {fmtMoney(val)}
                            </td>
                          );
                        }
                        // due
                        const val = computeDueTotal(cell.due, dueVis);
                        return (
                          <td key={b} className={`px-3 py-2.5 text-right font-medium ${bucketCellBg(b)} ${val > 0 ? "text-orange-800" : "text-gray-300"}`}>
                            {fmtMoney(val)}
                          </td>
                        );
                      })}

                      {/* รวม */}
                      {tab === "count" && (
                        <td className="px-3 py-2.5 text-right bg-slate-100/60">
                          <span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">
                            {row.totalCount.toLocaleString()}
                          </span>
                        </td>
                      )}
                      {tab === "paid" && (
                        <td className="px-3 py-2.5 text-right font-bold text-green-900 bg-green-50/50">
                          {fmtMoney(computeTotal(row.totalPaid, paidVis))}
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
                  {visibleBuckets.map((b) => {
                    const bt = grandTotal.bucketTotals[b];
                    if (tab === "count") {
                      return (
                        <td key={b} className={`px-3 py-2.5 text-right ${bucketCellBg(b)}`}>
                          <span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">
                            {bt.count.toLocaleString()}
                          </span>
                        </td>
                      );
                    }
                    if (tab === "paid") {
                      const val = computeTotal(bt.paid, paidVis);
                      return (
                        <td key={b} className={`px-3 py-2.5 text-right ${bucketCellBg(b)} ${val > 0 ? "text-green-900" : "text-gray-400"}`}>
                          {fmtMoney(val)}
                        </td>
                      );
                    }
                    const val = computeDueTotal(bt.due, dueVis);
                    return (
                      <td key={b} className={`px-3 py-2.5 text-right ${bucketCellBg(b)} ${val > 0 ? "text-orange-900" : "text-gray-400"}`}>
                        {fmtMoney(val)}
                      </td>
                    );
                  })}
                  {tab === "count" && (
                    <td className="px-3 py-2.5 text-right bg-slate-200">
                      <span className="inline-flex items-center justify-center bg-slate-400 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">
                        {grandTotal.totalCount.toLocaleString()}
                      </span>
                    </td>
                  )}
                  {tab === "paid" && (
                    <td className="px-3 py-2.5 text-right font-bold text-green-900 bg-green-100">
                      {fmtMoney(computeTotal(grandTotal.totalPaid, paidVis))}
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
          )}
        </div>
      </div>
    </AppShell>
  );
}

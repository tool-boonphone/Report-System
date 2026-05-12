/**
 * BadDebtSummary — Phase 142
 * หน้าสรุปกำไร/ขาดทุนจากหนี้เสีย แบ่งเป็น 3 แถบหลัก:
 *   1. สรุปรายปี  → sub-tab: ตามปีที่ขาย | ตามปีที่อนุมัติ (มี % หนี้เสีย)
 *   2. สรุปรายเดือน → sub-tab: ตามเดือนที่ขาย | ตามเดือนที่อนุมัติ (มี % หนี้เสีย)
 *   3. รายการขายเครื่อง
 */
import React, { useMemo, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Banknote,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  TrendingDown,
  TrendingUp,
  Wallet,
  Download,
  CalendarDays,
  CalendarRange,
  List,
  Check,
  X,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* ─── helpers ─────────────────────────────────────────────────────────────── */

/** Derive iOS/Android from model string */
const deriveOS = (model: string | null): "iOS" | "Android" | null => {
  if (!model) return null;
  const m = model.toLowerCase();
  if (
    m.startsWith("iphone") ||
    m.startsWith("ipad") ||
    m.startsWith("ไอโฟน") ||
    m.startsWith("ไอแพด")
  )
    return "iOS";
  return "Android";
};

/** Parse model name: extract base model (ตัด capacity ออก) */
const parseModelBase = (model: string | null): string | null => {
  if (!model) return null;
  const capMatch = model.match(/(\d+)\s*[Gg][Bb]/);
  if (capMatch) return model.replace(/\s*\d+\s*[Gg][Bb].*$/, "").trim();
  return model.trim();
};
const fmtMoney = (v: number | null | undefined) =>
  v == null
    ? "-"
    : v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (s: string | null | undefined) => {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
};

const fmtMonthLabel = (ym: string) => {
  const [y, m] = ym.split("-");
  const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const mIdx = parseInt(m, 10) - 1;
  const buddhistYear = parseInt(y, 10) + 543;
  return `${monthNames[mIdx] ?? m} ${buddhistYear}`;
};

type SortKey =
  | "contractNo" | "approveDate" | "financeAmount" | "commissionNet"
  | "installmentPaid" | "deviceSaleAmount" | "totalRevenue" | "cost"
  | "profitLoss" | "saleDate";
type MonthlySortKey = "ym" | "count" | "financeAmount" | "commissionNet" | "cost" | "installmentPaid" | "deviceSaleAmount" | "totalRevenue" | "profitLoss";
type MonthlySortKeyWithRate = MonthlySortKey | "badDebtRate";
type YearlySortKey = "year" | "count" | "financeAmount" | "commissionNet" | "cost" | "installmentPaid" | "deviceSaleAmount" | "totalRevenue" | "profitLoss";
type YearlySortKeyWithRate = YearlySortKey | "badDebtRate";
type SortDir = "asc" | "desc";
type ActiveTab = "list" | "monthly" | "yearly";
type MonthlySubTab = "bySale" | "byApprove";
type YearlySubTab = "bySale" | "byApprove";

/* ─── BadDebtRateBadge ──────────────────────────────────────────────────────── */
/**
 * แสดง % หนี้เสีย พร้อม Tooltip อธิบายที่มาของตัวเลข
 * สูตร: จำนวนสัญญาหนี้เสียที่อนุมัติในเดือนนั้น ÷ จำนวนสัญญาทั้งหมดที่อนุมัติในเดือนเดียวกัน × 100
 */
function BadDebtRateBadge({ value, totalBadDebt, totalAll }: { value: number | null; totalBadDebt?: number; totalAll?: number }) {
  if (value == null) return <span className="text-gray-300">—</span>;
  const colorClass =
    value >= 10 ? "bg-red-100 text-red-700" :
    value >= 5  ? "bg-orange-100 text-orange-700" :
                  "bg-green-100 text-green-700";
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold cursor-help ${colorClass}`}>
            {value.toFixed(2)}%
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[280px] text-xs">
          <p className="font-semibold mb-1">ที่มา: % หนี้เสีย</p>
          <p className="text-gray-200">
            จำนวนสัญญาหนี้เสียที่อนุมัติในช่วงนี้ ÷ จำนวนสัญญาทั้งหมดที่อนุมัติในช่วงเดียวกัน × 100
          </p>
          {totalBadDebt != null && totalAll != null && (
            <p className="mt-1 text-gray-300">
              = {totalBadDebt.toLocaleString("th-TH")} ÷ {totalAll.toLocaleString("th-TH")} × 100
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ─── ProfitBadge ─────────────────────────────────────────────────────────── */
function ProfitBadge({ value }: { value: number }) {
  if (value > 0)
    return (
      <span className="inline-flex items-center gap-1 text-green-600 font-semibold">
        <TrendingUp className="w-3.5 h-3.5" />
        {fmtMoney(value)}
      </span>
    );
  if (value < 0)
    return (
      <span className="inline-flex items-center gap-1 text-red-500 font-semibold">
        <TrendingDown className="w-3.5 h-3.5" />
        {fmtMoney(value)}
      </span>
    );
  return <span className="text-gray-500">{fmtMoney(value)}</span>;
}

/* ─── SummaryCard ─────────────────────────────────────────────────────────── */
function SummaryCard({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string; color: string;
}) {
  return (
    <div className={`rounded-lg border p-3 flex items-center gap-3 bg-white ${color}`}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 truncate">{label}</p>
        <p className="text-sm font-bold text-gray-800 truncate">{value}</p>
      </div>
    </div>
  );
}

/* ─── MultiSelectFilter ─────────────────────────────────────────────────────── */
function MultiSelectFilter({
  label,
  selected,
  onChange,
  options,
  placeholder = "ทั้งหมด",
  formatOption,
}: {
  label: string;
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
  options: string[];
  placeholder?: string;
  formatOption?: (v: string) => string;
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
        ? (formatOption ? formatOption(Array.from(selected)[0]) : Array.from(selected)[0])
        : `${selected.size} รายการ`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px] justify-between",
            selected.size > 0
              ? "border-indigo-400 bg-indigo-50 text-indigo-800 font-medium"
              : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
          )}
        >
          <span className="truncate text-xs">{labelText}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={`ค้นหา ${label}...`} className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty>ไม่พบตัวเลือก</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                onSelect={() => { onChange(new Set()); setOpen(false); }}
              >
                <Check
                  className={cn(
                    "mr-2 h-3.5 w-3.5",
                    selected.size === 0 ? "opacity-100 text-indigo-600" : "opacity-0",
                  )}
                />
                <span className={selected.size === 0 ? "text-indigo-600 font-medium text-xs" : "text-gray-500 text-xs"}>
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
                  <Check
                    className={cn(
                      "mr-2 h-3.5 w-3.5",
                      selected.has(opt) ? "opacity-100 text-indigo-600" : "opacity-0",
                    )}
                  />
                  <span className="text-xs">{formatOption ? formatOption(opt) : opt}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ─── main component ────────────────────────────────────────────────────────── */
export default function BadDebtSummary() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("bad_debt_summary", "view");
  const canExport = can("bad_debt_summary", "export");
  const { setActions } = useNavActions();

  const [approveMonth, setApproveMonth] = useState("");
  const [saleMonth, setSaleMonth] = useState("");
  const [filterYear, setFilterYear] = useState("");
  const [osFilter, setOsFilter] = useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<ActiveTab>("yearly");
  // sub-tabs
  const [monthlySubTab, setMonthlySubTab] = useState<MonthlySubTab>("bySale");
  const [yearlySubTab, setYearlySubTab] = useState<YearlySubTab>("bySale");

  // sort states for list tab
  const [sortKey, setSortKey] = useState<SortKey>("saleDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // sort states for monthly bySale
  const [monthlySortKey, setMonthlySortKey] = useState<MonthlySortKey>("ym");
  const [monthlySortDir, setMonthlySortDir] = useState<SortDir>("desc");
  // sort states for monthly byApprove
  const [monthlyApproveSortKey, setMonthlyApproveSortKey] = useState<MonthlySortKeyWithRate>("ym");
  const [monthlyApproveSortDir, setMonthlyApproveSortDir] = useState<SortDir>("desc");
  // sort states for yearly bySale
  const [yearlySortKey, setYearlySortKey] = useState<YearlySortKey>("year");
  const [yearlySortDir, setYearlySortDir] = useState<SortDir>("desc");
  // sort states for yearly byApprove
  const [yearlyApproveSortKey, setYearlyApproveSortKey] = useState<YearlySortKeyWithRate>("year");
  const [yearlyApproveSortDir, setYearlyApproveSortDir] = useState<SortDir>("desc");

  const { data, isLoading } = trpc.badDebt.summary.useQuery(
    section ? { section, approveMonth: approveMonth || undefined, saleMonth: saleMonth || undefined } : (undefined as any),
    { enabled: canView && !!section, staleTime: 5 * 60 * 1000 },
  );

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const totalContractsByApproveMonth = data?.totalContractsByApproveMonth ?? {};

  /* ── saleMonth options ── */
  const saleMonthOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.saleDate) set.add(r.saleDate.slice(0, 7)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── approveMonth options (dropdown) ── */
  const approveMonthOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.approveDate) set.add(r.approveDate.slice(0, 7)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── year options (sale) ── */
  const yearOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.saleDate) set.add(r.saleDate.slice(0, 4)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── year options (approve) ── */
  const approveYearOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.approveDate) set.add(r.approveDate.slice(0, 4)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── model canonical map (lowercase key → canonical display) ── */
  const modelCanonicalMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (!r.model) continue;
      const base = parseModelBase(r.model);
      if (!base) continue;
      const key = base.toLowerCase();
      if (!map.has(key)) map.set(key, base);
    }
    return map;
  }, [rows]);

  /* ── model options (ยุบรวม base model แล้ว, กรองตาม osFilter) ── */
  const modelOptions = useMemo(() => {
    const keySet = new Set<string>();
    for (const r of rows) {
      if (!r.model) continue;
      if (osFilter.size > 0) {
        const os = deriveOS(r.model);
        if (!os || !osFilter.has(os)) continue;
      }
      const base = parseModelBase(r.model);
      if (!base) continue;
      keySet.add(base.toLowerCase());
    }
    return Array.from(keySet).sort((a, b) => a.localeCompare(b, "th"));
  }, [rows, osFilter]);

  /* ── reset modelFilter เมื่อ osFilter เปลี่ยน ── */
  React.useEffect(() => {
    setModelFilter((prev) => {
      const filtered = Array.from(prev).filter((m) => modelOptions.includes(m));
      if (filtered.length === prev.size) return prev;
      return new Set(filtered);
    });
  }, [modelOptions]);

  /* ── filtered rows (list tab) ── */
  const filteredRows = useMemo(() => {
    let r = [...rows];
    if (osFilter.size > 0) {
      r = r.filter((row) => {
        const os = deriveOS(row.model ?? null);
        return os && osFilter.has(os);
      });
    }
    if (modelFilter.size > 0) {
      r = r.filter((row) => {
        if (!row.model) return false;
        const base = parseModelBase(row.model);
        return base != null && modelFilter.has(base.toLowerCase());
      });
    }
    r.sort((a, b) => {
      const av: any = a[sortKey as keyof typeof a] ?? "";
      const bv: any = b[sortKey as keyof typeof b] ?? "";
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return r;
  }, [rows, osFilter, modelFilter, sortKey, sortDir]);

  /* ── monthly bySale summary (ไม่มี % หนี้เสีย) ── */
  const monthlyBySaleRows = useMemo(() => {
    const src = filterYear ? rows.filter((r) => (r.saleDate ?? "").startsWith(filterYear)) : rows;
    const map = new Map<string, {
      ym: string; count: number;
      financeAmount: number; commissionNet: number; cost: number;
      installmentPaid: number; deviceSaleAmount: number; totalRevenue: number; profitLoss: number;
    }>();
    src.forEach((r) => {
      const ym = (r.saleDate ?? "").slice(0, 7) || "ไม่ระบุ";
      const cur = map.get(ym) ?? { ym, count: 0, financeAmount: 0, commissionNet: 0, cost: 0, installmentPaid: 0, deviceSaleAmount: 0, totalRevenue: 0, profitLoss: 0 };
      cur.count++;
      cur.financeAmount += r.financeAmount;
      cur.commissionNet += r.commissionNet;
      cur.cost += r.cost;
      cur.installmentPaid += r.installmentPaid;
      cur.deviceSaleAmount += r.deviceSaleAmount;
      cur.totalRevenue += r.totalRevenue;
      cur.profitLoss += r.profitLoss;
      map.set(ym, cur);
    });
    const raw = Array.from(map.values());
    raw.sort((a, b) => {
      const av: any = a[monthlySortKey as keyof typeof a] ?? "";
      const bv: any = b[monthlySortKey as keyof typeof b] ?? "";
      if (typeof av === "number" && typeof bv === "number") return monthlySortDir === "asc" ? av - bv : bv - av;
      return monthlySortDir === "asc" ? String(av).localeCompare(String(bv), "th") : String(bv).localeCompare(String(av), "th");
    });
    return raw;
  }, [rows, filterYear, monthlySortKey, monthlySortDir]);

  /* ── monthly byApprove summary (มี % หนี้เสีย) ── */
  const monthlyByApproveRows = useMemo(() => {
    const src = filterYear ? rows.filter((r) => (r.approveDate ?? "").startsWith(filterYear)) : rows;
    const map = new Map<string, {
      ym: string; count: number;
      financeAmount: number; commissionNet: number; cost: number;
      installmentPaid: number; deviceSaleAmount: number; totalRevenue: number; profitLoss: number;
    }>();
    src.forEach((r) => {
      const ym = (r.approveDate ?? "").slice(0, 7) || "ไม่ระบุ";
      const cur = map.get(ym) ?? { ym, count: 0, financeAmount: 0, commissionNet: 0, cost: 0, installmentPaid: 0, deviceSaleAmount: 0, totalRevenue: 0, profitLoss: 0 };
      cur.count++;
      cur.financeAmount += r.financeAmount;
      cur.commissionNet += r.commissionNet;
      cur.cost += r.cost;
      cur.installmentPaid += r.installmentPaid;
      cur.deviceSaleAmount += r.deviceSaleAmount;
      cur.totalRevenue += r.totalRevenue;
      cur.profitLoss += r.profitLoss;
      map.set(ym, cur);
    });
    const raw = Array.from(map.values()).map((r) => {
      const totalBadDebt = r.count;
      const totalAll = totalContractsByApproveMonth[r.ym] ?? 0;
      const badDebtRate = totalAll > 0 ? (totalBadDebt / totalAll) * 100 : null;
      return { ...r, badDebtRate, totalBadDebt, totalAll };
    });
    raw.sort((a, b) => {
      const av: any = a[monthlyApproveSortKey as keyof typeof a] ?? "";
      const bv: any = b[monthlyApproveSortKey as keyof typeof b] ?? "";
      if (typeof av === "number" && typeof bv === "number") return monthlyApproveSortDir === "asc" ? av - bv : bv - av;
      return monthlyApproveSortDir === "asc" ? String(av).localeCompare(String(bv), "th") : String(bv).localeCompare(String(av), "th");
    });
    return raw;
  }, [rows, filterYear, monthlyApproveSortKey, monthlyApproveSortDir, totalContractsByApproveMonth]);

  /* ── yearly bySale summary (ไม่มี % หนี้เสีย) ── */
  const yearlyBySaleRows = useMemo(() => {
    const src = filterYear ? rows.filter((r) => (r.saleDate ?? "").startsWith(filterYear)) : rows;
    const map = new Map<string, {
      year: string; count: number;
      financeAmount: number; commissionNet: number; cost: number;
      installmentPaid: number; deviceSaleAmount: number; totalRevenue: number; profitLoss: number;
    }>();
    src.forEach((r) => {
      const year = (r.saleDate ?? "").slice(0, 4) || "ไม่ระบุ";
      const cur = map.get(year) ?? { year, count: 0, financeAmount: 0, commissionNet: 0, cost: 0, installmentPaid: 0, deviceSaleAmount: 0, totalRevenue: 0, profitLoss: 0 };
      cur.count++;
      cur.financeAmount += r.financeAmount;
      cur.commissionNet += r.commissionNet;
      cur.cost += r.cost;
      cur.installmentPaid += r.installmentPaid;
      cur.deviceSaleAmount += r.deviceSaleAmount;
      cur.totalRevenue += r.totalRevenue;
      cur.profitLoss += r.profitLoss;
      map.set(year, cur);
    });
    const raw = Array.from(map.values());
    raw.sort((a, b) => {
      const av: any = a[yearlySortKey as keyof typeof a] ?? "";
      const bv: any = b[yearlySortKey as keyof typeof b] ?? "";
      if (typeof av === "number" && typeof bv === "number") return yearlySortDir === "asc" ? av - bv : bv - av;
      return yearlySortDir === "asc" ? String(av).localeCompare(String(bv), "th") : String(bv).localeCompare(String(av), "th");
    });
    return raw;
  }, [rows, filterYear, yearlySortKey, yearlySortDir]);

  /* ── yearly byApprove summary (มี % หนี้เสีย) ── */
  const yearlyByApproveRows = useMemo(() => {
    const src = filterYear ? rows.filter((r) => (r.approveDate ?? "").startsWith(filterYear)) : rows;
    const map = new Map<string, {
      year: string; count: number;
      financeAmount: number; commissionNet: number; cost: number;
      installmentPaid: number; deviceSaleAmount: number; totalRevenue: number; profitLoss: number;
      badDebtCountByApproveMonth: Map<string, number>;
    }>();
    src.forEach((r) => {
      const year = (r.approveDate ?? "").slice(0, 4) || "ไม่ระบุ";
      const cur = map.get(year) ?? { year, count: 0, financeAmount: 0, commissionNet: 0, cost: 0, installmentPaid: 0, deviceSaleAmount: 0, totalRevenue: 0, profitLoss: 0, badDebtCountByApproveMonth: new Map() };
      cur.count++;
      cur.financeAmount += r.financeAmount;
      cur.commissionNet += r.commissionNet;
      cur.cost += r.cost;
      cur.installmentPaid += r.installmentPaid;
      cur.deviceSaleAmount += r.deviceSaleAmount;
      cur.totalRevenue += r.totalRevenue;
      cur.profitLoss += r.profitLoss;
      const aym = (r.approveDate ?? "").slice(0, 7);
      if (aym) cur.badDebtCountByApproveMonth.set(aym, (cur.badDebtCountByApproveMonth.get(aym) ?? 0) + 1);
      map.set(year, cur);
    });
    const raw = Array.from(map.values()).map((r) => {
      let totalBadDebt = 0; let totalAll = 0;
      r.badDebtCountByApproveMonth.forEach((cnt, aym) => {
        totalBadDebt += cnt;
        totalAll += totalContractsByApproveMonth[aym] ?? 0;
      });
      const badDebtRate = totalAll > 0 ? (totalBadDebt / totalAll) * 100 : null;
      return { year: r.year, count: r.count, financeAmount: r.financeAmount, commissionNet: r.commissionNet, cost: r.cost, installmentPaid: r.installmentPaid, deviceSaleAmount: r.deviceSaleAmount, totalRevenue: r.totalRevenue, profitLoss: r.profitLoss, badDebtRate, totalBadDebt, totalAll };
    });
    raw.sort((a, b) => {
      const av: any = a[yearlyApproveSortKey as keyof typeof a] ?? "";
      const bv: any = b[yearlyApproveSortKey as keyof typeof b] ?? "";
      if (typeof av === "number" && typeof bv === "number") return yearlyApproveSortDir === "asc" ? av - bv : bv - av;
      return yearlyApproveSortDir === "asc" ? String(av).localeCompare(String(bv), "th") : String(bv).localeCompare(String(av), "th");
    });
    return raw;
  }, [rows, filterYear, yearlyApproveSortKey, yearlyApproveSortDir, totalContractsByApproveMonth]);

  /* ── sort toggles ── */
  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => { if (prev === key) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return key; } setSortDir("desc"); return key; });
  }, []);
  const toggleMonthlySort = useCallback((key: MonthlySortKey) => {
    setMonthlySortKey((prev) => { if (prev === key) { setMonthlySortDir((d) => (d === "asc" ? "desc" : "asc")); return key; } setMonthlySortDir("desc"); return key; });
  }, []);
  const toggleMonthlyApproveSort = useCallback((key: MonthlySortKeyWithRate) => {
    setMonthlyApproveSortKey((prev) => { if (prev === key) { setMonthlyApproveSortDir((d) => (d === "asc" ? "desc" : "asc")); return key; } setMonthlyApproveSortDir("desc"); return key; });
  }, []);
  const toggleYearlySort = useCallback((key: YearlySortKey) => {
    setYearlySortKey((prev) => { if (prev === key) { setYearlySortDir((d) => (d === "asc" ? "desc" : "asc")); return key; } setYearlySortDir("desc"); return key; });
  }, []);
  const toggleYearlyApproveSort = useCallback((key: YearlySortKeyWithRate) => {
    setYearlyApproveSortKey((prev) => { if (prev === key) { setYearlyApproveSortDir((d) => (d === "asc" ? "desc" : "asc")); return key; } setYearlyApproveSortDir("desc"); return key; });
  }, []);

  /* ── export ── */
  const handleExport = useCallback(async () => {
    if (!section) return;
    const params = new URLSearchParams({ section });
    if (approveMonth) params.set("approveMonth", approveMonth);
    if (saleMonth) params.set("saleMonth", saleMonth);
    const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
    try {
      const resp = await fetch(`/api/export/bad-debt?${params.toString()}`, { credentials: "include" });
      if (!resp.ok) {
        const { message } = await resp.json().catch(() => ({ message: "Export failed" }));
        toast.error(message, { id: toastId });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bad_debt_summary_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลดสำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  }, [section, approveMonth, saleMonth]);

  /* ── nav actions: SyncStatusBar ── */
  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  /* ── SortIcon helpers ── */
  const SortIcon = ({ col }: { col: SortKey }) => {
    if (col !== sortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };
  const MonthlySortIcon = ({ col }: { col: MonthlySortKey }) => {
    if (col !== monthlySortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return monthlySortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };
  const MonthlyApproveSortIcon = ({ col }: { col: MonthlySortKeyWithRate }) => {
    if (col !== monthlyApproveSortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return monthlyApproveSortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };
  const YearlySortIcon = ({ col }: { col: YearlySortKey }) => {
    if (col !== yearlySortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return yearlySortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };
  const YearlyApproveSortIcon = ({ col }: { col: YearlySortKeyWithRate }) => {
    if (col !== yearlyApproveSortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return yearlyApproveSortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  /* ── Th helpers ── */
  const Th = ({ label, col, className = "" }: { label: string; col?: SortKey; className?: string }) => (
    <th className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`} onClick={col ? () => toggleSort(col) : undefined}>
      <span className="inline-flex items-center gap-1 justify-center">{label}{col && <SortIcon col={col} />}</span>
    </th>
  );
  const ThM = ({ label, col, className = "", rowSpan }: { label: string; col?: MonthlySortKey; className?: string; rowSpan?: number }) => (
    <th rowSpan={rowSpan} className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`} onClick={col ? () => toggleMonthlySort(col) : undefined}>
      <span className="inline-flex items-center gap-1 justify-center">{label}{col && <MonthlySortIcon col={col} />}</span>
    </th>
  );
  const ThMA = ({ label, col, className = "", rowSpan }: { label: string; col?: MonthlySortKeyWithRate; className?: string; rowSpan?: number }) => (
    <th rowSpan={rowSpan} className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`} onClick={col ? () => toggleMonthlyApproveSort(col) : undefined}>
      <span className="inline-flex items-center gap-1 justify-center">{label}{col && <MonthlyApproveSortIcon col={col} />}</span>
    </th>
  );
  const ThY = ({ label, col, className = "", rowSpan }: { label: string; col?: YearlySortKey; className?: string; rowSpan?: number }) => (
    <th rowSpan={rowSpan} className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`} onClick={col ? () => toggleYearlySort(col) : undefined}>
      <span className="inline-flex items-center gap-1 justify-center">{label}{col && <YearlySortIcon col={col} />}</span>
    </th>
  );
  const ThYA = ({ label, col, className = "", rowSpan }: { label: string; col?: YearlySortKeyWithRate; className?: string; rowSpan?: number }) => (
    <th rowSpan={rowSpan} className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`} onClick={col ? () => toggleYearlyApproveSort(col) : undefined}>
      <span className="inline-flex items-center gap-1 justify-center">{label}{col && <YearlyApproveSortIcon col={col} />}</span>
    </th>
  );

  /* ── tabs ── */
  const tabs: { key: ActiveTab; label: string; icon: React.ReactNode }[] = [
    { key: "yearly", label: "สรุปรายปี", icon: <CalendarRange className="w-4 h-4" /> },
    { key: "monthly", label: "สรุปรายเดือน", icon: <CalendarDays className="w-4 h-4" /> },
    { key: "list", label: "รายการขายเครื่อง", icon: <List className="w-4 h-4" /> },
  ];

  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-32 text-gray-400">
          <AlertTriangle className="w-5 h-5 mr-2" />
          คุณไม่มีสิทธิ์ดูหน้านี้
        </div>
      </AppShell>
    );
  }

  /* ── ตัวกรองปี (ปรับตาม sub-tab) ── */
  const activeYearOptions = (activeTab === "monthly" && monthlySubTab === "byApprove") || (activeTab === "yearly" && yearlySubTab === "byApprove")
    ? approveYearOptions : yearOptions;
  const activeYearLabel = (activeTab === "monthly" && monthlySubTab === "byApprove") || (activeTab === "yearly" && yearlySubTab === "byApprove")
    ? "ปีที่อนุมัติ" : "ปีที่ขาย";

  return (
    <AppShell fullHeight>
      <div className="flex flex-col h-full">
      <div className="px-4 py-4 space-y-4">

        {/* ── Main Tabs + Export Excel ── */}
        <div className="flex items-center border-b border-gray-200">
          <div className="flex gap-0 flex-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === t.key ? "border-red-600 text-red-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          {/* Export Excel ชิดขวาใน row เดียวกับ main tabs */}
          {canExport && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors mb-1 shrink-0"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Export Excel</span>
            </button>
          )}
        </div>

        {/* ── Summary Cards ── */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard icon={<AlertTriangle className="w-5 h-5 text-red-500" />} label="จำนวนสัญญา" value={`${summary.contractCount.toLocaleString("th-TH")} รายการ`} color="border-red-100" />
            <SummaryCard icon={<Wallet className="w-5 h-5 text-purple-500" />} label="ต้นทุน" value={fmtMoney(summary.totalCost)} color="border-purple-100" />
            <SummaryCard icon={<Banknote className="w-5 h-5 text-blue-500" />} label="ยอดผ่อน" value={fmtMoney(summary.totalInstallmentPaid)} color="border-blue-100" />
            <SummaryCard icon={<Banknote className="w-5 h-5 text-orange-500" />} label="ยอดขายเครื่อง" value={fmtMoney(summary.totalDeviceSaleAmount)} color="border-orange-100" />
            <SummaryCard icon={<Wallet className="w-5 h-5 text-teal-500" />} label="รายรับรวม" value={fmtMoney(summary.totalInstallmentPaid + summary.totalDeviceSaleAmount)} color="border-teal-100" />
            <SummaryCard
              icon={summary.totalProfitLoss >= 0 ? <TrendingUp className="w-5 h-5 text-green-600" /> : <TrendingDown className="w-5 h-5 text-red-500" />}
              label="กำไร/ขาดทุน"
              value={fmtMoney(summary.totalProfitLoss)}
              color={summary.totalProfitLoss >= 0 ? "border-green-100" : "border-red-100"}
            />
          </div>
        )}

        {/* ── Filters ── */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">เดือนที่อนุมัติ</label>
            <select value={approveMonth} onChange={(e) => setApproveMonth(e.target.value)} className="border rounded px-2 py-1.5 text-sm h-9 bg-white">
              <option value="">ทุกเดือน</option>
              {approveMonthOptions.map((ym) => (
                <option key={ym} value={ym}>{fmtMonthLabel(ym)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">เดือนที่ขายเครื่อง</label>
            <select value={saleMonth} onChange={(e) => setSaleMonth(e.target.value)} className="border rounded px-2 py-1.5 text-sm h-9 bg-white">
              <option value="">ทุกเดือน</option>
              {saleMonthOptions.map((ym) => (
                <option key={ym} value={ym}>{fmtMonthLabel(ym)}</option>
              ))}
            </select>
          </div>
          {(activeTab === "monthly" || activeTab === "yearly") && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">{activeYearLabel}</label>
              <select value={filterYear} onChange={(e) => setFilterYear(e.target.value)} className="border rounded px-2 py-1.5 text-sm h-9 bg-white">
                <option value="">ทุกปี</option>
                {activeYearOptions.map((y) => (
                  <option key={y} value={y}>{parseInt(y, 10) + 543}</option>
                ))}
              </select>
            </div>
          )}
          {/* ประเภทเครื่อง iOS/Android */}
          <MultiSelectFilter
            label="ประเภทเครื่อง"
            selected={osFilter}
            onChange={setOsFilter}
            options={["iOS", "Android"]}
            placeholder="ทุกประเภท"
          />
          {/* รุ่นเครื่อง */}
          <MultiSelectFilter
            label="รุ่นเครื่อง"
            selected={modelFilter}
            onChange={setModelFilter}
            options={modelOptions}
            placeholder="ทุกรุ่น"
            formatOption={(k) => modelCanonicalMap.get(k) ?? k}
          />
          <button
            onClick={() => { setApproveMonth(""); setSaleMonth(""); setFilterYear(""); setOsFilter(new Set()); setModelFilter(new Set()); }}
            className="flex items-center gap-1 h-9 px-3 text-sm border rounded hover:bg-gray-50 text-gray-600"
          >
            <X className="w-3.5 h-3.5" />
            ล้างตัวกรอง
          </button>
          {/* Sub-tab แสดงเมื่ออยู่ใน tab yearly หรือ monthly */}
          {activeTab === "monthly" && (
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setMonthlySubTab("bySale")}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${monthlySubTab === "bySale" ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >
                ตามเดือนที่ขาย
              </button>
              <button
                onClick={() => setMonthlySubTab("byApprove")}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${monthlySubTab === "byApprove" ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >
                ตามเดือนที่อนุมัติ
                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">% หนี้เสีย</span>
              </button>
            </div>
          )}
          {activeTab === "yearly" && (
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setYearlySubTab("bySale")}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${yearlySubTab === "bySale" ? "bg-purple-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >
                ตามปีที่ขาย
              </button>
              <button
                onClick={() => setYearlySubTab("byApprove")}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${yearlySubTab === "byApprove" ? "bg-purple-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >
                ตามปีที่อนุมัติ
                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">% หนี้เสีย</span>
              </button>
            </div>
          )}
        </div>

        {/* ── Loading ── */}
        {isLoading && (
          <div className="flex justify-center py-16"><Spinner /></div>
        )}

      </div>

        {/* ╔════════════════ TAB: รายการขายเครื่อง ════════════════ */}
        {!isLoading && activeTab === "list" && (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
          <div className="rounded-lg border border-gray-200 shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-red-700 text-white sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-2 text-center text-xs font-semibold w-10">#</th>
                  <Th label="วันที่อนุมัติ" col="approveDate" />
                  <Th label="เลขที่สัญญา" col="contractNo" />
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">ชื่อ-นามสกุล</th>
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">เบอร์โทร</th>
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">รุ่น</th>
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">ราคา</th>
                  <Th label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                  <Th label="ค่าคอมมิชชั่น" col="commissionNet" />
                  <Th label="ต้นทุน" col="cost" />
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">งวดที่ชำระ</th>
                  <Th label="ยอดผ่อน" col="installmentPaid" />
                  <Th label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                  <Th label="รวมรายรับ" col="totalRevenue" />
                  <Th label="วันที่ขาย" col="saleDate" />
                  <Th label="กำไร/ขาดทุน" col="profitLoss" />
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr><td colSpan={16} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                ) : (
                  filteredRows.map((r, idx) => (
                    <tr key={r.contractExternalId} className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                      <td className="px-2 py-2 text-center text-gray-400 text-xs">{idx + 1}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">{fmtDate(r.approveDate)}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap font-mono text-xs">{r.contractNo ?? "-"}</td>
                      <td className="px-2 py-2 whitespace-nowrap text-xs">{r.customerName ?? "-"}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">{r.phone ?? "-"}</td>
                      <td className="px-2 py-2 whitespace-nowrap text-xs">{r.model ?? "-"}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.salePrice)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.financeAmount)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.commissionNet)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs font-medium text-orange-700">{fmtMoney(r.cost)}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">
                        {r.installmentCount != null ? `${r.paidInstallments}/${r.installmentCount}` : `${r.paidInstallments}`}
                      </td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.installmentPaid)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs font-medium">{fmtMoney(r.totalRevenue)}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">{fmtDate(r.saleDate)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs"><ProfitBadge value={r.profitLoss} /></td>
                    </tr>
                  ))
                )}
              </tbody>
              {filteredRows.length > 0 && (
                <tfoot className="bg-red-50 border-t-2 border-red-200 font-semibold text-xs sticky bottom-0 z-10">
                  <tr>
                    <td colSpan={7} className="px-2 py-2 text-right text-gray-600">รวม {filteredRows.length} รายการ</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                    <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(filteredRows.reduce((s, r) => s + r.cost, 0))}</td>
                    <td className="px-2 py-2"></td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                    <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(filteredRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                    <td className="px-2 py-2"></td>
                    <td className="px-2 py-2 text-right"><ProfitBadge value={filteredRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          </div>
        )}

        {/* ╔════════════════ TAB: สรุปรายเดือน ════════════════ */}
        {!isLoading && activeTab === "monthly" && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* ── Sub-tab: ตามเดือนที่ขาย (ไม่มี % หนี้เสีย) ── */}
            {monthlySubTab === "bySale" && (
              <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
              <div className="rounded-lg border border-gray-200 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-blue-700 text-white sticky top-0 z-10">
                    <tr>
                      <ThM label="เดือน-ปีที่ขาย" col="ym" rowSpan={2} className="px-3 text-left border-r border-blue-500" />
                      <ThM label="จำนวน" col="count" rowSpan={2} className="border-r border-blue-500" />
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-blue-500 border-r border-blue-500">ต้นทุน</th>
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-blue-500 border-r border-blue-500">รายรับ</th>
                      <ThM label="กำไร/ขาดทุน" col="profitLoss" rowSpan={2} />
                    </tr>
                    <tr>
                      <ThM label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                      <ThM label="ค่าคอมมิชชั่น" col="commissionNet" />
                      <ThM label="ต้นทุนรวม" col="cost" className="border-r border-blue-500" />
                      <ThM label="ยอดเก็บค่างวด" col="installmentPaid" />
                      <ThM label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                      <ThM label="รวมรายรับ" col="totalRevenue" className="border-r border-blue-500" />
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyBySaleRows.length === 0 ? (
                      <tr><td colSpan={9} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                    ) : (
                      monthlyBySaleRows.map((r, idx) => (
                        <tr key={r.ym} className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                          <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">{r.ym === "ไม่ระบุ" ? "ไม่ระบุ" : fmtMonthLabel(r.ym)}</td>
                          <td className="px-2 py-2 text-center text-sm">{r.count.toLocaleString("th-TH")}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.financeAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.commissionNet)}</td>
                          <td className="px-2 py-2 text-right text-sm text-orange-700 font-medium">{fmtMoney(r.cost)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.installmentPaid)}</td>
                          <td className="px-2 py-2 text-right text-sm text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm font-medium">{fmtMoney(r.totalRevenue)}</td>
                          <td className="px-2 py-2 text-right text-sm"><ProfitBadge value={r.profitLoss} /></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {monthlyBySaleRows.length > 0 && (                    <tfoot className="bg-blue-50 border-t-2 border-blue-200 font-semibold text-xs sticky bottom-0 z-10">
                  <tr>
                    <td className="px-3 py-2 text-left text-gray-600">รวม{monthlyBySaleRows.length} เดือน</td>
                        <td className="px-2 py-2 text-center">{monthlyBySaleRows.reduce((s, r) => s + r.count, 0).toLocaleString("th-TH")}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyBySaleRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyBySaleRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                        <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(monthlyBySaleRows.reduce((s, r) => s + r.cost, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyBySaleRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                        <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(monthlyBySaleRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyBySaleRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                        <td className="px-2 py-2 text-right"><ProfitBadge value={monthlyBySaleRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              </div>
            )}

            {/* ── Sub-tab: ตามเดือนที่อนุมัติ (มี % หนี้เสีย) ── */}
            {monthlySubTab === "byApprove" && (
              <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
              <div className="rounded-lg border border-gray-200 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-blue-700 text-white sticky top-0 z-10">
                    <tr>
                      <ThMA label="เดือน-ปีที่อนุมัติ" col="ym" rowSpan={2} className="px-3 text-left border-r border-blue-500" />
                      <th className="px-2 py-1 text-center text-xs font-semibold border-r border-blue-500 whitespace-nowrap" rowSpan={2}>สัญญา</th>
                      <ThMA label="หนี้เสีย" col="count" rowSpan={2} className="border-r border-blue-500" />
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-blue-500 border-r border-blue-500">ต้นทุน</th>
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-blue-500 border-r border-blue-500">รายรับ</th>
                      <th className="px-2 py-1 text-center text-xs font-semibold border-r border-blue-500 whitespace-nowrap" rowSpan={2}>% หนี้เสีย</th>
                      <ThMA label="กำไร/ขาดทุน" col="profitLoss" rowSpan={2} />
                    </tr>
                    <tr>
                      <ThMA label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                      <ThMA label="ค่าคอมมิชชั่น" col="commissionNet" />
                      <ThMA label="ต้นทุนรวม" col="cost" className="border-r border-blue-500" />
                      <ThMA label="ยอดเก็บค่างวด" col="installmentPaid" />
                      <ThMA label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                      <ThMA label="รวมรายรับ" col="totalRevenue" className="border-r border-blue-500" />
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyByApproveRows.length === 0 ? (
                      <tr><td colSpan={10} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                    ) : (
                      monthlyByApproveRows.map((r, idx) => (
                        <tr key={r.ym} className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                          <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">{r.ym === "ไม่ระบุ" ? "ไม่ระบุ" : fmtMonthLabel(r.ym)}</td>
                          <td className="px-2 py-2 text-center text-sm text-gray-500">{r.totalAll > 0 ? r.totalAll.toLocaleString("th-TH") : "-"}</td>
                          <td className="px-2 py-2 text-center text-sm">{r.count.toLocaleString("th-TH")}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.financeAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.commissionNet)}</td>
                          <td className="px-2 py-2 text-right text-sm text-orange-700 font-medium">{fmtMoney(r.cost)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.installmentPaid)}</td>
                          <td className="px-2 py-2 text-right text-sm text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm font-medium">{fmtMoney(r.totalRevenue)}</td>
                          <td className="px-2 py-2 text-right text-sm">
                            <BadDebtRateBadge value={r.badDebtRate} totalBadDebt={r.totalBadDebt} totalAll={r.totalAll} />
                          </td>
                          <td className="px-2 py-2 text-right text-sm"><ProfitBadge value={r.profitLoss} /></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                      {monthlyByApproveRows.length > 0 && (                    <tfoot className="bg-blue-50 border-t-2 border-blue-200 font-semibold text-xs sticky bottom-0 z-10">
                  <tr>
                    <td className="px-3 py-2 text-left text-gray-500">รวม{monthlyByApproveRows.length} เดือน</td>
                        <td className="px-2 py-2 text-center text-gray-500">{monthlyByApproveRows.reduce((s, r) => s + r.totalAll, 0).toLocaleString("th-TH")}</td>
                        <td className="px-2 py-2 text-center">{monthlyByApproveRows.reduce((s, r) => s + r.count, 0).toLocaleString("th-TH")}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyByApproveRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyByApproveRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                        <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(monthlyByApproveRows.reduce((s, r) => s + r.cost, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyByApproveRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                        <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(monthlyByApproveRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(monthlyByApproveRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                        <td className="px-2 py-2"></td>
                        <td className="px-2 py-2 text-right"><ProfitBadge value={monthlyByApproveRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              </div>
            )}
          </div>
        )}

        {/* ╔════════════════ TAB: สรุปรายปี ════════════════ */}
        {!isLoading && activeTab === "yearly" && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* ── Sub-tab: ตามปีที่ขาย (ไม่มี % หนี้เสีย) ── */}
            {yearlySubTab === "bySale" && (
              <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
              <div className="rounded-lg border border-gray-200 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-purple-700 text-white sticky top-0 z-10">
                    <tr>
                      <ThY label="ปีที่ขาย" col="year" rowSpan={2} className="px-3 text-left border-r border-purple-500" />
                      <ThY label="จำนวน" col="count" rowSpan={2} className="border-r border-purple-500" />
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-purple-500 border-r border-purple-500">ต้นทุน</th>
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-purple-500 border-r border-purple-500">รายรับ</th>
                      <ThY label="กำไร/ขาดทุน" col="profitLoss" rowSpan={2} />
                    </tr>
                    <tr>
                      <ThY label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                      <ThY label="ค่าคอมมิชชั่น" col="commissionNet" />
                      <ThY label="ต้นทุนรวม" col="cost" className="border-r border-purple-500" />
                      <ThY label="ยอดเก็บค่างวด" col="installmentPaid" />
                      <ThY label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                      <ThY label="รวมรายรับ" col="totalRevenue" className="border-r border-purple-500" />
                    </tr>
                  </thead>
                  <tbody>
                    {yearlyBySaleRows.length === 0 ? (
                      <tr><td colSpan={9} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                    ) : (
                      yearlyBySaleRows.map((r, idx) => (
                        <tr key={r.year} className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                          <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">{r.year === "ไม่ระบุ" ? "ไม่ระบุ" : `พ.ศ. ${parseInt(r.year, 10) + 543}`}</td>
                          <td className="px-2 py-2 text-center text-sm">{r.count.toLocaleString("th-TH")}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.financeAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.commissionNet)}</td>
                          <td className="px-2 py-2 text-right text-sm text-orange-700 font-medium">{fmtMoney(r.cost)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.installmentPaid)}</td>
                          <td className="px-2 py-2 text-right text-sm text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm font-medium">{fmtMoney(r.totalRevenue)}</td>
                          <td className="px-2 py-2 text-right text-sm"><ProfitBadge value={r.profitLoss} /></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {yearlyBySaleRows.length > 0 && (                    <tfoot className="bg-purple-50 border-t-2 border-purple-200 font-semibold text-xs sticky bottom-0 z-10">
                  <tr>
                    <td className="px-3 py-2 text-left text-gray-500">รวม{yearlyBySaleRows.length} ปี</td>
                        <td className="px-2 py-2 text-center">{yearlyBySaleRows.reduce((s, r) => s + r.count, 0).toLocaleString("th-TH")}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyBySaleRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyBySaleRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                        <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(yearlyBySaleRows.reduce((s, r) => s + r.cost, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyBySaleRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                        <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(yearlyBySaleRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyBySaleRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                        <td className="px-2 py-2 text-right"><ProfitBadge value={yearlyBySaleRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              </div>
            )}

            {/* ── Sub-tab: ตามปีที่อนุมัติ (มี % หนี้เสีย) ── */}
            {yearlySubTab === "byApprove" && (
              <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
              <div className="rounded-lg border border-gray-200 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-purple-700 text-white sticky top-0 z-10">
                    <tr>
                      <ThYA label="ปีที่อนุมัติ" col="year" rowSpan={2} className="px-3 text-left border-r border-purple-500" />
                      <th className="px-2 py-1 text-center text-xs font-semibold border-r border-purple-500 whitespace-nowrap" rowSpan={2}>สัญญา</th>
                      <ThYA label="หนี้เสีย" col="count" rowSpan={2} className="border-r border-purple-500" />
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-purple-500 border-r border-purple-500">ต้นทุน</th>
                      <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-purple-500 border-r border-purple-500">รายรับ</th>
                      <th className="px-2 py-1 text-center text-xs font-semibold border-r border-purple-500 whitespace-nowrap" rowSpan={2}>% หนี้เสีย</th>
                      <ThYA label="กำไร/ขาดทุน" col="profitLoss" rowSpan={2} />
                    </tr>
                    <tr>
                      <ThYA label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                      <ThYA label="ค่าคอมมิชชั่น" col="commissionNet" />
                      <ThYA label="ต้นทุนรวม" col="cost" className="border-r border-purple-500" />
                      <ThYA label="ยอดเก็บค่างวด" col="installmentPaid" />
                      <ThYA label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                      <ThYA label="รวมรายรับ" col="totalRevenue" className="border-r border-purple-500" />
                    </tr>
                  </thead>
                  <tbody>
                    {yearlyByApproveRows.length === 0 ? (
                      <tr><td colSpan={10} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                    ) : (
                      yearlyByApproveRows.map((r, idx) => (
                        <tr key={r.year} className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                          <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">{r.year === "ไม่ระบุ" ? "ไม่ระบุ" : `พ.ศ. ${parseInt(r.year, 10) + 543}`}</td>
                          <td className="px-2 py-2 text-center text-sm text-gray-500">{r.totalAll > 0 ? r.totalAll.toLocaleString("th-TH") : "-"}</td>
                          <td className="px-2 py-2 text-center text-sm">{r.count.toLocaleString("th-TH")}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.financeAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.commissionNet)}</td>
                          <td className="px-2 py-2 text-right text-sm text-orange-700 font-medium">{fmtMoney(r.cost)}</td>
                          <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.installmentPaid)}</td>
                          <td className="px-2 py-2 text-right text-sm text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                          <td className="px-2 py-2 text-right text-sm font-medium">{fmtMoney(r.totalRevenue)}</td>
                          <td className="px-2 py-2 text-right text-sm">
                            <BadDebtRateBadge value={r.badDebtRate} totalBadDebt={r.totalBadDebt} totalAll={r.totalAll} />
                          </td>
                          <td className="px-2 py-2 text-right text-sm"><ProfitBadge value={r.profitLoss} /></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {yearlyByApproveRows.length > 0 && (
                    <tfoot className="bg-purple-50 border-t-2 border-purple-200 font-semibold text-xs sticky bottom-0 z-10">
                  <tr>
                     <td className="px-3 py-2 text-left text-gray-600">รวม{yearlyByApproveRows.length} ปี</td>
                        <td className="px-2 py-2 text-center text-gray-500">{yearlyByApproveRows.reduce((s, r) => s + r.totalAll, 0).toLocaleString("th-TH")}</td>
                        <td className="px-2 py-2 text-center">{yearlyByApproveRows.reduce((s, r) => s + r.count, 0).toLocaleString("th-TH")}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyByApproveRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyByApproveRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                        <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(yearlyByApproveRows.reduce((s, r) => s + r.cost, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyByApproveRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                        <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(yearlyByApproveRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(yearlyByApproveRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                        <td className="px-2 py-2"></td>
                        <td className="px-2 py-2 text-right"><ProfitBadge value={yearlyByApproveRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              </div>
            )}
          </div>
        )}

      </div>
    </AppShell>
  );
}

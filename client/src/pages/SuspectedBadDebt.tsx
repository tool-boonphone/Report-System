/**
 * SuspectedBadDebt — Phase 130
 * หน้าหนี้สงสัยจะเสีย: Virtual Scroll, filter UI ใหม่, งวดรูปแบบ 0/12
 */
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Download,
  Lock,
  MapPin,
  Search,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  X,
} from "lucide-react";
import { LocationDialog, useLocationDialog } from "@/components/LocationDialog";
import { AppShell } from "@/components/AppShell";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const fmtMoney = (v: number | null | undefined) =>
  v == null
    ? "-"
    : v.toLocaleString("th-TH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const fmtDate = (s: string | null | undefined) => {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

/** YYYY-MM → "ม.ค. 2568" */
const fmtMonthLabel = (ym: string) => {
  const [y, m] = ym.split("-");
  const monthNames = [
    "ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
    "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค.",
  ];
  const mIdx = parseInt(m, 10) - 1;
  const buddhistYear = parseInt(y, 10) + 543;
  return `${monthNames[mIdx] ?? m} ${buddhistYear}`;
};

/** Classify device จาก model field (iPhone / iPad / Android) */
const deriveOS = (model: string | null): "iPhone" | "iPad" | "Android" | null => {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith("iphone")) return "iPhone";
  if (m.startsWith("ipad"))   return "iPad";
  return "Android";
};

/** Parse model name: extract base model + capacity */
const parseModelParts = (model: string | null) => {
  if (!model) return { base: null, capacity: null };
  const capMatch = model.match(/(\d+)\s*[Gg][Bb]/);
  const capacity = capMatch ? `${capMatch[1]} GB` : null;
  const base = capacity
    ? model.replace(/\s*\d+\s*[Gg][Bb].*$/, "").trim()
    : model.trim();
  return { base, capacity };
};

/** Format model as "base / capacity" */
const fmtModelDisplay = (model: string | null) => {
  if (!model) return "-";
  const { base, capacity } = parseModelParts(model);
  if (base && capacity) return `${base} / ${capacity}`;
  return model;
};

type SortKey =
  | "seq"
  | "approveDate"
  | "contractNo"
  | "customerName"
  | "phone"
  | "model"
  | "sellPrice"
  | "financeAmount"
  | "commissionNet"
  | "incentive"
  | "cost"
  | "paidInstallments"
  | "totalPaid"
  | "debtValue"
  | "daysOverdue";
type SortDir = "asc" | "desc";

type Row = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  serialNo: string | null;
  lastOnlineDays: number | null;
  lastOnlineAt: string | null;   // "YYYY-MM-DD HH:mm:ss" เวลาออนไลน์ล่าสุด (ใช้แสดงใน tooltip)
  deviceLock: boolean | null;
  lossStatus: number | null;      // 0=ปกติ, 1=Lost Mode (ล็อกเครื่อง)
  mdmDeviceId: number | null;    // MDM internal ID สำหรับดึง GPS location
  model: string | null;
  device: string | null;
  sellPrice: number | null;
  financeAmount: number | null;
  multiplier: number | null;
  commissionNet: number | null;
  incentive: number;
  cost: number;
  installmentCount: number | null;
  paidInstallments: number;
  totalPaid: number;
  debtValue: number;
  debtStatus: string;
  daysOverdue: number;
};

/* ─── SummaryCard ─────────────────────────────────────────────────────────── */
function SummaryCard({
  icon,
  label,
  value,
  colorClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  colorClass: string;
}) {
  return (
    <div className={`rounded-lg border p-3 flex items-center gap-3 bg-white ${colorClass}`}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 truncate">{label}</p>
        <p className="text-sm font-bold text-gray-800 truncate">{value}</p>
      </div>
    </div>
  );
}

/* ─── SortIcon ─────────────────────────────────────────────────────────────── */
function SortIcon({
  col,
  sortKey,
  sortDir,
}: {
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
}) {
  if (sortKey !== col)
    return <ChevronsUpDown className="w-3.5 h-3.5 text-gray-400 ml-0.5 shrink-0" />;
  return sortDir === "asc" ? (
    <ChevronUp className="w-3.5 h-3.5 text-blue-600 ml-0.5 shrink-0" />
  ) : (
    <ChevronDown className="w-3.5 h-3.5 text-blue-600 ml-0.5 shrink-0" />
  );
}

/* ─── Th ─────────────────────────────────────────────────────────────────── */
function Th({
  col,
  sortKey,
  sortDir,
  onSort,
  className,
  children,
}: {
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-left text-xs font-semibold whitespace-nowrap cursor-pointer select-none hover:bg-amber-100 transition-colors",
        className,
      )}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
      </span>
    </th>
  );
}

/* ─── MultiSelectFilter ──────────────────────────────────────────────────── */
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

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function SuspectedBadDebt() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("suspected_bad_debt", "view");
  const canExport = can("suspected_bad_debt", "export");
  const { setActions } = useNavActions();

  /* ── GPS Location Dialog ── */
  const { dialogState, openDialog, closeDialog } = useLocationDialog();

  /* ── filters ── */
  const [search, setSearch] = useState("");
  const [approveMonthFilter, setApproveMonthFilter] = useState<Set<string>>(new Set());
  const [debtStatusFilter, setDebtStatusFilter] = useState<Set<string>>(new Set());
  const [osFilter, setOsFilter] = useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set());
  const [debtValueMin, setDebtValueMin] = useState("");
  // ออนไลน์ล่าสุด multi-select
  const [onlineFilter, setOnlineFilter] = useState<Set<string>>(new Set());

  /* ── sort ── */
  const [sortKey, setSortKey] = useState<SortKey>("debtValue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  /* ── virtual scroll ref ── */
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ── data ── */
  const { data, isLoading } = trpc.suspectedBadDebt.list.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section, staleTime: 5 * 60 * 1000 },
  );
  const allRows: Row[] = useMemo(() => (data?.rows ?? []) as Row[], [data?.rows]);

  /* ── MDM online days: ดึงจาก row.lastOnlineDays (map จาก contracts table) ── */

  /* ── approve month options ── */
  const approveMonthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) {
      if (r.approveDate) {
        const ym = r.approveDate.slice(0, 7);
        if (ym) set.add(ym);
      }
    }
    return Array.from(set).sort().reverse();
  }, [allRows]);

  /* ── model options ──
   * dedup ด้วย base model (ตัด capacity ออก)
   * เช่น "iPhone 14 128GB" + "iPhone 14 256GB" → แสดงเป็น "iPhone 14" ตัวเดียว
   * ถ้าเลือก osFilter ไว้ จะแสดงเฉพาะรุ่นที่ตรงกับ OS นั้น
   */
  // canonicalMap: lowercase key → canonical display form เช่น "iphone 14" → "iPhone 14"
  const modelCanonicalMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allRows) {
      if (!r.model) continue;
      const { base } = parseModelParts(r.model);
      if (!base) continue;
      const key = base.toLowerCase();
      if (!map.has(key)) map.set(key, base);
    }
    return map;
  }, [allRows]);

  const modelOptions = useMemo(() => {
    // dedup ด้วย lowercase key เพื่อรวมรุ่นที่ต่างกันแค่ case
    const keySet = new Set<string>();
    for (const r of allRows) {
      if (!r.model) continue;
      if (osFilter.size > 0) {
        const os = deriveOS(r.model);
        if (!os || !osFilter.has(os)) continue;
      }
      const { base } = parseModelParts(r.model);
      if (!base) continue;
      keySet.add(base.toLowerCase());
    }
    // คืน lowercase key เพื่อใช้เป็น option value (ไม่มีปัญหา CommandItem lowercase)
    return Array.from(keySet).sort((a, b) => a.localeCompare(b, "th"));
  }, [allRows, osFilter]);

  /* ── reset modelFilter เมื่อ osFilter เปลี่ยนแล้วรุ่นที่เลือกไว้ไม่อยู่ใน options ใหม่ ── */
  React.useEffect(() => {
    setModelFilter((prev) => {
      const filtered = Array.from(prev).filter((m) => modelOptions.includes(m));
      // ถ้าไม่มีการเปลี่ยนแปลง คืน Set เดิม
      if (filtered.length === prev.size) return prev;
      return new Set(filtered);
    });
  }, [modelOptions]);

  /* ── filtered + sorted rows ── */
  const filteredRows = useMemo(() => {
    let rows = allRows;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.contractNo?.toLowerCase().includes(q) ||
          r.customerName?.toLowerCase().includes(q) ||
          r.phone?.toLowerCase().includes(q) ||
          r.serialNo?.toLowerCase().includes(q),
      );
    }

    if (approveMonthFilter.size > 0) {
      rows = rows.filter((r) => r.approveDate && approveMonthFilter.has(r.approveDate.slice(0, 7)));
    }

    if (debtStatusFilter.size > 0) {
      rows = rows.filter((r) => debtStatusFilter.has(r.debtStatus));
    }

    if (osFilter.size > 0) {
      rows = rows.filter((r) => {
        const os = deriveOS(r.model);
        return os && osFilter.has(os);
      });
    }

    if (modelFilter.size > 0) {
      rows = rows.filter((r) => {
        const { base } = parseModelParts(r.model);
        return base && modelFilter.has(base.toLowerCase());
      });
    }

    if (debtValueMin) {
      const min = parseFloat(debtValueMin);
      if (!isNaN(min)) {
        rows = rows.filter((r) => r.debtValue >= min);
      }
    }

    if (onlineFilter.size > 0) {
      rows = rows.filter((r) => {
        const days = r.lastOnlineDays ?? 999;
        if (onlineFilter.has("today") && days === 0) return true;
        if (onlineFilter.has("1-3") && days >= 1 && days <= 3) return true;
        if (onlineFilter.has("4-7") && days >= 4 && days <= 7) return true;
        if (onlineFilter.has(">7") && days > 7) return true;
        return false;
      });
    }

    return rows.sort((a, b) => {
      const va = (a as any)[sortKey];
      const vb = (b as any)[sortKey];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [
    allRows,
    search,
    approveMonthFilter,
    debtStatusFilter,
    osFilter,
    modelFilter,
    debtValueMin,
    onlineFilter,
    sortKey,
    sortDir,
  ]);

  /* ── summary ── */
  const summary = useMemo(() => {
    return {
      count: filteredRows.length,
      cost: filteredRows.reduce((acc, r) => acc + (r.cost ?? 0), 0),
      totalPaid: filteredRows.reduce((acc, r) => acc + (r.totalPaid ?? 0), 0),
      debtValue: filteredRows.reduce((acc, r) => acc + (r.debtValue ?? 0), 0),
    };
  }, [filteredRows]);

  /* ── virtualizer ── */
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  /* ── nav actions ── */
  React.useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar />
      </div>,
    );
    return () => setActions(null);
  }, [setActions]);

  /* ── handlers ── */
  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const handleExport = async () => {
    if (!canExport || filteredRows.length === 0) return;
    const toastId = toast.loading("กำลังเตรียมไฟล์ Excel...");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const headers = [
        "ลำดับ",
        "วันที่อนุมัติ",
        "เลขที่สัญญา",
        "ชื่อลูกค้า",
        "เบอร์โทร",
        "Serial No.",
        "รุ่น / ความจุ",
        "ราคาขาย",
        "ยอดจัด",
        "ต้นทุนเครื่อง",
        "งวดที่จ่าย",
        "ยอดชำระรวม",
        "มูลค่าความเสียหาย",
        "สถานะ",
        "ค้างชำระ (วัน)",
        "ออนไลน์ล่าสุด",
      ];
      const data = filteredRows.map((r, i) => [
        i + 1,
        fmtDate(r.approveDate),
        r.contractNo,
        r.customerName,
        r.phone,
        r.serialNo,
        fmtModelDisplay(r.model),
        r.sellPrice,
        r.financeAmount,
        r.cost,
        r.paidInstallments,
        r.totalPaid,
        r.debtValue,
        r.debtStatus,
        r.daysOverdue,
        r.lastOnlineDays === 0 ? "วันนี้" : r.lastOnlineDays ? `${r.lastOnlineDays} วันที่แล้ว` : "-",
      ]);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      XLSX.utils.book_append_sheet(wb, ws, "หนี้สงสัยจะเสีย");
      XLSX.writeFile(wb, `หนี้สงสัยจะเสีย_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("ดาวน์โหลด Excel สำเร็จ", { id: toastId });
    } catch (err) {
      console.error(err);
      toast.error("เกิดข้อผิดพลาดในการ Export", { id: toastId });
    }
  };

  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64 text-gray-500">
          คุณไม่มีสิทธิ์เข้าถึงหน้านี้
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell fullHeight>
      <div className="flex flex-col h-full bg-gray-50 overflow-hidden">
        {/* ── header ── */}
        <div className="bg-white border-b border-gray-200 px-4 py-3 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              <h1 className="text-lg font-bold text-gray-900">หนี้สงสัยจะเสีย</h1>
              {section && <span className="text-sm text-gray-500 font-normal">— {section}</span>}
            </div>
            {canExport && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs text-green-700 border-green-200 hover:bg-green-50"
                onClick={handleExport}
                disabled={filteredRows.length === 0}
              >
                <Download className="w-3.5 h-3.5" />
                Export Excel
              </Button>
            )}
          </div>
          <p className="text-xs text-gray-500">
            แสดงสัญญาที่ค้างชำระเกิน 30 วัน หรือมีสถานะหนี้เสีย/ระงับสัญญา
          </p>
        </div>

        {/* ── summary cards ── */}
        <div className="px-4 pt-3 pb-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
            label="จำนวนสัญญา"
            value={summary.count.toLocaleString("th-TH")}
            colorClass="border-amber-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-blue-500" />}
            label="ต้นทุนรวม"
            value={fmtMoney(summary.cost)}
            colorClass="border-blue-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-green-500" />}
            label="ยอดชำระรวม"
            value={fmtMoney(summary.totalPaid)}
            colorClass="border-green-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-red-500" />}
            label="มูลค่าความเสียหาย"
            value={fmtMoney(summary.debtValue)}
            colorClass="border-red-100"
          />
        </div>

        {/* ── filter bar ── */}
        <div className="px-4 pb-2">
          <div className="flex flex-col gap-2">
            {/* row 1: search + filters */}
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              {/* search */}
              <div className="relative flex-1 min-w-0 max-w-[210px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="ค้นหา: เลขที่สัญญา / ชื่อ / เบอร์โทร"
                  className="pl-9 h-9 text-sm bg-white"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2"
                  >
                    <X className="w-3.5 h-3.5 text-gray-400" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <MultiSelectFilter
                  label="เดือนที่อนุมัติ"
                  options={approveMonthOptions}
                  selected={approveMonthFilter}
                  onChange={setApproveMonthFilter}
                  formatOption={fmtMonthLabel}
                />
                <MultiSelectFilter
                  label="สถานะ"
                  options={["ปกติ", "เกิน 31-60", "เกิน 61-90", "เกิน >90", "ระงับสัญญา", "หนี้เสีย"]}
                  selected={debtStatusFilter}
                  onChange={setDebtStatusFilter}
                />
                <MultiSelectFilter
                  label="Device"
                  options={["iPhone", "iPad", "Android"]}
                  selected={osFilter}
                  onChange={setOsFilter}
                />
                <MultiSelectFilter
                  label="รุ่น"
                  options={modelOptions}
                  selected={modelFilter}
                  onChange={setModelFilter}
                  formatOption={(k) => modelCanonicalMap.get(k) ?? k}
                />
                <div className="flex items-center gap-1.5 h-9 px-3 py-1.5 rounded-md border border-gray-200 bg-white min-w-[140px]">
                  <span className="text-xs text-gray-400 shrink-0">มูลค่าหนี้ &gt;</span>
                  <input
                    type="number"
                    className="w-full text-xs font-medium focus:outline-none bg-transparent"
                    placeholder="0"
                    value={debtValueMin}
                    onChange={(e) => setDebtValueMin(e.target.value)}
                  />
                </div>
                {/* ออนไลน์ล่าสุด filter */}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mr-1">ออนไลน์:</span>
                  <div className="flex bg-gray-100 p-0.5 rounded-md">
                    {[
                      { id: "today", label: "วันนี้" },
                      { id: "1-3",   label: "1-3 วัน" },
                      { id: "4-7",   label: "4-7 วัน" },
                      { id: ">7",    label: ">7 วัน" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => {
                          const next = new Set(onlineFilter);
                          if (next.has(opt.id)) next.delete(opt.id);
                          else next.add(opt.id);
                          setOnlineFilter(next);
                        }}
                        className={cn(
                          "px-2 py-1 text-[10px] font-medium rounded transition-all",
                          onlineFilter.has(opt.id)
                            ? "bg-white text-blue-600 shadow-sm"
                            : "text-gray-500 hover:text-gray-700"
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── table ── */}
        <div className="flex-1 overflow-hidden px-4 pb-4">
          <div className="h-full border border-gray-200 rounded-lg bg-white flex flex-col overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse table-fixed min-w-[1400px]">
                <thead className="sticky top-0 z-20 bg-amber-50 border-b border-gray-200">
                  <tr>
                    <th className="w-10 px-2 py-2 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider">#</th>
                    <Th col="approveDate" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-24">วันที่อนุมัติ</Th>
                    <Th col="contractNo" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-36">เลขที่สัญญา</Th>
                    <Th col="customerName" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-40">ชื่อลูกค้า / เบอร์โทร</Th>
                    <Th col="model" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-44">รุ่น / ความจุ</Th>
                    <Th col="sellPrice" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-24 text-right">ราคาขาย</Th>
                    <Th col="financeAmount" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-24 text-right">ยอดจัด</Th>
                    <Th col="cost" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-24 text-right">ต้นทุนเครื่อง</Th>
                    <Th col="paidInstallments" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-20 text-center">งวดที่จ่าย</Th>
                    <Th col="totalPaid" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-28 text-right">ยอดชำระรวม</Th>
                    <Th col="debtValue" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-32 text-right">มูลค่าความเสียหาย</Th>
                    <Th col="daysOverdue" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-24 text-center">ค้างชำระ</Th>
                    <th className="w-32 px-3 py-2 text-left text-xs font-semibold whitespace-nowrap">สถานะ / ออนไลน์</th>
                  </tr>
                </thead>
              </table>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto min-w-[1400px]">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center h-48 gap-3">
                  <Spinner size="lg" />
                  <p className="text-sm text-gray-400">กำลังโหลดข้อมูล...</p>
                </div>
              ) : filteredRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-gray-400 gap-2">
                  <Search className="w-8 h-8 opacity-20" />
                  <p className="text-sm">ไม่พบข้อมูลที่ตรงกับเงื่อนไข</p>
                </div>
              ) : (
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const r = filteredRows[virtualRow.index];
                    const os = deriveOS(r.model);
                    const isToday = r.lastOnlineDays === 0;

                    return (
                      <div
                        key={r.contractExternalId}
                        className={cn(
                          "absolute top-0 left-0 w-full flex border-b border-gray-100 hover:bg-blue-50/30 transition-colors group min-w-[1400px]",
                          virtualRow.index % 2 === 1 ? "bg-gray-50/50" : "bg-white",
                        )}
                        style={{
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div className="w-10 shrink-0 flex items-center justify-center text-[10px] text-gray-400 font-medium">
                          {virtualRow.index + 1}
                        </div>
                        <div className="w-24 shrink-0 flex items-center px-3 text-xs text-gray-600">
                          {fmtDate(r.approveDate)}
                        </div>
                        <div className="w-36 shrink-0 flex items-center px-3 min-w-0 overflow-hidden">
                          <span className="text-xs font-bold text-blue-600 truncate block w-full">{r.contractNo}</span>
                        </div>
                        <div className="w-40 shrink-0 flex flex-col justify-center px-3 min-w-0">
                          <span className="text-xs font-bold text-gray-800 truncate">{r.customerName}</span>
                          <span className="text-[10px] text-gray-500">{r.phone}</span>
                        </div>
                        <div className="w-44 shrink-0 flex items-center px-3 gap-2 min-w-0">
                          <div className="shrink-0 w-6 h-6 rounded bg-gray-100 flex items-center justify-center">
                            {os === "iPhone" ? (
                              <Smartphone className="w-3.5 h-3.5 text-slate-600" />
                            ) : (
                              <Smartphone className="w-3.5 h-3.5 text-emerald-600" />
                            )}
                          </div>
                          <div className="min-w-0 flex flex-col">
                            <span className="text-xs font-medium text-gray-700 truncate">{fmtModelDisplay(r.model)}</span>
                            <span className="text-[9px] text-gray-400 truncate uppercase">{r.serialNo}</span>
                          </div>
                        </div>
                        <div className="w-24 shrink-0 flex items-center justify-end px-3 text-xs text-gray-600 font-medium">
                          {fmtMoney(r.sellPrice)}
                        </div>
                        <div className="w-24 shrink-0 flex items-center justify-end px-3 text-xs text-gray-700 font-bold">
                          {fmtMoney(r.financeAmount)}
                        </div>
                        <div className="w-24 shrink-0 flex items-center justify-end px-3 text-xs text-gray-500">
                          {fmtMoney(r.cost)}
                        </div>
                        <div className="w-20 shrink-0 flex items-center justify-center px-3">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-bold">
                            {r.paidInstallments}/{r.installmentCount ?? "?"}
                          </span>
                        </div>
                        <div className="w-28 shrink-0 flex items-center justify-end px-3 text-xs text-emerald-600 font-bold">
                          {fmtMoney(r.totalPaid)}
                        </div>
                        <div className="w-32 shrink-0 flex items-center justify-end px-3 text-xs text-red-600 font-bold">
                          {fmtMoney(r.debtValue)}
                        </div>
                        <div className="w-24 shrink-0 flex items-center justify-center px-3">
                          <span className={cn(
                            "text-xs font-bold",
                            r.daysOverdue > 90 ? "text-rose-600" :
                            r.daysOverdue > 60 ? "text-orange-600" :
                            "text-amber-600"
                          )}>
                            {r.daysOverdue} วัน
                          </span>
                        </div>
                        <div className="w-32 shrink-0 flex items-center px-3 gap-2">
                          <div className="flex flex-col gap-1 w-full">
                            <div className="flex items-center justify-between">
                              <span className={cn(
                                "text-[10px] font-bold px-1 rounded",
                                r.debtStatus === "หนี้เสีย" ? "bg-gray-800 text-white" :
                                r.debtStatus === "ระงับสัญญา" ? "bg-slate-500 text-white" :
                                "bg-amber-100 text-amber-800"
                              )}>
                                {r.debtStatus}
                              </span>
                              {r.mdmDeviceId && (
                                <button
                                  onClick={() => openDialog(r.mdmDeviceId!, r.customerName ?? r.contractNo ?? "")}
                                  className="text-blue-500 hover:text-blue-700 p-0.5 hover:bg-blue-50 rounded transition-colors"
                                  title="ดูตำแหน่งล่าสุด"
                                >
                                  <MapPin className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <div className={cn(
                                "w-1.5 h-1.5 rounded-full shrink-0",
                                isToday ? "bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]" :
                                (r.lastOnlineDays ?? 999) <= 3 ? "bg-amber-400" : "bg-gray-300"
                              )} />
                              <span className={cn(
                                "text-[10px] font-medium",
                                isToday ? "text-emerald-600" : "text-gray-400"
                              )}>
                                {isToday ? "ออนไลน์วันนี้" : r.lastOnlineDays ? `${r.lastOnlineDays} วันที่แล้ว` : "ไม่พบข้อมูล"}
                              </span>
                              {/* ไอคอน Lost Mode (lossStatus): 1=ล็อกเครื่อง (สีแดง), 0=ไม่ล็อค (สีเขียว) */}
                              {r.lossStatus === 1 ? (
                                <Lock className="inline-block w-3 h-3 text-red-500 ml-0.5 flex-shrink-0" title="Lost Mode: ล็อกเครื่อง" />
                              ) : r.lossStatus === 0 ? (
                                <Lock className="inline-block w-3 h-3 text-green-500 ml-0.5 flex-shrink-0" title="Lost Mode: ไม่ล็อก" />
                              ) : null}
                              {/* ไอคอน MDM Control (deviceLock): true=อยู่ภายใต้ MDM (สีเขียว), false=หลุดจาก MDM (สีเทา) */}
                              {r.deviceLock === true ? (
                                <ShieldCheck className="inline-block w-3 h-3 text-green-500 ml-0.5 flex-shrink-0" title="MDM: อยู่ภายใต้การควบคุม" />
                              ) : r.deviceLock === false ? (
                                <ShieldOff className="inline-block w-3 h-3 text-gray-400 ml-0.5 flex-shrink-0" title="MDM: หลุดจากการควบคุม" />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <LocationDialog
        isOpen={dialogState.isOpen}
        onClose={closeDialog}
        mdmDeviceId={dialogState.mdmDeviceId}
        title={dialogState.title}
      />
    </AppShell>
  );
}

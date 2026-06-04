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
  LockOpen,
  Search,
  X,
} from "lucide-react";
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
          r.phone?.toLowerCase().includes(q),
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
      // กรองด้วย base model (lowercase) เพื่อรวมรุ่นที่ต่างกันแค่ case เช่น "iPhone 14" กับ "iphone 14"
      rows = rows.filter((r) => {
        if (!r.model) return false;
        const { base } = parseModelParts(r.model);
        return base != null && modelFilter.has(base.toLowerCase());
      });
    }

    if (debtValueMin !== "" && !isNaN(Number(debtValueMin))) {
      const minVal = Number(debtValueMin);
      rows = rows.filter((r) => r.debtValue > minVal);
    }

    // filter ออนไลน์ล่าสุด
    if (onlineFilter.size > 0) {
      rows = rows.filter((r) => {
        const days = r.lastOnlineDays;
        if (days == null) return false;
        let bucket: string;
        if (days === 0) bucket = "today";
        else if (days <= 3) bucket = "1-3";
        else if (days <= 7) bucket = "4-7";
        else bucket = "over7";
        return onlineFilter.has(bucket);
      });
    }

    rows = [...rows].sort((a, b) => {
      let av: any, bv: any;
      switch (sortKey) {
        case "approveDate":   av = a.approveDate ?? "";   bv = b.approveDate ?? "";   break;
        case "contractNo":    av = a.contractNo ?? "";    bv = b.contractNo ?? "";    break;
        case "customerName":  av = a.customerName ?? "";  bv = b.customerName ?? "";  break;
        case "phone":         av = a.phone ?? "";         bv = b.phone ?? "";         break;
        case "model":         av = a.model ?? "";         bv = b.model ?? "";         break;
        case "sellPrice":     av = a.sellPrice ?? 0;      bv = b.sellPrice ?? 0;      break;
        case "financeAmount": av = a.financeAmount ?? 0;  bv = b.financeAmount ?? 0;  break;
        case "commissionNet": av = a.commissionNet ?? 0;  bv = b.commissionNet ?? 0;  break;
        case "incentive": av = a.incentive ?? 0;  bv = b.incentive ?? 0;  break;
        case "cost":          av = a.cost;                bv = b.cost;                break;
        case "paidInstallments": av = a.paidInstallments; bv = b.paidInstallments;   break;
        case "totalPaid":     av = a.totalPaid;           bv = b.totalPaid;           break;
        case "debtValue":     av = a.debtValue;           bv = b.debtValue;           break;
        default:              av = 0;                     bv = 0;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
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
    const count = filteredRows.length;
    const cost = filteredRows.reduce((s, r) => s + r.cost, 0);
    const totalPaid = filteredRows.reduce((s, r) => s + r.totalPaid, 0);
    const debtValue = filteredRows.reduce((s, r) => s + r.debtValue, 0);
    return { count, cost, totalPaid, debtValue };
  }, [filteredRows]);

  /* ── virtual scroll ── */
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 20,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1].end
      : 0;

  /* ── sort handler ── */
  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [sortKey],
  );

  /* ── clear filters ── */
  const hasFilter =
    !!search ||
    approveMonthFilter.size > 0 ||
    debtStatusFilter.size > 0 ||
    osFilter.size > 0 ||
    modelFilter.size > 0 ||
    !!debtValueMin ||
    onlineFilter.size > 0;

  const clearFilters = () => {
    setSearch("");
    setApproveMonthFilter(new Set());
    setDebtStatusFilter(new Set());
    setOsFilter(new Set());
    setModelFilter(new Set());
    setDebtValueMin("");
    setOnlineFilter(new Set());
  };

  /* ── export XLSX ── */
  const handleExport = useCallback(async () => {
    if (!canExport) {
      toast.error("คุณไม่มีสิทธิ์ Export ข้อมูล");
      return;
    }
    const toastId = toast.loading("กำลัง Export...");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const headers = [
        "#","วันที่อนุมัติ","เลขที่สัญญา","ชื่อ-นามสกุล","เบอร์โทร",
        "รุ่น","ราคา","ยอดจัดไฟแนนซ์","ค่าคอมมิชชั่น","Incentive","ต้นทุน",
        "งวดที่ชำระ","ยอดชำระ","มูลค่าหนี้","เกินกำหนด (วัน)","สถานะหนี้","Online (วันที่แล้ว)",
      ];
      const dataRows = filteredRows.map((r, i) => {
        const onlineDays = r.lastOnlineDays;
        const onlineLabel = onlineDays == null ? "-" : onlineDays === 0 ? "วันนี้" : `${onlineDays} วันที่แล้ว`;
        return [
          i + 1,
          r.approveDate ? r.approveDate.slice(0, 10) : "",
          r.contractNo ?? "",
          r.customerName ?? "",
          r.phone ?? "",
          r.model ?? "",
          r.sellPrice ?? 0,
          r.financeAmount ?? 0,
          r.commissionNet ?? 0,
          r.incentive ?? 0,
          r.cost ?? 0,
          `${r.paidInstallments}/${r.installmentCount ?? "-"}`,
          r.totalPaid ?? 0,
          r.debtValue ?? 0,
          r.daysOverdue ?? 0,
          r.debtStatus ?? "",
          onlineLabel,
        ];
      });
      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
      ws["!cols"] = [
        { wch: 6 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 14 },
        { wch: 24 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
        { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
      ];
      // Style header row (amber-100 bg, mirrors SuspectedBadDebt.tsx UI)
      for (let C = 0; C < headers.length; C++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c: C });
        if (!ws[addr]) ws[addr] = { t: "s", v: headers[C] };
        ws[addr].s = {
          fill: { patternType: "solid", fgColor: { rgb: "FEF3C7" } },
          font: { bold: true, color: { rgb: "78350F" } },
          alignment: { horizontal: "center", vertical: "center", wrapText: true },
          border: { bottom: { style: "thin", color: { rgb: "D1D5DB" } } },
        };
      }
      // Cell types: number for money/count columns
      for (let R = 1; R <= dataRows.length; R++) {
        const seqAddr = XLSX.utils.encode_cell({ r: R, c: 0 });
        if (ws[seqAddr]) { ws[seqAddr].t = "n"; ws[seqAddr].z = "#,##0"; }
        for (const C of [6, 7, 8, 9, 11, 12]) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (ws[addr]) { ws[addr].t = "n"; ws[addr].z = "#,##0.00"; }
        }
      }
      XLSX.utils.book_append_sheet(wb, ws, "หนี้สงสัยจะเสีย");
      XLSX.writeFile(wb, `suspected_bad_debt_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  }, [filteredRows, canExport, section]);

  /* ── nav actions ── */
  React.useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar />
      </div>
    );
    return () => setActions(null);
  }, [setActions]);

  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
          คุณไม่มีสิทธิ์เข้าถึงหน้านี้
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-col h-full">
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
            label="มูลค่าหนี้รวม"
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
              </div>

              {/* filter dropdowns */}
              <div className="flex flex-wrap items-center gap-2">
                {/* เดือน-ปีที่อนุมัติ */}
                <MultiSelectFilter
                  label="เดือน-ปีที่อนุมัติ"
                  selected={approveMonthFilter}
                  onChange={setApproveMonthFilter}
                  options={approveMonthOptions}
                  placeholder="ทุกเดือน-ปีที่อนุมัติ"
                  formatOption={fmtMonthLabel}
                />

                {/* สถานะหนี้ */}
                <MultiSelectFilter
                  label="สถานะหนี้"
                  selected={debtStatusFilter}
                  onChange={setDebtStatusFilter}
                  options={["เกิน 61-90", "เกิน >90"]}
                  placeholder="ทุกสถานะหนี้"
                />

                {/* iOS/Android */}
                <MultiSelectFilter
                  label="ประเภทเครื่อง"
                  selected={osFilter}
                  onChange={setOsFilter}
                  options={["iOS", "Android"]}
                  placeholder="ทุกประเภท"
                />

                {/* รุ่นเครื่อง — options คือ base model (ยุบรวมแล้ว) ไม่ต้อง format เพิ่มเติม */}
                <MultiSelectFilter
                  label="รุ่นเครื่อง"
                  selected={modelFilter}
                  onChange={setModelFilter}
                  options={modelOptions}
                  placeholder="ทุกรุ่น"
                  formatOption={(k) => modelCanonicalMap.get(k) ?? k}
                />

                {/* มูลค่าหนี้ > */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500 whitespace-nowrap">มูลค่าหนี้ &gt;</span>
                  <Input
                    type="number"
                    value={debtValueMin}
                    onChange={(e) => setDebtValueMin(e.target.value)}
                    placeholder="0"
                    className="h-9 text-xs w-24"
                  />
                </div>

                {/* ออนไลน์ล่าสุด multi-select */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500 whitespace-nowrap">ออนไลน์:</span>
                  {([
                    { value: "today", label: "• วันนี้", activeClass: "bg-green-100 text-green-700 border-green-300" },
                    { value: "1-3",   label: "1–3 วัน", activeClass: "bg-yellow-100 text-yellow-700 border-yellow-300" },
                    { value: "4-7",   label: "4–7 วัน", activeClass: "bg-orange-100 text-orange-700 border-orange-300" },
                    { value: "over7", label: ">7 วัน",  activeClass: "bg-red-100 text-red-700 border-red-300" },
                  ] as { value: string; label: string; activeClass: string }[]).map((opt) => {
                    const active = onlineFilter.has(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          const next = new Set(onlineFilter);
                          if (active) next.delete(opt.value); else next.add(opt.value);
                          setOnlineFilter(next);
                        }}
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                          active
                            ? opt.activeClass
                            : "bg-gray-50 text-gray-500 border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* ล้างตัวกรอง */}
                {hasFilter && (
                  <button
                    onClick={clearFilters}
                    className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 h-9 px-2 rounded-md border border-red-200 hover:border-red-400 bg-red-50 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    ล้างตัวกรอง
                  </button>
                )}
                {/* Export Excel */}
                {canExport && (
                  <button
                    type="button"
                    onClick={handleExport}
                    className="ml-auto flex items-center gap-1.5 h-9 px-3 text-sm font-medium rounded-md bg-green-600 hover:bg-green-700 text-white transition-colors whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" />
                    <span className="hidden sm:inline">Export Excel</span>
                  </button>
                )}
              </div>
            </div>

            {/* row 2: result count */}
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>
                แสดง{" "}
                <span className="font-semibold text-gray-700">
                  {filteredRows.length.toLocaleString("th-TH")}
                </span>{" "}
                จาก{" "}
                <span className="font-semibold text-gray-700">
                  {allRows.length.toLocaleString("th-TH")}
                </span>{" "}
                รายการ
              </span>
            </div>
          </div>
        </div>

        {/* ── table ── */}
        <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <Spinner className="w-6 h-6 text-blue-500" />
              <span className="ml-2 text-sm text-gray-500">กำลังโหลด...</span>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
              <AlertTriangle className="w-8 h-8 mb-2 text-amber-300" />
              <p className="text-sm">ไม่พบข้อมูลหนี้สงสัยจะเสีย</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 border rounded-lg overflow-hidden">
              {/* scrollable container for virtual scroll */}
              <div ref={scrollRef} className="flex-1 overflow-auto">
                <table className="w-full text-xs border-collapse">
                  <thead
                    className="bg-amber-50 text-gray-700 border-b border-amber-200"
                    style={{ position: "sticky", top: 0, zIndex: 10 }}
                  >
                    <tr>
                      <th className="px-3 py-2 text-center text-xs font-semibold whitespace-nowrap w-10">#</th>
                      <Th col="approveDate" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px]">
                        วันที่อนุมัติ
                      </Th>
                      <Th col="contractNo" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[170px]">
                        เลขที่สัญญา
                      </Th>
                      <Th col="customerName" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[160px]">
                        ชื่อ-นามสกุล
                      </Th>
                      <Th col="phone" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px]">
                        เบอร์โทร
                      </Th>
                      <Th col="model" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[200px]">
                        รุ่น
                      </Th>
                      <Th col="sellPrice" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[90px] text-right">
                        ราคา
                      </Th>
                      <Th col="financeAmount" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-right">
                        ยอดจัดไฟแนนซ์
                      </Th>
                      <Th col="commissionNet" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-right">
                        ค่าคอมมิชชั่น
                      </Th>
                      <Th col="incentive" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[100px] text-right">
                        Incentive
                      </Th>
                      <Th col="cost" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[100px] text-right">
                        ต้นทุน
                      </Th>
                      <Th col="paidInstallments" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[90px] text-center">
                        งวดที่ชำระ
                      </Th>
                      <Th col="totalPaid" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-right">
                        ยอดชำระ
                      </Th>
                      <Th col="debtValue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[100px] text-right">
                        มูลค่าหนี้
                      </Th>
                      <Th col="daysOverdue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[100px] text-right">
                        เกินกำหนด
                      </Th>
                      <th className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap min-w-[110px]">
                        สถานะหนี้
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold whitespace-nowrap min-w-[90px]">
                        Online
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* top padding for virtual scroll */}
                    {paddingTop > 0 && (
                      <tr>
                        <td colSpan={17} style={{ height: paddingTop }} />
                      </tr>
                    )}
                    {virtualRows.map((vRow) => {
                      const r = filteredRows[vRow.index];
                      const isOdd = vRow.index % 2 === 0;
                      return (
                        <tr
                          key={r.contractExternalId}
                          data-index={vRow.index}
                          ref={rowVirtualizer.measureElement}
                          className={cn(
                            "hover:bg-amber-50 transition-colors",
                            isOdd ? "bg-white" : "bg-gray-50/50",
                          )}
                        >
                          <td className="px-3 py-1.5 text-center text-gray-400">
                            {vRow.index + 1}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {fmtDate(r.approveDate)}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap font-mono text-blue-700">
                            {r.contractNo ?? "-"}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {r.customerName ?? "-"}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {r.phone ?? "-"}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {fmtModelDisplay(r.model)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {fmtMoney(r.sellPrice)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {fmtMoney(r.financeAmount)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {fmtMoney(r.commissionNet)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {fmtMoney(r.incentive)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap font-semibold">
                            {fmtMoney(r.cost)}
                          </td>
                          <td className="px-3 py-1.5 text-center whitespace-nowrap font-mono">
                            {r.paidInstallments}/{r.installmentCount ?? "-"}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-green-700">
                            {fmtMoney(r.totalPaid)}
                          </td>
                          <td
                            className={cn(
                              "px-3 py-1.5 text-right whitespace-nowrap font-semibold",
                              r.debtValue > 0 ? "text-red-600" : "text-gray-500",
                            )}
                          >
                            {fmtMoney(r.debtValue)}
                          </td>
                          {/* คอลัมน์เกินกำหนด: แสดงจำนวนวันที่เกินกำหนดชำระ */}
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-orange-600 font-medium">
                            {r.daysOverdue > 0 ? `${r.daysOverdue} วัน` : "-"}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <span
                              className={cn(
                                "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium",
                                r.debtStatus === "เกิน >90"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-amber-100 text-amber-700",
                              )}
                            >
                              {r.debtStatus}
                            </span>
                          </td>
                          {/* Online column: วันที่ออนไลน์ล่าสุดจาก MDM + ไอคอนกุญแจ */}
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            {(() => {
                              const days = r.lastOnlineDays;
                              // ไอคอนกุญแจ: true=ล็อค (สีแดง), false=ปลดล็อค (สีเขียว), null=ไม่แสดง
                              const lockIcon = r.deviceLock === true ? (
                                <Lock className="inline-block w-3 h-3 text-red-500 ml-1 flex-shrink-0" />
                              ) : r.deviceLock === false ? (
                                <LockOpen className="inline-block w-3 h-3 text-green-500 ml-1 flex-shrink-0" />
                              ) : null;
                              if (days == null) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span className="text-gray-400 text-xs">–</span>
                                  {lockIcon}
                                </span>
                              );
                              // tooltip: แสดงวันที่และเวลาออนไลน์ล่าสุดเมื่อ hover
                              const tooltipText = r.lastOnlineAt
                                ? `ออนไลน์ล่าสุด: ${r.lastOnlineAt}`
                                : undefined;
                              if (days === 0) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 cursor-default">• วันนี้</span>
                                  {lockIcon}
                                </span>
                              );
                              if (days <= 3) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700 cursor-default">{days} วัน</span>
                                  {lockIcon}
                                </span>
                              );
                              if (days <= 7) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-100 text-orange-700 cursor-default">{days} วัน</span>
                                  {lockIcon}
                                </span>
                              );
                              return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 cursor-default">{days} วัน</span>
                                  {lockIcon}
                                </span>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                    {/* bottom padding for virtual scroll */}
                    {paddingBottom > 0 && (
                      <tr>
                        <td colSpan={17} style={{ height: paddingBottom }} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

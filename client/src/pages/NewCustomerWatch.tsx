/**
 * NewCustomerWatch — สังเกตการณ์ลูกค้าใหม่
 * แสดงรายการสัญญาที่ยังไม่ถึงกำหนดชำระงวดที่ 1 ทั้งหมด
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
  Eye,
  Info,
  Lock,
  MapPin,
  Search,
  ShieldCheck,
  ShieldOff,
  X,
} from "lucide-react";
import { LocationDialog, useLocationDialog } from "@/components/LocationDialog";
import { AppShell } from "@/components/AppShell";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
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

/* ─── Types ──────────────────────────────────────────────────────────────── */
type SortKey =
  | "seq"
  | "approveDate"
  | "contractNo"
  | "customerName"
  | "phone"
  | "productType"
  | "model"
  | "partnerCode"
  | "sellPrice"
  | "financeAmount"
  | "commissionNet"
  | "incentive"
  | "cost"
  | "installmentTotal"
  | "daysUntilDue1"
  | "daysSinceApprove";
type SortDir = "asc" | "desc";

type Row = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  serialNo: string | null;
  lastOnlineDays: number | null;
  lastOnlineAt: string | null;
  deviceLock: boolean | null;
  lossStatus: number | null;
  mdmDeviceId: number | null;
  locationLogCount: number;
  model: string | null;
  device: string | null;
  productType: string | null;
  partnerCode: string | null;
  partnerName: string | null;
  sellPrice: number | null;
  financeAmount: number | null;
  multiplier: number | null;
  commissionNet: number | null;
  incentive: number;
  installmentCount: number | null;
  installmentAmount: number | null;
  installmentTotal: number;
  cost: number;
  dueDate1: string | null;
  daysUntilDue1: number;
  daysSinceApprove: number;
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
  if (col !== sortKey)
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
        "px-3 py-2 text-left text-xs font-semibold whitespace-nowrap cursor-pointer select-none hover:bg-teal-100 transition-colors",
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
            "flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 min-w-[140px] justify-between",
            selected.size > 0
              ? "border-teal-400 bg-teal-50 text-teal-800 font-medium"
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
                    selected.size === 0 ? "opacity-100 text-teal-600" : "opacity-0",
                  )}
                />
                <span className={selected.size === 0 ? "text-teal-600 font-medium text-xs" : "text-gray-500 text-xs"}>
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
                      selected.has(opt) ? "opacity-100 text-teal-600" : "opacity-0",
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

/* ─── InfoPopover ──────────────────────────────────────────────────────────── */
function InfoPopover() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center w-7 h-7 rounded-full text-teal-600 hover:bg-teal-50 border border-teal-200 transition-colors"
          title="อธิบายความหมายสังเกตการณ์ลูกค้าใหม่"
        >
          <Info className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4 text-sm" align="end">
        <div className="space-y-3">
          <h4 className="font-semibold text-gray-800 flex items-center gap-1.5">
            <Eye className="w-4 h-4 text-teal-600" />
            สังเกตการณ์ลูกค้าใหม่
          </h4>
          <p className="text-xs text-gray-600 leading-relaxed">
            รายการสัญญาที่ยังไม่ถึงกำหนดชำระงวดที่ 1 ทั้งหมด
          </p>
          <div className="rounded-md border border-teal-200 bg-teal-50 p-3 space-y-1">
            <p className="text-xs font-semibold text-teal-800">เงื่อนไขการแสดงผล</p>
            <p className="text-xs text-teal-700 leading-relaxed">
              แสดงเฉพาะสัญญาที่วันครบกำหนดชำระงวดที่ 1 ยังไม่มาถึง
              (กำหนดชำระงวดที่ 1 &gt; วันนี้)
            </p>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-1">
            <p className="text-xs font-semibold text-gray-700">สัญญาที่ตัดออก (ไม่แสดง)</p>
            <p className="text-xs text-gray-600 leading-relaxed">
              ระงับสัญญา / หนี้เสีย / ยกเลิกสัญญา / สิ้นสุดสัญญา
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function NewCustomerWatch() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("new_customer_watch", "view");
  const canExport = can("new_customer_watch", "export");
  const { setActions } = useNavActions();

  /* ── filters ── */
  const [search, setSearch] = useState("");
  const [approveMonthFilter, setApproveMonthFilter] = useState<Set<string>>(new Set());
  const [osFilter, setOsFilter] = useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set());
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  const [partnerFilter, setPartnerFilter] = useState<Set<string>>(new Set());
  const [onlineFilter, setOnlineFilter] = useState<Set<string>>(new Set());
  const [contractAgeFilter, setContractAgeFilter] = useState<string>("all");

  /* ── GPS Location Dialog ── */
  const { dialogState, openDialog, closeDialog } = useLocationDialog();

  /* ── sort ── */
  const [sortKey, setSortKey] = useState<SortKey>("daysSinceApprove");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  /* ── virtual scroll ref ── */
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ── data ── */
  const queryInput = useMemo(() => {
    if (!section) return undefined;
    return {
      section,
      productTypes: productTypeFilter.size > 0 ? Array.from(productTypeFilter) : undefined,
    };
  }, [section, productTypeFilter]);

  const { data, isLoading } = trpc.newCustomerWatch.list.useQuery(
    queryInput as any,
    { enabled: canView && !!section && !!queryInput, staleTime: 5 * 60 * 1000 },
  );
  const today = useMemo(() => new Date(), []);
  const allRows: Row[] = useMemo(() => {
    const raw = (data?.rows ?? []) as unknown as Omit<Row, "daysSinceApprove">[];
    return raw.map((r) => {
      let daysSinceApprove = 0;
      if (r.approveDate) {
        const appDate = new Date(r.approveDate);
        daysSinceApprove = Math.max(0, Math.floor((today.getTime() - appDate.getTime()) / (1000 * 60 * 60 * 24)));
      }
      return { ...r, daysSinceApprove } as Row;
    });
  }, [data?.rows, today]);

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

  /* ── partner options ── */
  const partnerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allRows) {
      if (!r.partnerCode) continue;
      map.set(r.partnerCode, r.partnerCode);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "th"))
      .map(([code, label]) => ({ code, label }));
  }, [allRows]);

  /* ── productType options ── */
  const productTypeOptions = useMemo(() => {
    const base = ["มือ 1", "มือ 2"];
    if (section === "Boonphone") base.push("Sure+");
    return base;
  }, [section]);

  /* ── model options ── */
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
    return Array.from(keySet).sort((a, b) => a.localeCompare(b, "th"));
  }, [allRows, osFilter]);

  /* ── reset modelFilter when osFilter changes ── */
  React.useEffect(() => {
    setModelFilter((prev) => {
      const filtered = Array.from(prev).filter((m) => modelOptions.includes(m));
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
    if (osFilter.size > 0) {
      rows = rows.filter((r) => {
        const os = deriveOS(r.model);
        return os && osFilter.has(os);
      });
    }
    if (modelFilter.size > 0) {
      rows = rows.filter((r) => {
        if (!r.model) return false;
        const { base } = parseModelParts(r.model);
        return base != null && modelFilter.has(base.toLowerCase());
      });
    }
    if (partnerFilter.size > 0) {
      rows = rows.filter((r) => r.partnerCode && partnerFilter.has(r.partnerCode));
    }
    if (onlineFilter.size > 0) {
      rows = rows.filter((r) => {
        const days = r.lastOnlineDays;
        if (days == null) return false;
        let bucket: string;
        if (days === 0)       bucket = "today";
        else if (days <= 3)   bucket = "1-3";
        else if (days <= 7)   bucket = "4-7";
        else if (days <= 15)  bucket = "8-15";
        else                  bucket = "over15";
        return onlineFilter.has(bucket);
      });
    }
    // กรอง ทำสัญญามาแล้ว
    if (contractAgeFilter !== "all") {
      rows = rows.filter((r) => {
        const d = r.daysSinceApprove;
        if (contractAgeFilter === "lte3")  return d <= 3;
        if (contractAgeFilter === "lte7")  return d <= 7;
        if (contractAgeFilter === "lte15") return d <= 15;
        if (contractAgeFilter === "gt15")  return d > 15;
        return true;
      });
    }
    rows = [...rows].sort((a, b) => {
      let av: any, bv: any;
      switch (sortKey) {
        case "approveDate":      av = a.approveDate ?? "";      bv = b.approveDate ?? "";      break;
        case "contractNo":       av = a.contractNo ?? "";       bv = b.contractNo ?? "";       break;
        case "customerName":     av = a.customerName ?? "";     bv = b.customerName ?? "";     break;
        case "phone":            av = a.phone ?? "";            bv = b.phone ?? "";            break;
        case "productType":      av = a.productType ?? "";      bv = b.productType ?? "";      break;
        case "model":            av = a.model ?? "";            bv = b.model ?? "";            break;
        case "partnerCode":      av = a.partnerCode ?? "";      bv = b.partnerCode ?? "";      break;
        case "sellPrice":        av = a.sellPrice ?? 0;         bv = b.sellPrice ?? 0;         break;
        case "financeAmount":    av = a.financeAmount ?? 0;     bv = b.financeAmount ?? 0;     break;
        case "commissionNet":    av = a.commissionNet ?? 0;     bv = b.commissionNet ?? 0;     break;
        case "incentive":        av = a.incentive ?? 0;         bv = b.incentive ?? 0;         break;
        case "cost":             av = a.cost;                   bv = b.cost;                   break;
        case "installmentTotal": av = a.installmentTotal;       bv = b.installmentTotal;       break;
        case "daysUntilDue1":    av = a.daysUntilDue1;          bv = b.daysUntilDue1;          break;
        case "daysSinceApprove": av = a.daysSinceApprove;       bv = b.daysSinceApprove;       break;
        default:                 av = 0;                        bv = 0;
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
    osFilter,
    modelFilter,
    partnerFilter,
    onlineFilter,
    sortKey,
    sortDir,
  ]);

  /* ── summary ── */
  const summary = useMemo(() => {
    const count = filteredRows.length;
    const financeTotal = filteredRows.reduce((s, r) => s + (r.financeAmount ?? 0), 0);
    const commissionTotal = filteredRows.reduce((s, r) => s + (r.commissionNet ?? 0), 0);
    const incentiveTotal = filteredRows.reduce((s, r) => s + r.incentive, 0);
    const installmentTotal = filteredRows.reduce((s, r) => s + r.installmentTotal, 0);
    const costTotal = filteredRows.reduce((s, r) => s + r.cost, 0);
    return { count, financeTotal, commissionTotal, incentiveTotal, installmentTotal, costTotal };
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
    osFilter.size > 0 ||
    modelFilter.size > 0 ||
    productTypeFilter.size > 0 ||
    partnerFilter.size > 0 ||
    onlineFilter.size > 0 ||
    contractAgeFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setApproveMonthFilter(new Set());
    setOsFilter(new Set());
    setModelFilter(new Set());
    setProductTypeFilter(new Set());
    setPartnerFilter(new Set());
    setOnlineFilter(new Set());
    setContractAgeFilter("all");
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
      // คอลัมน์ Online แยกเป็น 3 คอลัมน์: ออนไลน์ / MDM / ล็อกเครื่อง
      const headers = [
        "#","วันที่อนุมัติ","เลขที่สัญญา","ชื่อ-นามสกุล","เบอร์โทร",
        "ประเภท","รุ่น","รหัสพาร์ทเนอร์","ชื่อพาร์ทเนอร์","ราคา","ยอดจัดไฟแนนซ์",
        "ค่าคอมมิชชั่น","Incentive","ต้นทุน","ยอดผ่อนรวม","ผ่อนงวดละ",
        "ทำสัญญามาแล้ว(วัน)","กำหนดชำระงวดที่ 1","เหลืออีก(วัน)",
        "ออนไลน์","MDM","ล็อกเครื่อง",
      ];
      const dataRows = filteredRows.map((r, i) => {
        const onlineDays = r.lastOnlineDays;
        // ออนไลน์: จำนวนวันที่ออนไลน์ล่าสุด
        const onlineLabel = onlineDays == null ? "-" : onlineDays === 0 ? "วันนี้" : `${onlineDays} วันที่แล้ว`;
        // MDM (ไอคอนโล่): deviceLock=true → "Yes", false → "No", null → "-"
        const mdmLabel = r.deviceLock === true ? "Yes" : r.deviceLock === false ? "No" : "-";
        // ล็อกเครื่อง (ไอคอนกุญแจ): lossStatus=1 → "ล็อก", 0 → "ปลดล็อก", null → "-"
        const lockLabel = r.lossStatus === 1 ? "ล็อก" : r.lossStatus === 0 ? "ปลดล็อก" : "-";
        return [
          i + 1,
          r.approveDate ? r.approveDate.slice(0, 10) : "",
          r.contractNo ?? "",
          r.customerName ?? "",
          r.phone ?? "",
          r.productType ?? "",
          r.model ?? "",
          r.partnerCode ?? "",
          r.partnerName ?? "",
          r.sellPrice ?? 0,
          r.financeAmount ?? 0,
          r.commissionNet ?? 0,
          r.incentive ?? 0,
          r.cost ?? 0,
          r.installmentTotal ?? 0,
          r.installmentAmount ?? 0,
          r.daysSinceApprove ?? 0,
          r.dueDate1 ? r.dueDate1.slice(0, 10) : "",
          r.daysUntilDue1 ?? 0,
          onlineLabel,
          mdmLabel,
          lockLabel,
        ];
      });
      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
      ws["!cols"] = [
        { wch: 6 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 14 },
        { wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 14 },
        { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
        { wch: 16 }, { wch: 16 }, { wch: 14 },
        { wch: 14 }, { wch: 8 }, { wch: 10 },
      ];
      // Style header row
      for (let C = 0; C < headers.length; C++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c: C });
        if (!ws[addr]) ws[addr] = { t: "s", v: headers[C] };
        ws[addr].s = {
          fill: { patternType: "solid", fgColor: { rgb: "CCFBF1" } },
          font: { bold: true, color: { rgb: "134E4A" } },
          alignment: { horizontal: "center", vertical: "center", wrapText: true },
          border: { bottom: { style: "thin", color: { rgb: "D1D5DB" } } },
        };
      }
      // Cell types
      for (let R = 1; R <= dataRows.length; R++) {
        const seqAddr = XLSX.utils.encode_cell({ r: R, c: 0 });
        if (ws[seqAddr]) { ws[seqAddr].t = "n"; ws[seqAddr].z = "#,##0"; }
        for (const C of [9, 10, 11, 12, 13, 14]) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (ws[addr]) { ws[addr].t = "n"; ws[addr].z = "#,##0.00"; }
        }
        for (const C of [15, 16, 18]) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (ws[addr]) { ws[addr].t = "n"; ws[addr].z = "#,##0"; }
        }
      }
      XLSX.utils.book_append_sheet(wb, ws, "สังเกตการณ์ลูกค้าใหม่");
      XLSX.writeFile(wb, `new_customer_watch_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
        <div className="px-4 pt-3 pb-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <SummaryCard
            icon={<Eye className="w-4 h-4 text-teal-500" />}
            label="จำนวนสัญญา"
            value={summary.count.toLocaleString("th-TH")}
            colorClass="border-teal-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-blue-500" />}
            label="ยอดจัดไฟแนนซ์รวม"
            value={fmtMoney(summary.financeTotal)}
            colorClass="border-blue-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-purple-500" />}
            label="คอมมิชชั่นรวม"
            value={fmtMoney(summary.commissionTotal)}
            colorClass="border-purple-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
            label="Incentive รวม"
            value={fmtMoney(summary.incentiveTotal)}
            colorClass="border-amber-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-green-500" />}
            label="ยอดผ่อนรวม"
            value={fmtMoney(summary.installmentTotal)}
            colorClass="border-green-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-red-500" />}
            label="ต้นทุนรวม"
            value={fmtMoney(summary.costTotal)}
            colorClass="border-red-100"
          />
        </div>

        {/* ── filter bar ── */}
        <div className="px-4 pb-2">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col md:flex-row md:items-center gap-2 flex-wrap">
              {/* search */}
              <div className="relative flex-1 min-w-0 max-w-[231px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="ค้นหา: เลขที่สัญญา / ชื่อ / เบอร์โทร"
                  className="pl-9 h-9 text-sm bg-white"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
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
                {/* ประเภท */}
                <MultiSelectFilter
                  label="ประเภท"
                  selected={productTypeFilter}
                  onChange={setProductTypeFilter}
                  options={productTypeOptions}
                  placeholder="ทุกประเภท"
                />
                {/* OS */}
                <MultiSelectFilter
                  label="OS"
                  selected={osFilter}
                  onChange={setOsFilter}
                  options={["iOS", "Android"]}
                  placeholder="ทุก OS"
                />
                {/* รุ่น */}
                <MultiSelectFilter
                  label="รุ่น"
                  selected={modelFilter}
                  onChange={setModelFilter}
                  options={modelOptions}
                  placeholder="ทุกรุ่น"
                  formatOption={(k) => modelCanonicalMap.get(k) ?? k}
                />
                {/* พาร์ทเนอร์ */}
                <MultiSelectFilter
                  label="พาร์ทเนอร์"
                  selected={partnerFilter}
                  onChange={setPartnerFilter}
                  options={partnerOptions.map((p) => p.code)}
                  placeholder="ทุกพาร์ทเนอร์"
                  formatOption={(code) => partnerOptions.find((p) => p.code === code)?.label ?? code}
                />
                {/* ทำสัญญามาแล้ว */}
                <select
                  value={contractAgeFilter}
                  onChange={(e) => setContractAgeFilter(e.target.value)}
                  className={cn(
                    "h-9 px-3 py-2 rounded-md border text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 min-w-[160px] bg-white",
                    contractAgeFilter !== "all"
                      ? "border-teal-400 bg-teal-50 text-teal-800 font-medium"
                      : "border-gray-200 text-gray-700 hover:bg-gray-50",
                  )}
                >
                  <option value="all">ทำสัญญา: ทั้งหมด</option>
                  <option value="lte3">ไม่เกิน 3 วัน</option>
                  <option value="lte7">ไม่เกิน 7 วัน</option>
                  <option value="lte15">ไม่เกิน 15 วัน</option>
                  <option value="gt15">&gt;15 วัน</option>
                </select>
                {/* ออนไลน์ล่าสุด */}
                <MultiSelectFilter
                  label="ออนไลน์ล่าสุด"
                  selected={onlineFilter}
                  onChange={setOnlineFilter}
                  options={["today", "1-3", "4-7", "8-15", "over15"]}
                  placeholder="ออนไลน์: ทั้งหมด"
                  formatOption={(v) => {
                    if (v === "today")  return "• วันนี้";
                    if (v === "1-3")    return "1–3 วันที่แล้ว";
                    if (v === "4-7")    return "4–7 วันที่แล้ว";
                    if (v === "8-15")   return "8–15 วันที่แล้ว";
                    return "> 15 วันที่แล้ว";
                  }}
                />
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
                {/* Info + Export */}
                <div className="ml-auto flex items-center gap-2">
                  <InfoPopover />
                  {canExport && (
                    <button
                      type="button"
                      onClick={handleExport}
                      className="flex items-center gap-1.5 h-9 px-3 text-sm font-medium rounded-md bg-green-600 hover:bg-green-700 text-white transition-colors whitespace-nowrap"
                    >
                      <Download className="w-4 h-4" />
                      <span className="hidden sm:inline">Export Excel</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
            {/* result count */}
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
              <Spinner className="w-6 h-6 text-teal-500" />
              <span className="ml-2 text-sm text-gray-500">กำลังโหลด...</span>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
              <Eye className="w-8 h-8 mb-2 text-teal-300" />
              <p className="text-sm">ไม่พบข้อมูลสังเกตการณ์ลูกค้าใหม่</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 border rounded-lg overflow-hidden">
              <div ref={scrollRef} className="flex-1 overflow-auto">
                <table className="w-full text-xs border-collapse">
                  <thead
                    className="bg-teal-50 text-gray-700 border-b border-teal-200"
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
                      <Th col="productType" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[80px]">
                        ประเภท
                      </Th>
                      <Th col="model" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[200px]">
                        รุ่น
                      </Th>
                      <Th col="partnerCode" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[160px]">
                        พาร์ทเนอร์
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
                      <Th col="installmentTotal" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-right">
                        ยอดผ่อนรวม
                      </Th>
                      <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[100px]">
                        ผ่อนงวดละ
                      </th>
                      <Th col="daysSinceApprove" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-center">
                        ทำสัญญามาแล้ว
                      </Th>
                      <th className="px-3 py-2 text-center text-xs font-semibold whitespace-nowrap min-w-[130px]">
                        กำหนดชำระงวดที่ 1
                      </th>
                      <Th col="daysUntilDue1" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[100px] text-center">
                        เหลืออีก
                      </Th>
                      <th className="px-3 py-2 text-center text-xs font-semibold whitespace-nowrap min-w-[90px]">
                        Online
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {paddingTop > 0 && (
                      <tr>
                        <td colSpan={19} style={{ height: paddingTop }} />
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
                            "hover:bg-teal-50 transition-colors",
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
                            {r.productType ? (
                              <span className={cn(
                                "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium",
                                r.productType === "มือ 1"
                                  ? "bg-blue-100 text-blue-700"
                                  : r.productType === "Sure+"
                                    ? "bg-purple-100 text-purple-700"
                                    : "bg-gray-100 text-gray-700",
                              )}>
                                {r.productType}
                              </span>
                            ) : "-"}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap max-w-[200px] truncate" title={r.model ?? undefined}>
                            {fmtModelDisplay(r.model)}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <div className="flex flex-col">
                              <span className="font-medium text-gray-800">{r.partnerCode ?? "-"}</span>
                              {r.partnerName && r.partnerName !== r.partnerCode && (
                                <span className="text-[10px] text-gray-500 truncate max-w-[140px]">{r.partnerName}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-700">
                            {fmtMoney(r.sellPrice)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-gray-800">
                            {fmtMoney(r.financeAmount)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-700">
                            {fmtMoney(r.commissionNet)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-700">
                            {fmtMoney(r.incentive)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-700">
                            {fmtMoney(r.cost)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-700">
                            {fmtMoney(r.installmentTotal)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-gray-800">
                            {fmtMoney(r.installmentAmount)}
                          </td>
                          {/* ทำสัญญามาแล้ว (วัน) */}
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            <span className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium",
                              r.daysSinceApprove <= 3
                                ? "bg-green-100 text-green-700"
                                : r.daysSinceApprove <= 7
                                  ? "bg-blue-100 text-blue-700"
                                  : r.daysSinceApprove <= 15
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-gray-100 text-gray-600",
                            )}>
                              {r.daysSinceApprove} วัน
                            </span>
                          </td>
                          {/* กำหนดชำระงวดที่ 1 */}
                          <td className="px-3 py-1.5 text-center whitespace-nowrap text-gray-700">
                            {fmtDate(r.dueDate1)}
                          </td>
                          {/* วันที่เหลือก่อนถึงกำหนด: สีแดง ≤7 วัน, สีเหลือง ≤14 วัน, สีเขียว >14 วัน */}
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            <span className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium",
                              r.daysUntilDue1 <= 7
                                ? "bg-red-100 text-red-700"
                                : r.daysUntilDue1 <= 14
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-green-100 text-green-700",
                            )}>
                              {r.daysUntilDue1} วัน
                            </span>
                          </td>
                          {/* Online: วันที่ออนไลน์ล่าสุด + ไอคอนโล่ (MDM) + ไอคอนกุญแจ (ล็อกเครื่อง) */}
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            {(() => {
                              const days = r.lastOnlineDays;
                              // ไอคอนกุญแจ (lossStatus): 1=ล็อก (แดง), 0=ปลดล็อก (เขียว), null=ไม่แสดง
                              const lockIcon = r.lossStatus === 1 ? (
                                <Lock className="inline-block w-3 h-3 text-red-500 ml-1 flex-shrink-0" title="Lost Mode: ล็อกเครื่อง" />
                              ) : r.lossStatus === 0 ? (
                                <Lock className="inline-block w-3 h-3 text-green-500 ml-1 flex-shrink-0" title="Lost Mode: ไม่ล็อก" />
                              ) : null;
                              // ไอคอนโล่ (deviceLock): true=MDM ควบคุม (เขียว), false=หลุด MDM (เทา), null=ไม่แสดง
                              const shieldIcon = r.deviceLock === true ? (
                                <ShieldCheck className="inline-block w-3 h-3 text-green-500 ml-0.5 flex-shrink-0" title="MDM: อยู่ภายใต้การควบคุม" />
                              ) : r.deviceLock === false ? (
                                <ShieldOff className="inline-block w-3 h-3 text-gray-400 ml-0.5 flex-shrink-0" title="MDM: หลุดจากการควบคุม" />
                              ) : null;
                              // ปุ่ม GPS MapPin
                              const hasLocationLog = r.locationLogCount > 0;
                              const mapPinBtn = r.serialNo ? (
                                hasLocationLog ? (
                                  <button
                                    type="button"
                                    title="ดูประวัติตำแหน่ง GPS"
                                    className="inline-flex items-center justify-center w-4 h-4 ml-0.5 text-green-500 hover:text-green-700 transition-colors flex-shrink-0"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openDialog({
                                        mdmDeviceId: r.mdmDeviceId,
                                        customerName: r.customerName,
                                        contractNo: r.contractNo,
                                        serialNo: r.serialNo,
                                      });
                                    }}
                                  >
                                    <MapPin className="w-3 h-3" />
                                  </button>
                                ) : (
                                  <span
                                    title="ยังไม่มีประวัติตำแหน่ง GPS"
                                    className="inline-flex items-center justify-center w-4 h-4 ml-0.5 text-gray-300 flex-shrink-0 cursor-default"
                                  >
                                    <MapPin className="w-3 h-3" />
                                  </span>
                                )
                              ) : null;
                              if (days == null) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span className="text-gray-400 text-xs">–</span>
                                  {shieldIcon}
                                  {lockIcon}
                                  {mapPinBtn}
                                </span>
                              );
                              const tooltipText = r.lastOnlineAt
                                ? `ออนไลน์ล่าสุด: ${r.lastOnlineAt}`
                                : undefined;
                              if (days === 0) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 cursor-default">• วันนี้</span>
                                  {shieldIcon}
                                  {lockIcon}
                                  {mapPinBtn}
                                </span>
                              );
                              if (days <= 3) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700 cursor-default">{days} วัน</span>
                                  {shieldIcon}
                                  {lockIcon}
                                  {mapPinBtn}
                                </span>
                              );
                              if (days <= 7) return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-100 text-orange-700 cursor-default">{days} วัน</span>
                                  {shieldIcon}
                                  {lockIcon}
                                  {mapPinBtn}
                                </span>
                              );
                              return (
                                <span className="inline-flex items-center gap-0.5">
                                  <span title={tooltipText} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 cursor-default">{days} วัน</span>
                                  {shieldIcon}
                                  {lockIcon}
                                  {mapPinBtn}
                                </span>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                    {paddingBottom > 0 && (
                      <tr>
                        <td colSpan={19} style={{ height: paddingBottom }} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* GPS Location Dialog */}
      <LocationDialog
        open={dialogState.open}
        onClose={closeDialog}
        section={section!}
        mdmDeviceId={dialogState.mdmDeviceId}
        customerName={dialogState.customerName}
        contractNo={dialogState.contractNo}
        serialNo={dialogState.serialNo}
      />
    </AppShell>
  );
}

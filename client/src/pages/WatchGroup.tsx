/**
 * WatchGroup — กลุ่มเฝ้าระวัง
 * แสดงสัญญาที่ไม่เคยชำระเลย (0 งวด) และเพิ่งเกินกำหนดชำระงวดแรก/งวดสอง
 * หลังผ่านช่วงผ่อนผัน N วัน
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

/** Format number as integer with comma */
const fmtInt = (v: number | null | undefined) =>
  v == null ? "-" : v.toLocaleString("th-TH");

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
  | "daysOverdue"
  | "arrearsCount";
type SortDir = "asc" | "desc";

type Row = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  serialNo: string | null;
  lastOnlineDays: number | null;
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
  cost: number;
  installmentCount: number | null;
  installmentAmount: number | null;
  installmentTotal: number;
  daysOverdue: number;
  arrearsCount: number;
  paidAmount1: number;  // ยอดชำระงวดที่ 1 (อาจเป็น 0 ถ้าไม่เคยชำระ)
  totalAmountDue: number; // ยอดค้างชำระรวมทุกงวดที่ถึงกำหนดแล้ว
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

/* ─── ArrearsInfoPopover ──────────────────────────────────────────────────── */
function ArrearsInfoPopover() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center w-7 h-7 rounded-full text-teal-600 hover:bg-teal-50 border border-teal-200 transition-colors"
          title="อธิบายความหมายค้างชำระ"
        >
          <Info className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4 text-sm" align="end">
        <div className="space-y-3">
          <h4 className="font-semibold text-gray-800 flex items-center gap-1.5">
            <Eye className="w-4 h-4 text-teal-600" />
            กลุ่มเฝ้าระวัง — ความหมายค้างชำระ
          </h4>
          <p className="text-xs text-gray-500 leading-relaxed">
            แสดงเฉพาะสัญญาที่ <span className="font-semibold text-gray-700">ไม่เคยชำระเลยตั้งแต่งวดแรก</span>{" "}
            และเกินช่วงผ่อนผันที่กำหนดแล้ว แบ่งเป็น 2 กลุ่ม:
          </p>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1">
            <p className="text-xs font-semibold text-amber-800">0 งวด — กลุ่มเร่งติดตามก่อนหลุด</p>
            <p className="text-xs text-amber-700 leading-relaxed">
              ถึงกำหนดชำระ <span className="font-medium">งวดที่ 1</span> แล้ว และเกินกำหนดมาแล้วมากกว่าช่วงผ่อนผัน
              แต่งวดที่ 2 ยังไม่ถึงกำหนด — ลูกค้ายังไม่ค้างชำระอย่างเป็นทางการ
              ต้องเร่งติดตามเพื่อไม่ให้กลายเป็นค้างชำระ
            </p>
          </div>
          <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-1">
            <p className="text-xs font-semibold text-red-800">1 งวด — กลุ่มเร่งลงพื้นที่ติดตามเครื่อง</p>
            <p className="text-xs text-red-700 leading-relaxed">
              ถึงกำหนดชำระ <span className="font-medium">งวดที่ 2</span> แล้ว และเกินกำหนดมาแล้วมากกว่าช่วงผ่อนผัน
              — ค้างชำระ 1 งวดแล้ว กำลังจะค้างชำระ 2 งวด
              ต้องเร่งลงพื้นที่เพื่อติดตามเครื่องคืน
            </p>
          </div>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            * ช่วงผ่อนผัน คือจำนวนวันที่ยอมให้เกินกำหนดได้โดยยังไม่นับว่าผิดนัด
            ปรับได้จากฟิลเตอร์ "ช่วงผ่อนผัน"
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function WatchGroup() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("watch_group", "view");
  const canExport = can("watch_group", "export");
  const { setActions } = useNavActions();

  /* ── filters ── */
  const [search, setSearch] = useState("");
  const [approveMonthFilter, setApproveMonthFilter] = useState<Set<string>>(new Set());
  const [osFilter, setOsFilter] = useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set());
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  const [partnerFilter, setPartnerFilter] = useState<Set<string>>(new Set());
  // ช่วงผ่อนผัน N วัน (default 15)
  const [gracePeriod, setGracePeriod] = useState<string>("15");
  // ค้างชำระ multi-select: Set ของ "0" | "1" (ว่าง = ทั้งหมด)
  const [arrearsFilter, setArrearsFilter] = useState<Set<string>>(new Set());
  // ยอดชำระ: "" = ทั้งหมด, "none" = ไม่ชำระเลย, "partial" = ชำระบางส่วน
  const [paymentFilter, setPaymentFilter] = useState<Set<string>>(new Set());
  // ออนไลน์ล่าสุด multi-select
  const [onlineFilter, setOnlineFilter] = useState<Set<string>>(new Set());

  /* ── sort ── */
  const [sortKey, setSortKey] = useState<SortKey>("daysOverdue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  /* ── virtual scroll ref ── */
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ── data ── */
  const queryInput = useMemo(() => {
    if (!section) return undefined;
    return {
      section,
      gracePeriod: gracePeriod !== "" && !isNaN(Number(gracePeriod)) ? Number(gracePeriod) : 15,
      // ส่ง arrearsFilter เป็น scalar เฉพาะเมื่อเลือกค่าเดียว (server รับ "0"|"1"|undefined)
      arrearsFilter:
        arrearsFilter.size === 1
          ? (Array.from(arrearsFilter)[0] as "0" | "1")
          : undefined,
      productTypes: productTypeFilter.size > 0 ? Array.from(productTypeFilter) : undefined,
    };
  }, [section, gracePeriod, arrearsFilter, productTypeFilter]);

  const { data, isLoading } = trpc.watchGroup.list.useQuery(
    queryInput as any,
    { enabled: canView && !!section && !!queryInput, staleTime: 5 * 60 * 1000 },
  );
  const allRows: Row[] = useMemo(() => (data?.rows ?? []) as unknown as Row[], [data?.rows]);

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

  /* ── partner options ── */
  const partnerOptions = useMemo(() => {
    const map = new Map<string, string>(); // key: partnerCode, value: display label
    for (const r of allRows) {
      if (!r.partnerCode) continue;
      const label = r.partnerCode;
      map.set(r.partnerCode, label);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "th"))
      .map(([code, label]) => ({ code, label }));
  }, [allRows]);

  /* ── productType options (Sure+ only for Boonphone) ── */
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

  /* ── filtered + sorted rows (client-side: search, month, os, model) ── */
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

    // filter พาร์ทเนอร์ (client-side multi-select)
    if (partnerFilter.size > 0) {
      rows = rows.filter((r) => r.partnerCode && partnerFilter.has(r.partnerCode));
    }

    // filter ยอดชำระ (client-side)
    if (paymentFilter.size > 0) {
      rows = rows.filter((r) => {
        const paid = r.paidAmount1 ?? 0;
        if (paymentFilter.has("none") && paid === 0) return true;
        if (paymentFilter.has("partial") && paid > 0) return true;
        return false;
      });
    }

    // filter ออนไลน์ล่าสุด (5 bucket)
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
        case "daysOverdue":      av = a.daysOverdue;            bv = b.daysOverdue;            break;
        case "arrearsCount":     av = a.arrearsCount;           bv = b.arrearsCount;           break;
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
    paymentFilter,
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
    paymentFilter.size > 0 ||
    gracePeriod !== "15" ||
    arrearsFilter.size > 0;

  const clearFilters = () => {
    setSearch("");
    setApproveMonthFilter(new Set());
    setOsFilter(new Set());
    setModelFilter(new Set());
    setProductTypeFilter(new Set());
    setPartnerFilter(new Set());
    setGracePeriod("15");
    setArrearsFilter(new Set());
    setPaymentFilter(new Set());
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
        "ประเภท","รุ่น","รหัสพาร์ทเนอร์","ชื่อพาร์ทเนอร์","ราคา","ยอดจัดไฟแนนซ์",
        "ค่าคอมมิชชั่น","Incentive","ต้นทุน","ยอดผ่อนรวม","ค่างวด","ยอดชำระ",
        "เกินกำหนด(วัน)","ค้างชำระ(งวด)","Online (วันที่แล้ว)",
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
          r.paidAmount1 ?? 0,
          r.daysOverdue ?? 0,
          r.arrearsCount ?? 0,
          onlineLabel,
        ];
      });
      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
      ws["!cols"] = [
        { wch: 6 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 14 },
        { wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 14 },
        { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
        { wch: 14 }, { wch: 14 }, { wch: 14 },
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
        for (const C of [15, 16]) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (ws[addr]) { ws[addr].t = "n"; ws[addr].z = "#,##0"; }
        }
      }
      XLSX.utils.book_append_sheet(wb, ws, "กลุ่มเฝ้าระวัง");
      XLSX.writeFile(wb, `watch_group_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
            {/* row 1: search + filters */}
            <div className="flex flex-col md:flex-row md:items-center gap-2 flex-wrap">
              {/* search — ขยาย 10% จาก 210px → 231px */}
              <div className="relative flex-1 min-w-0 max-w-[231px]">
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

                {/* ประเภท */}
                <MultiSelectFilter
                  label="ประเภท"
                  selected={productTypeFilter}
                  onChange={setProductTypeFilter}
                  options={productTypeOptions}
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

                {/* พาร์ทเนอร์ — Multi-Select with search */}
                <MultiSelectFilter
                  label="พาร์ทเนอร์"
                  selected={partnerFilter}
                  onChange={setPartnerFilter}
                  options={partnerOptions.map((p) => p.code)}
                  placeholder="ทุกพาร์ทเนอร์"
                  formatOption={(code) => partnerOptions.find((p) => p.code === code)?.label ?? code}
                />

                {/* ค้างชำระ — Multi-Select */}
                <MultiSelectFilter
                  label="ค้างชำระ"
                  selected={arrearsFilter}
                  onChange={setArrearsFilter}
                  options={["0", "1"]}
                  placeholder="ค้างชำระ: ทั้งหมด"
                  formatOption={(v) => `${v} งวด`}
                />

                {/* ยอดชำระ — Multi-Select */}
                <MultiSelectFilter
                  label="ยอดชำระ"
                  selected={paymentFilter}
                  onChange={setPaymentFilter}
                  options={["none", "partial"]}
                  placeholder="ยอดชำระ: ทั้งหมด"
                  formatOption={(v) => v === "none" ? "ไม่ชำระเลย" : "ชำระบางส่วน"}
                />

                {/* ออนไลน์ล่าสุด — Multi-Select (5 ตัวเลือก) */}
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

                {/* ช่วงผ่อนผัน N วัน — หลังสุด */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500 whitespace-nowrap">ช่วงผ่อนผัน</span>
                  <Input
                    type="number"
                    min={0}
                    max={365}
                    value={gracePeriod}
                    onChange={(e) => setGracePeriod(e.target.value)}
                    className="h-9 text-xs w-16 text-center"
                  />
                  <span className="text-xs text-gray-500">วัน</span>
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

                {/* Info popover + Export Excel */}
                <div className="ml-auto flex items-center gap-2">
                  <ArrearsInfoPopover />
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
              <Spinner className="w-6 h-6 text-teal-500" />
              <span className="ml-2 text-sm text-gray-500">กำลังโหลด...</span>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
              <Eye className="w-8 h-8 mb-2 text-teal-300" />
              <p className="text-sm">ไม่พบข้อมูลกลุ่มเฝ้าระวัง</p>
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
                        ค่างวด
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[100px]">
                        ยอดชำระ
                      </th>
                      <Th col="daysOverdue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-right">
                        เกินกำหนด(วัน)
                      </Th>
                      <Th col="arrearsCount" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="min-w-[110px] text-center">
                        ค้างชำระ(งวด)
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
                      const isHighRisk = r.arrearsCount >= 1;
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
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {fmtModelDisplay(r.model)}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">
                            {r.partnerCode ?? "-"}
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
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-green-700">
                            {fmtMoney(r.installmentTotal)}
                          </td>
                          {/* ค่างวด = ยอดค้างชำระรวมทุกงวดที่ถึงกำหนดแล้ว */}
                          <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-gray-800">
                            {fmtMoney(r.totalAmountDue)}
                          </td>
                          {/* ยอดชำระ = ยอดที่ชำระมาแล้วในงวดที่ 1 */}
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            <span className={cn(
                              "font-medium",
                              r.paidAmount1 > 0 ? "text-blue-700" : "text-red-600",
                            )}>
                              {fmtMoney(r.paidAmount1)}
                            </span>
                            {r.totalAmountDue > 0 && (
                              <span className={cn(
                                "ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full",
                                r.paidAmount1 > 0
                                  ? "bg-blue-50 text-blue-600"
                                  : "bg-red-50 text-red-500",
                              )}>
                                {Math.round((r.paidAmount1 / r.totalAmountDue) * 100)}%
                              </span>
                            )}
                          </td>
                          <td className={cn(
                            "px-3 py-1.5 text-right whitespace-nowrap font-semibold",
                            r.daysOverdue > 30 ? "text-red-600" : "text-amber-600",
                          )}>
                            {fmtInt(r.daysOverdue)}
                          </td>
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            <span className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium",
                              isHighRisk
                                ? "bg-red-100 text-red-700"
                                : "bg-amber-100 text-amber-700",
                            )}>
                              {r.arrearsCount} งวด
                            </span>
                          </td>
                          {/* Online column: วันที่ออนไลน์ล่าสุดจาก MDM */}
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            {(() => {
                              const days = r.lastOnlineDays;
                              if (days == null) return <span className="text-gray-400 text-xs">–</span>;
                              if (days === 0) return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700">• วันนี้</span>
                              );
                              if (days <= 3) return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700">{days} วัน</span>
                              );
                              if (days <= 7) return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-100 text-orange-700">{days} วัน</span>
                              );
                              return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700">{days} วัน</span>
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
    </AppShell>
  );
}

/**
 * SuspectedBadDebt — Phase 105
 * หน้าหนี้สงสัยจะเสีย: แสดงสัญญาที่มีสถานะหนี้ "เกิน 61-90" หรือ "เกิน >90"
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Download,
  Filter as FilterIcon,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  if (m.startsWith("iphone") || m.startsWith("ipad") || m.startsWith("ไอโฟน") || m.startsWith("ไอแพด"))
    return "iOS";
  return "Android";
};

/** Parse model name: extract base model + capacity */
const parseModelParts = (model: string | null) => {
  if (!model) return { base: null, capacity: null };
  // Try to extract capacity pattern like "128 Gb", "256GB", "64 GB"
  const capMatch = model.match(/(\d+)\s*[Gg][Bb]/);
  const capacity = capMatch ? `${capMatch[1]} GB` : null;
  // Base = everything before capacity pattern or full model
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
  | "multiplier"
  | "commissionNet"
  | "cost"
  | "paidInstallments"
  | "totalPaid"
  | "debtValue";
type SortDir = "asc" | "desc";

type Row = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  model: string | null;
  device: string | null;
  sellPrice: number | null;
  financeAmount: number | null;
  multiplier: number | null;
  commissionNet: number | null;
  cost: number;
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
    <div
      className={`rounded-lg border p-3 flex items-center gap-3 bg-white ${colorClass}`}
    >
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

/* ─── Pagination ─────────────────────────────────────────────────────────── */
function Pagination({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pages = useMemo(() => {
    const arr: (number | "...")[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) arr.push(i);
    } else {
      arr.push(1);
      if (page > 3) arr.push("...");
      for (
        let i = Math.max(2, page - 1);
        i <= Math.min(totalPages - 1, page + 1);
        i++
      )
        arr.push(i);
      if (page < totalPages - 2) arr.push("...");
      arr.push(totalPages);
    }
    return arr;
  }, [page, totalPages]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t bg-white text-xs text-gray-600">
      <div className="flex items-center gap-2">
        <span>แสดง</span>
        <select
          value={pageSize}
          onChange={(e) => {
            onPageSize(Number(e.target.value));
            onPage(1);
          }}
          className="border rounded px-1.5 py-0.5 text-xs"
        >
          {[50, 100, 500, 1000].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span>
          รายการ / {total.toLocaleString()} รายการทั้งหมด
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
          className="px-2 py-1 rounded border disabled:opacity-40 hover:bg-gray-100"
        >
          ‹
        </button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`ellipsis-${i}`} className="px-1">
              ...
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p as number)}
              className={cn(
                "px-2 py-1 rounded border",
                page === p
                  ? "bg-blue-600 text-white border-blue-600"
                  : "hover:bg-gray-100",
              )}
            >
              {p}
            </button>
          ),
        )}
        <button
          disabled={page === totalPages}
          onClick={() => onPage(page + 1)}
          className="px-2 py-1 rounded border disabled:opacity-40 hover:bg-gray-100"
        >
          ›
        </button>
      </div>
    </div>
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
  const [approveMonth, setApproveMonth] = useState("__all__");
  const [debtStatusFilter, setDebtStatusFilter] = useState("__all__");
  const [osFilter, setOsFilter] = useState("__all__"); // "iOS" | "Android" | "__all__"
  const [modelFilter, setModelFilter] = useState<string[]>([]);
  const [debtValueMin, setDebtValueMin] = useState("");
  const [filterOpen, setFilterOpen] = useState(true);
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);

  /* ── sort ── */
  const [sortKey, setSortKey] = useState<SortKey>("debtValue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  /* ── pagination ── */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  /* ── data ── */
  const { data, isLoading } = trpc.suspectedBadDebt.list.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section, staleTime: 5 * 60 * 1000 },
  );
  const allRows: Row[] = (data?.rows ?? []) as Row[];

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

  /* ── model options (sorted: base model + capacity) ── */
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) {
      if (r.model) set.add(r.model);
    }
    return Array.from(set).sort((a, b) => {
      const pa = parseModelParts(a);
      const pb = parseModelParts(b);
      const baseCompare = (pa.base ?? "").localeCompare(pb.base ?? "", "th");
      if (baseCompare !== 0) return baseCompare;
      const capA = parseInt(pa.capacity ?? "0");
      const capB = parseInt(pb.capacity ?? "0");
      return capA - capB;
    });
  }, [allRows]);

  /* ── filtered + sorted rows ── */
  const filteredRows = useMemo(() => {
    let rows = allRows;

    // search: contractNo | customerName | phone
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.contractNo?.toLowerCase().includes(q) ||
          r.customerName?.toLowerCase().includes(q) ||
          r.phone?.toLowerCase().includes(q),
      );
    }

    // approveMonth filter
    if (approveMonth && approveMonth !== "__all__") {
      rows = rows.filter((r) => r.approveDate?.startsWith(approveMonth));
    }

    // debtStatus filter
    if (debtStatusFilter && debtStatusFilter !== "__all__") {
      rows = rows.filter((r) => r.debtStatus === debtStatusFilter);
    }

    // iOS/Android filter
    if (osFilter && osFilter !== "__all__") {
      rows = rows.filter((r) => deriveOS(r.model) === osFilter);
    }

    // model multi-select filter
    if (modelFilter.length > 0) {
      const modelSet = new Set(modelFilter);
      rows = rows.filter((r) => r.model && modelSet.has(r.model));
    }

    // debtValue min filter
    if (debtValueMin !== "" && !isNaN(Number(debtValueMin))) {
      const minVal = Number(debtValueMin);
      rows = rows.filter((r) => r.debtValue > minVal);
    }

    // sort
    rows = [...rows].sort((a, b) => {
      let av: any, bv: any;
      switch (sortKey) {
        case "approveDate":
          av = a.approveDate ?? "";
          bv = b.approveDate ?? "";
          break;
        case "contractNo":
          av = a.contractNo ?? "";
          bv = b.contractNo ?? "";
          break;
        case "customerName":
          av = a.customerName ?? "";
          bv = b.customerName ?? "";
          break;
        case "phone":
          av = a.phone ?? "";
          bv = b.phone ?? "";
          break;
        case "model":
          av = a.model ?? "";
          bv = b.model ?? "";
          break;
        case "sellPrice":
          av = a.sellPrice ?? 0;
          bv = b.sellPrice ?? 0;
          break;
        case "financeAmount":
          av = a.financeAmount ?? 0;
          bv = b.financeAmount ?? 0;
          break;
        case "multiplier":
          av = a.multiplier ?? 0;
          bv = b.multiplier ?? 0;
          break;
        case "commissionNet":
          av = a.commissionNet ?? 0;
          bv = b.commissionNet ?? 0;
          break;
        case "cost":
          av = a.cost;
          bv = b.cost;
          break;
        case "paidInstallments":
          av = a.paidInstallments;
          bv = b.paidInstallments;
          break;
        case "totalPaid":
          av = a.totalPaid;
          bv = b.totalPaid;
          break;
        case "debtValue":
          av = a.debtValue;
          bv = b.debtValue;
          break;
        default:
          av = 0;
          bv = 0;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
  }, [
    allRows,
    search,
    approveMonth,
    debtStatusFilter,
    osFilter,
    modelFilter,
    debtValueMin,
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

  /* ── paginated rows ── */
  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  /* ── reset page on filter change ── */
  useEffect(() => {
    setPage(1);
  }, [search, approveMonth, debtStatusFilter, osFilter, modelFilter, debtValueMin]);

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

  /* ── export ── */
  const handleExport = useCallback(async () => {
    if (!canExport) {
      toast.error("ไม่มีสิทธิ์ Export");
      return;
    }
    try {
      const { utils } = await import("xlsx");
      const XLSX = await import("xlsx");
      const wsData = [
        [
          "#",
          "วันที่อนุมัติ",
          "เลขที่สัญญา",
          "ชื่อ-นามสกุล",
          "เบอร์โทร",
          "รุ่น",
          "ราคา",
          "ยอดจัดไฟแนนซ์",
          "ตัวคูณ",
          "ค่าคอมมิชชั่น",
          "ต้นทุน",
          "งวดที่ชำระ",
          "ยอดเก็บค่างวด",
          "มูลค่าหนี้",
          "สถานะหนี้",
        ],
        ...filteredRows.map((r, i) => [
          i + 1,
          r.approveDate ? fmtDate(r.approveDate) : "",
          r.contractNo ?? "",
          r.customerName ?? "",
          r.phone ?? "",
          r.model ?? "",
          r.sellPrice ?? 0,
          r.financeAmount ?? 0,
          r.multiplier ?? 0,
          r.commissionNet ?? 0,
          r.cost,
          r.paidInstallments,
          r.totalPaid,
          r.debtValue,
          r.debtStatus,
        ]),
      ];
      const ws = utils.aoa_to_sheet(wsData);
      const wb = utils.book_new();
      utils.book_append_sheet(wb, ws, "หนี้สงสัยจะเสีย");
      XLSX.writeFile(wb, `suspected-bad-debt-${section}-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ");
    } catch {
      toast.error("Export ล้มเหลว");
    }
  }, [filteredRows, canExport, section]);

  /* ── inject export button into nav ── */
  useEffect(() => {
    setActions(null); // clear topnav actions (export is inline now)
    return () => setActions(null);
  }, [setActions]);

  /* ── column header helper ── */
  const Th = ({
    col,
    children,
    className,
  }: {
    col: SortKey;
    children: React.ReactNode;
    className?: string;
  }) => (
    <th
      onClick={() => handleSort(col)}
      className={cn(
        "px-3 py-2 text-left text-xs font-semibold whitespace-nowrap cursor-pointer select-none hover:bg-blue-100 transition-colors",
        className,
      )}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
      </span>
    </th>
  );

  /* ── topnav sticky offset ── */
  const topNavRef = useRef<HTMLDivElement>(null);
  const [topNavHeight, setTopNavHeight] = useState(56);
  useEffect(() => {
    const el = document.querySelector("[data-topnav]") as HTMLElement | null;
    if (el) setTopNavHeight(el.offsetHeight);
  }, []);

  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64 text-gray-500">
          ไม่มีสิทธิ์เข้าถึงหน้านี้
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-col h-full">
        {/* ── page header ── */}
        <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <h1 className="text-base font-bold text-gray-800">
              หนี้สงสัยจะเสีย
            </h1>
            {!isLoading && (
              <span className="text-xs text-gray-500">
                ({filteredRows.length.toLocaleString()} รายการ)
              </span>
            )}
          </div>
          {/* Export button — inline with menu bar */}
          {canExport && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleExport}
              className="flex items-center gap-1.5 text-xs h-8"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </Button>
          )}
        </div>

        {/* ── summary cards ── */}
        <div className="px-4 pb-2 grid grid-cols-2 md:grid-cols-4 gap-2">
          <SummaryCard
            icon={<span className="text-blue-500 font-bold text-lg">#</span>}
            label="จำนวน"
            value={summary.count.toLocaleString() + " รายการ"}
            colorClass="border-blue-100"
          />
          <SummaryCard
            icon={<span className="text-purple-500 font-bold text-sm">฿</span>}
            label="ต้นทุน"
            value={fmtMoney(summary.cost)}
            colorClass="border-purple-100"
          />
          <SummaryCard
            icon={<span className="text-green-500 font-bold text-sm">฿</span>}
            label="ยอดเก็บค่างวด"
            value={fmtMoney(summary.totalPaid)}
            colorClass="border-green-100"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-4 h-4 text-red-500" />}
            label="มูลค่าหนี้"
            value={fmtMoney(summary.debtValue)}
            colorClass="border-red-100"
          />
        </div>

        {/* ── filter bar ── */}
        <div className="px-4 pb-2">
          <button
            onClick={() => setFilterOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 mb-1.5"
          >
            <FilterIcon className="w-3.5 h-3.5" />
            ตัวกรอง
            {filterOpen ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>

          {filterOpen && (
            <div className="bg-gray-50 border rounded-lg p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2">
              {/* search */}
              <div className="relative xl:col-span-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="เลขที่สัญญา / ชื่อ / เบอร์โทร"
                  className="pl-8 h-8 text-xs"
                />
              </div>

              {/* approve month */}
              <Select value={approveMonth} onValueChange={setApproveMonth}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="เดือน-ปีที่อนุมัติ" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">ทั้งหมด</SelectItem>
                  {approveMonthOptions.map((ym) => (
                    <SelectItem key={ym} value={ym}>
                      {fmtMonthLabel(ym)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* debt status */}
              <Select value={debtStatusFilter} onValueChange={setDebtStatusFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="สถานะหนี้" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">ทั้งหมด</SelectItem>
                  <SelectItem value="เกิน 61-90">เกิน 61-90 วัน</SelectItem>
                  <SelectItem value="เกิน >90">เกิน {">"} 90 วัน</SelectItem>
                </SelectContent>
              </Select>

              {/* iOS/Android */}
              <Select value={osFilter} onValueChange={setOsFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="iOS / Android" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">ทั้งหมด</SelectItem>
                  <SelectItem value="iOS">iOS</SelectItem>
                  <SelectItem value="Android">Android</SelectItem>
                </SelectContent>
              </Select>

              {/* model multi-select */}
              <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    className={cn(
                      "flex items-center justify-between h-8 px-3 text-xs rounded-md border bg-white hover:bg-gray-50 transition-colors",
                      modelFilter.length > 0
                        ? "border-blue-400 text-blue-700"
                        : "border-input text-gray-500",
                    )}
                  >
                    <span className="truncate">
                      {modelFilter.length === 0
                        ? "รุ่น (ทั้งหมด)"
                        : `รุ่น (${modelFilter.length})`}
                    </span>
                    <ChevronsUpDown className="w-3 h-3 ml-1 shrink-0 text-gray-400" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="ค้นหารุ่น..." className="h-8 text-xs" />
                    <CommandList className="max-h-52">
                      <CommandEmpty>ไม่พบรุ่น</CommandEmpty>
                      <CommandGroup>
                        {modelOptions.map((m) => (
                          <CommandItem
                            key={m}
                            value={m}
                            onSelect={() => {
                              setModelFilter((prev) =>
                                prev.includes(m)
                                  ? prev.filter((x) => x !== m)
                                  : [...prev, m],
                              );
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-3.5 w-3.5",
                                modelFilter.includes(m)
                                  ? "opacity-100 text-blue-600"
                                  : "opacity-0",
                              )}
                            />
                            <span className="text-xs truncate">
                              {fmtModelDisplay(m)}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                  {modelFilter.length > 0 && (
                    <div className="border-t p-1.5">
                      <button
                        onClick={() => setModelFilter([])}
                        className="w-full text-xs text-red-500 hover:text-red-700 flex items-center justify-center gap-1 py-1"
                      >
                        <X className="w-3 h-3" />
                        ล้างการเลือก
                      </button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>

              {/* debt value min */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  มูลค่าหนี้ &gt;
                </span>
                <Input
                  type="number"
                  value={debtValueMin}
                  onChange={(e) => setDebtValueMin(e.target.value)}
                  placeholder="0"
                  className="h-8 text-xs"
                />
              </div>

              {/* clear filters */}
              {(search ||
                approveMonth ||
                debtStatusFilter ||
                osFilter ||
                modelFilter.length > 0 ||
                debtValueMin) && (
                <button
                  onClick={() => {
                    setSearch("");
                    setApproveMonth("");
                    setDebtStatusFilter("");
                    setOsFilter("");
                    setModelFilter([]);
                    setDebtValueMin("");
                  }}
                  className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 h-8"
                >
                  <X className="w-3.5 h-3.5" />
                  ล้างตัวกรอง
                </button>
              )}
            </div>
          )}
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
              {/* scrollable table */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs border-collapse">
                  <thead
                    className="bg-amber-50 text-gray-700 border-b border-amber-200"
                    style={{ position: "sticky", top: 0, zIndex: 10 }}
                  >
                    <tr>
                      <Th col="seq" className="w-10 text-center">
                        #
                      </Th>
                      <Th col="approveDate" className="min-w-[110px]">
                        วันที่อนุมัติ
                      </Th>
                      <Th col="contractNo" className="min-w-[170px]">
                        เลขที่สัญญา
                      </Th>
                      <Th col="customerName" className="min-w-[160px]">
                        ชื่อ-นามสกุล
                      </Th>
                      <Th col="phone" className="min-w-[110px]">
                        เบอร์โทร
                      </Th>
                      <Th col="model" className="min-w-[200px]">
                        รุ่น
                      </Th>
                      <Th col="sellPrice" className="min-w-[90px] text-right">
                        ราคา
                      </Th>
                      <Th
                        col="financeAmount"
                        className="min-w-[110px] text-right"
                      >
                        ยอดจัดไฟแนนซ์
                      </Th>
                      <Th col="multiplier" className="min-w-[80px] text-right">
                        ตัวคูณ
                      </Th>
                      <Th
                        col="commissionNet"
                        className="min-w-[110px] text-right"
                      >
                        ค่าคอมมิชชั่น
                      </Th>
                      <Th col="cost" className="min-w-[100px] text-right">
                        ต้นทุน
                      </Th>
                      <Th
                        col="paidInstallments"
                        className="min-w-[80px] text-center"
                      >
                        งวดที่ชำระ
                      </Th>
                      <Th col="totalPaid" className="min-w-[110px] text-right">
                        ยอดเก็บค่างวด
                      </Th>
                      <Th col="debtValue" className="min-w-[100px] text-right">
                        มูลค่าหนี้
                      </Th>
                      <th className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap min-w-[110px]">
                        สถานะหนี้
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((r, i) => {
                      const seq = (page - 1) * pageSize + i + 1;
                      const isOdd = i % 2 === 0;
                      return (
                        <tr
                          key={r.contractExternalId}
                          className={cn(
                            "hover:bg-amber-50 transition-colors",
                            isOdd ? "bg-white" : "bg-gray-50/50",
                          )}
                        >
                          <td className="px-3 py-1.5 text-center text-gray-400">
                            {seq}
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
                            {r.multiplier != null
                              ? r.multiplier.toFixed(2)
                              : "-"}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {fmtMoney(r.commissionNet)}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap font-semibold">
                            {fmtMoney(r.cost)}
                          </td>
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            {r.paidInstallments}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-green-700">
                            {fmtMoney(r.totalPaid)}
                          </td>
                          <td
                            className={cn(
                              "px-3 py-1.5 text-right whitespace-nowrap font-semibold",
                              r.debtValue > 0
                                ? "text-red-600"
                                : "text-gray-500",
                            )}
                          >
                            {fmtMoney(r.debtValue)}
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* pagination */}
              <Pagination
                total={filteredRows.length}
                page={page}
                pageSize={pageSize}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

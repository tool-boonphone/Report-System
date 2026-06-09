import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
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
import { CONTRACT_COLUMNS, type ContractColumnKey } from "@shared/const";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Download,
  Filter as FilterIcon,
  Lock,
  MapPin,
  Search,
  ShieldCheck,
  ShieldOff,
  X,
} from "lucide-react";
import { LocationDialog, useLocationDialog } from "@/components/LocationDialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

// ─── Filter state ─────────────────────────────────────────────────────────────
// categorical filters now hold Set<string> for multi-select
type Filters = {
  search: string;
  // categorical (multi-select)
  status: Set<string>;
  debtStatus: Set<string>; // เปลี่ยนจาก debtType → debtStatus
  partnerCode: Set<string>;
  partnerProvince: Set<string>;
  partnerStatus: Set<string>;
  channel: Set<string>;
  nationality: Set<string>;
  gender: Set<string>;
  occupation: Set<string>;
  idProvince: Set<string>;
  addrProvince: Set<string>;
  workProvince: Set<string>;
  promotionName: Set<string>;
  device: Set<string>;
  productType: Set<string>;
  model: Set<string>;
  deviceStatus: Set<string>;
  // online status filter
  onlineFilter: Set<string>; // "today" | "1-3" | "4-7" | "over7"
  // date range
  dateField: "submitDate" | "approveDate";
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: Filters = {
  search: "",
  status: new Set(),
  debtStatus: new Set(),
  partnerCode: new Set(),
  partnerProvince: new Set(),
  partnerStatus: new Set(),
  channel: new Set(),
  nationality: new Set(),
  gender: new Set(),
  occupation: new Set(),
  idProvince: new Set(),
  addrProvince: new Set(),
  workProvince: new Set(),
  promotionName: new Set(),
  device: new Set(),
  productType: new Set(),
  model: new Set(),
  deviceStatus: new Set(),
  onlineFilter: new Set(),
  dateField: "approveDate",
  dateFrom: "",
  dateTo: "",
};

/**
 * derive debtStatus label จาก row เหมือน debtDb.ts bucketFromDays
 * - terminal statuses (ระงับสัญญา/สิ้นสุดสัญญา/หนี้เสีย/ยกเลิกสัญญา) → ใช้ debtType โดยตรง
 * - อื่นๆ → derive จาก overdueDays ที่คำนวณจาก SQL
 */
function bucketFromRow(row: any): string {
  const dt: string = row.debtType ?? row.debtStatus ?? "";
  const TERMINAL = ["ระงับสัญญา", "สิ้นสุดสัญญา", "หนี้เสีย", "ยกเลิกสัญญา"];
  if (TERMINAL.includes(dt)) return dt;
  const days = row.overdueDays;
  if (days == null) return "ปกติ";
  const n = Number(days);
  if (n <= 0)  return "ปกติ";
  if (n <= 7)  return "เกิน 1-7";
  if (n <= 14) return "เกิน 8-14";
  if (n <= 30) return "เกิน 15-30";
  if (n <= 60) return "เกิน 31-60";
  if (n <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

// Static list สำหรับ device filter
const DEVICE_OPTIONS = ["iPhone", "iPad", "Android"] as const;

/** Classify device จาก model field (ขึ้นต้น iPhone = iPhone, iPad = iPad, อื่นๆ = Android) */
function classifyDevice(model: string | null): "iPhone" | "iPad" | "Android" | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith("iphone")) return "iPhone";
  if (m.startsWith("ipad"))   return "iPad";
  return "Android";
}

// Static list สำหรับ debtStatus filter (เหมือนเมนูสรุปรายเดือน)
const DEBT_STATUS_OPTIONS = [
  "ปกติ", "เกิน 1-7", "เกิน 8-14", "เกิน 15-30",
  "เกิน 31-60", "เกิน 61-90", "เกิน >90",
  "ระงับสัญญา", "สิ้นสุดสัญญา", "หนี้เสีย", "ยกเลิกสัญญา",
] as const;

// Columns ที่ซ่อนใน UI table (แต่ยังคง export ได้)
const UI_HIDDEN_COLS = new Set<string>(["mdmEnabled", "deviceLock", "itAlert"]);

// Categorical filter keys
const CAT_KEYS: Array<keyof Omit<Filters, "search" | "dateField" | "dateFrom" | "dateTo">> = [
  "status",
  "debtStatus",
  "partnerCode",
  "partnerProvince",
  "partnerStatus",
  "channel",
  "nationality",
  "gender",
  "occupation",
  "idProvince",
  "addrProvince",
  "workProvince",
  "promotionName",
  "device",
  "productType",
  "model",
  "deviceStatus",
];

// Label mapping for categorical filters
const CAT_LABELS: Record<string, string> = {
  status: "สถานะสัญญา",
  debtStatus: "สถานะหนี้",
  partnerCode: "รหัสพาร์ทเนอร์",
  partnerProvince: "จังหวัดพาร์ทเนอร์",
  partnerStatus: "สถานะพาร์ทเนอร์",
  channel: "ช่องทาง",
  nationality: "สัญชาติ",
  gender: "เพศ",
  occupation: "ตำแหน่งงาน",
  idProvince: "จังหวัด (ตามบัตร ปชช.)",
  addrProvince: "จังหวัด (ที่อยู่ปัจจุบัน)",
  workProvince: "จังหวัด (ที่ทำงาน)",
  promotionName: "Promotion ID",
  device: "Device",
  productType: "ประเภทสินค้า",
  model: "รุ่น",
  deviceStatus: "สถานะอุปกรณ์",
};

type SortField =
  | "contractNo"
  | "submitDate"
  | "approveDate"
  | "status"
  | "customerName"
  | "partnerCode";

const SORTABLE_FIELDS: ReadonlyArray<SortField> = [
  "contractNo",
  "submitDate",
  "approveDate",
  "status",
  "customerName",
  "partnerCode",
];

/** Format a cell value according to its column type. */
function formatCell(key: ContractColumnKey, row: any, seq: number): string {
  if (key === "seq") return String(seq);
  // mdmEnabled: แสดงสถานะ MDM (Y=อยู่ใน MDM, N=ไม่อยู่)
  if (key === "mdmEnabled") {
    return row.deviceLock !== null && row.deviceLock !== undefined ? "Y" : "N";
  }
  // deviceLock: แสดงสถานะล็อกเครื่อง (Y=ล็อก, N=ปลดล็อก)
  if (key === "deviceLock") {
    if (row.deviceLock === true) return "Y";
    if (row.deviceLock === false) return "N";
    return "-";
  }
  // debtStatus: derive จาก overdueDays + debtType (เหมือน debtDb.ts bucketFromDays)
  if (key === "debtStatus") {
    return bucketFromRow(row);
  }
  // overdueDays: วันเกินกำหนด
  if (key === "overdueDays") {
    const d = row.overdueDays;
    if (d == null) return "-";
    return Number(d).toLocaleString("th-TH");
  }
  // itAlert: Y ถ้า lastOnlineDays > 4 หรือ MDM = N
  if (key === "itAlert") {
    const sn = row.serialNo;
    const onlineDays = row.lastOnlineDays;
    const dl = row.deviceLock;
    const mdmN = dl === null || dl === undefined;
    const onlineOver4 = sn && onlineDays != null && Number(onlineDays) > 4;
    return (onlineOver4 || mdmN) ? "Y" : "N";
  }
  const v = row[key];
  if (v === null || v === undefined || v === "") return "-";
  const col = CONTRACT_COLUMNS.find((c) => c.key === key);
  if (col?.type === "money") {
    const n = typeof v === "string" ? Number(v) : (v as number);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("th-TH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (col?.type === "number") {
    const n = typeof v === "string" ? Number(v) : (v as number);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("th-TH");
  }
  return String(v);
}

/** Case-insensitive substring match that also handles null/undefined cells. */
function includes(haystack: unknown, needle: string) {
  if (haystack == null) return false;
  return String(haystack).toLowerCase().includes(needle);
}

// ─── Multi-select ComboboxFilter ─────────────────────────────────────────────
function MultiComboboxFilter({
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
    const n = new Set(selected);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    onChange(n);
  };
  const labelText =
    selected.size === 0
      ? placeholder
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} รายการ`;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="text-xs font-medium text-gray-500 truncate">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`w-full px-2.5 py-1.5 text-sm border rounded-lg text-left flex items-center justify-between gap-1 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
              selected.size > 0
                ? "border-indigo-400 bg-indigo-50 text-indigo-800 font-medium"
                : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
            }`}
          >
            <span className="truncate">{labelText}</span>
            <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-0" align="start">
          <Command>
            <CommandInput
              placeholder={`ค้นหา ${label}...`}
              className="h-8 text-sm"
            />
            <CommandList>
              <CommandEmpty>ไม่พบตัวเลือก</CommandEmpty>
              <CommandGroup>
                {/* Clear all */}
                <CommandItem
                  value="__all__"
                  onSelect={() => {
                    onChange(new Set());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`mr-2 h-3.5 w-3.5 ${selected.size === 0 ? "opacity-100 text-indigo-600" : "opacity-0"}`}
                  />
                  <span
                    className={
                      selected.size === 0
                        ? "text-indigo-600 font-medium"
                        : "text-gray-500"
                    }
                  >
                    {placeholder}
                  </span>
                </CommandItem>
                {options.map((opt, i) => (
                  <CommandItem
                    key={`${i}-${opt}`}
                    value={`__opt_${i}__${opt}`}
                    onSelect={() => {
                      // use opt directly from closure — avoids lowercase normalization issues
                      toggle(opt);
                    }}
                  >
                    <Check
                      className={`mr-2 h-3.5 w-3.5 ${selected.has(opt) ? "opacity-100 text-indigo-600" : "opacity-0"}`}
                    />
                    {opt}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function Contracts() {
  const { section } = useSection();
  const { setActions } = useNavActions();
  const { can } = useAppAuth();
  const canExport = can("contract", "export");

  // ----- State -----
  const [sortField, setSortField] = useState<SortField>("approveDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);

  // ----- GPS Location Dialog -----
  const { dialogState, openDialog, closeDialog } = useLocationDialog();

  // Reset filters when section changes
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
  }, [section]);

  // ----- One-shot fetch of all rows for the section -----
  const listQuery = trpc.contracts.listAll.useQuery(
    { section: section! },
    {
      staleTime: Infinity,
      gcTime: 10 * 60 * 1000,
      enabled: Boolean(section),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );

  const allRows = listQuery.data ?? [];

  // ─── Cascading dynamic options ────────────────────────────────────────────
  const dynamicOptions = useMemo(() => {
    const rowPassesExcept = (r: any, excludeKey: string) => {
      // search
      const q = filters.search.trim().toLowerCase();
      if (q) {
        if (
          !(
            includes(r.contractNo, q) ||
            includes(r.customerName, q) ||
            includes(r.partnerCode, q) ||
            includes(r.phone, q) ||
            includes(r.imei, q) ||
            includes(r.serialNo, q) ||
            includes(r.citizenId, q)
          )
        )
          return false;
      }
      // categorical multi-select filters
      for (const key of CAT_KEYS) {
        if (key === excludeKey) continue;
        const fv = filters[key as keyof Filters] as Set<string>;
        // debtStatus filter: derive จาก overdueDays + debtType (เหมือน debtDb.ts)
        const rowVal = key === "debtStatus" ? bucketFromRow(r) :
                        key === "device"     ? classifyDevice(r.model) :
                        r[key];
        if (fv.size > 0 && !fv.has(rowVal)) return false;
      }
      // date range
      const dateFrom = filters.dateFrom || "";
      const dateTo = filters.dateTo || "";
      if (dateFrom || dateTo) {
        const dateVal =
          filters.dateField === "approveDate" ? r.approveDate : r.submitDate;
        const d = dateVal ? String(dateVal).slice(0, 10) : "";
        if (dateFrom && (!d || d < dateFrom)) return false;
        if (dateTo && (!d || d > dateTo)) return false;
      }
      return true;
    };

    const result: Record<string, string[]> = {};
    for (const key of CAT_KEYS) {
      const subset = allRows.filter((r: any) => rowPassesExcept(r, key));
      // debtStatus: ดึงจาก field debtStatus หรือ debtType
      const getVal = (r: any) =>
        key === "debtStatus" ? bucketFromRow(r) :
        key === "device"     ? (classifyDevice(r.model) ?? "") :
        String(r[key]);
      result[key] = Array.from(new Set(subset.map(getVal)))
        .filter((v) => v && v !== "null" && v !== "undefined")
        .sort();
    }
    return result;
  }, [allRows, filters]);

  // ----- Client-side filtering + sorting -----
  const filteredRows = useMemo(() => {
    const f = filters;
    const q = f.search.trim().toLowerCase();
    const dateFrom = f.dateFrom || "";
    const dateTo = f.dateTo || "";

    let rows = allRows.filter((r: any) => {
      // categorical multi-select
      for (const key of CAT_KEYS) {
        const fv = f[key as keyof Filters] as Set<string>;
        // debtStatus filter ใช้ field debtStatus (หรือ debtType) ใน row
        const rowVal = key === "debtStatus" ? bucketFromRow(r) :
                        key === "device"     ? classifyDevice(r.model) :
                        r[key];
        if (fv.size > 0 && !fv.has(rowVal)) return false;
      }
      // date range
      if (dateFrom || dateTo) {
        const dateVal =
          f.dateField === "approveDate" ? r.approveDate : r.submitDate;
        const d = dateVal ? String(dateVal).slice(0, 10) : "";
        if (dateFrom && (!d || d < dateFrom)) return false;
        if (dateTo && (!d || d > dateTo)) return false;
      }
      // full-text search
      if (q) {
        if (
          !(
            includes(r.contractNo, q) ||
            includes(r.customerName, q) ||
            includes(r.partnerCode, q) ||
            includes(r.phone, q) ||
            includes(r.imei, q) ||
            includes(r.serialNo, q) ||
            includes(r.citizenId, q)
          )
        ) {
          return false;
        }
      }
      // online status filter
      if (f.onlineFilter.size > 0) {
        const sn = r.serialNo;
        const days: number | null | undefined = r.lastOnlineDays;
        // ถ้าไม่มี serialNo หรือ days เป็น null = ไม่รู้สถานะ → ไม่ผ่านฟิลเตอร์ใดๆ
        if (!sn || days == null) return false;
        let bucket: string;
        if (days === 0) bucket = "today";
        else if (days <= 3) bucket = "1-3";
        else if (days <= 7) bucket = "4-7";
        else bucket = "over7";
        if (!f.onlineFilter.has(bucket)) return false;
      }
      return true;
    });

    rows = [...rows].sort((a: any, b: any) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (av == null && bv == null) return 0;
      if (av == null) return sortDir === "asc" ? -1 : 1;
      if (bv == null) return sortDir === "asc" ? 1 : -1;
      const an = typeof av === "number" ? av : Number(av);
      const bn = typeof bv === "number" ? bv : Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
        return sortDir === "asc" ? an - bn : bn - an;
      }
      const as_ = String(av);
      const bs_ = String(bv);
      return sortDir === "asc"
        ? as_.localeCompare(bs_, "th")
        : bs_.localeCompare(as_, "th");
    });

    return rows;
  }, [allRows, filters, sortField, sortDir]);

  // ----- Summary badges -----
  const badgeSums = useMemo(() => {
    let sellPrice = 0;
    let downPayment = 0;
    let financeAmount = 0;
    let commission = 0;
    let totalInstallment = 0;
    for (const r of filteredRows as any[]) {
      sellPrice += Number(r.sellPrice ?? 0);
      downPayment += Number(r.downPayment ?? 0);
      financeAmount += Number(r.financeAmount ?? 0);
      commission += Number(r.commissionNet ?? 0);
      // ยอดผ่อนรวม = installmentAmount × installmentCount
      const instAmt = Number(r.installmentAmount ?? 0);
      const instCnt = Number(r.installmentCount ?? 0);
      totalInstallment += instAmt * instCnt;
    }
    return { sellPrice, downPayment, financeAmount, commission, totalInstallment };
  }, [filteredRows]);

  const fmtMoney = (n: number) =>
    n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ----- Derived UI -----
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.search) n++;
    for (const key of CAT_KEYS) {
      if ((filters[key as keyof Filters] as Set<string>).size > 0) n++;
    }
    if (filters.dateFrom || filters.dateTo) n++;
    if (filters.onlineFilter.size > 0) n++;
    return n;
  }, [filters]);

  // ----- Export helpers -----
  const buildExportParams = () => {
    if (!section) return null;
    const params = new URLSearchParams({ section });
    if (filters.search) params.set("search", filters.search);
    for (const key of CAT_KEYS) {
      const fv = filters[key as keyof Filters] as Set<string>;
      if (fv.size > 0) params.set(key, Array.from(fv).join(","));
    }
    if (filters.dateField) params.set("dateField", filters.dateField);
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    params.set("sortField", sortField);
    params.set("sortDir", sortDir);
    return params;
  };

  const doExport = async (endpoint: string, filePrefix: string, label: string) => {
    const params = buildExportParams();
    if (!params) return;
    const toastId = toast.loading(`กำลังเตรียมไฟล์ Excel (${label})…`);
    try {
      const resp = await fetch(`${endpoint}?${params.toString()}`, { credentials: "include" });
      if (!resp.ok) {
        const { message } = await resp.json().catch(() => ({ message: "Export failed" }));
        toast.error(message, { id: toastId }); return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filePrefix}_${section}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลดสำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  };

  const handleExport = () => doExport("/api/export/contracts", "contracts", "ทั้งหมด");
  const handleExportTracking = () => doExport("/api/export/contracts-tracking", "contracts_tracking", "สำหรับติดตามเครื่อง");

  // ----- Register TopNav actions -----
  const exportRef = useRef(handleExport);
  exportRef.current = handleExport;

  useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar />
      </div>,
    );
    return () => setActions(null);
  }, [setActions]);

  // ----- Sorting toggle -----
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const setCatFilter = (key: keyof Filters, value: Set<string>) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  // ----- Virtualizer -----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 36;
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const totalAllRows = allRows.length;
  const totalFilteredRows = filteredRows.length;

  // ----- Render -----
  return (
    <AppShell fullHeight>
      {/* Loading skeleton */}
      {listQuery.isLoading && (
        <div className="flex flex-col gap-4 p-6 animate-pulse">
          <div className="h-8 bg-gray-200 rounded-lg w-1/3" />
          <div className="h-10 bg-gray-200 rounded-lg w-full" />
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 rounded-lg w-full" />
          ))}
        </div>
      )}
      {/* Error state with retry */}
      {listQuery.isError && (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <div className="text-red-500 text-5xl">⚠️</div>
          <h2 className="text-lg font-semibold text-gray-800">โหลดข้อมูลไม่สำเร็จ</h2>
          <p className="text-sm text-gray-500 max-w-sm text-center">
            {listQuery.error?.message ?? "เกิดข้อผิดพลาดในการโหลดข้อมูลสัญญา"}
          </p>
          <button
            onClick={() => listQuery.refetch()}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors"
          >
            ลองใหม่อีกครั้ง
          </button>
        </div>
      )}
      {/* Main content */}
      {!listQuery.isLoading && !listQuery.isError && (
      <div className="flex flex-col h-full">
      <div className="w-full px-3 md:px-5 py-3 flex flex-col flex-1 min-h-0">
        {/* Toolbar: search + export */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="ค้นหา: เลขสัญญา / ชื่อลูกค้า / พาร์ทเนอร์ / โทร / IMEI / Serial / เลขบัตร"
              className="pl-9 bg-white"
              value={filters.search}
              onChange={(e) =>
                setFilters((f) => ({ ...f, search: e.target.value }))
              }
            />
          </div>

          <div className="flex items-center gap-2">
            {canExport && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button className="bg-green-600 hover:bg-green-700 text-white">
                    <Download className="w-4 h-4 mr-1.5" />
                    Export Excel
                    <ChevronDown className="w-3.5 h-3.5 ml-1" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-52 p-1" align="end">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm rounded hover:bg-gray-100 transition-colors"
                    onClick={() => handleExport()}
                  >
                    ทั้งหมด
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm rounded hover:bg-gray-100 transition-colors"
                    onClick={() => handleExportTracking()}
                  >
                    สำหรับติดตามเครื่อง
                  </button>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>

        {/* Collapsible filter panel */}
        <div className="bg-white border border-gray-200 rounded-xl mb-3">
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors"
          >
            <div className="flex items-center gap-2">
              <FilterIcon className="w-4 h-4 text-gray-400" />
              <span>ตัวกรองข้อมูล</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-indigo-600 rounded-full">
                  {activeFilterCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {activeFilterCount > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilters(EMPTY_FILTERS);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      setFilters(EMPTY_FILTERS);
                    }
                  }}
                  className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium"
                >
                  <X className="w-3 h-3" />
                  ล้างทั้งหมด
                </span>
              )}
              <ChevronDown
                className={`w-4 h-4 text-gray-400 transition-transform ${filterOpen ? "rotate-180" : ""}`}
              />
            </div>
          </button>

          {/* Body: filter controls */}
          {filterOpen && (
            <div className="border-t border-gray-100 p-4">
              {/* Categorical multi-select filters */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {CAT_KEYS.map((key) => (
                  <MultiComboboxFilter
                    key={key}
                    label={CAT_LABELS[key] ?? key}
                    selected={filters[key as keyof Filters] as Set<string>}
                    onChange={(v) => setCatFilter(key as keyof Filters, v)}
                    options={
                      key === "debtStatus" ? [...DEBT_STATUS_OPTIONS] :
                      key === "device" ? [...DEVICE_OPTIONS] :
                      (dynamicOptions[key] ?? [])
                    }
                    placeholder={key === "device" ? "ทุก Device" : "ทั้งหมด"}
                  />
                ))}
              </div>

              {/* Online status filter */}
              <div className="mt-3 pt-3 border-t border-dashed border-gray-200">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-500 font-medium whitespace-nowrap">ออนไลน์ล่าสุด:</span>
                  {([
                    { value: "today", label: "• วันนี้", activeClass: "bg-green-100 text-green-700 border-green-300" },
                    { value: "1-3",   label: "1–3 วัน", activeClass: "bg-yellow-100 text-yellow-700 border-yellow-300" },
                    { value: "4-7",   label: "4–7 วัน", activeClass: "bg-orange-100 text-orange-700 border-orange-300" },
                    { value: "over7", label: ">7 วัน",  activeClass: "bg-red-100 text-red-700 border-red-300" },
                  ] as { value: string; label: string; activeClass: string }[]).map((opt) => {
                    const active = filters.onlineFilter.has(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          const next = new Set(filters.onlineFilter);
                          if (active) next.delete(opt.value); else next.add(opt.value);
                          setFilters((f) => ({ ...f, onlineFilter: next }));
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
                  {filters.onlineFilter.size > 0 && (
                    <button
                      onClick={() => setFilters((f) => ({ ...f, onlineFilter: new Set() }))}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <X className="w-3 h-3" />ล้าง
                    </button>
                  )}
                </div>
              </div>

              {/* Date field: pill/tab selector + date range inputs */}
              <div className="mt-3 pt-3 border-t border-dashed border-gray-200">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Pill/tab selector for date field */}
                  <div className="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5 gap-0.5">
                    {(
                      [
                        { value: "approveDate", label: "วันอนุมัติ" },
                        { value: "submitDate", label: "วันยื่น" },
                      ] as { value: Filters["dateField"]; label: string }[]
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          setFilters((f) => ({ ...f, dateField: opt.value }))
                        }
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                          filters.dateField === opt.value
                            ? "bg-indigo-600 text-white shadow-sm"
                            : "text-gray-500 hover:text-gray-700 hover:bg-white"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {/* Date range inputs */}
                  <Input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, dateFrom: e.target.value }))
                    }
                    className={`h-8 text-sm w-auto ${
                      filters.dateFrom
                        ? "border-indigo-400 bg-indigo-50 text-indigo-800"
                        : ""
                    }`}
                  />
                  <span className="text-xs text-gray-400">ถึง</span>
                  <Input
                    type="date"
                    value={filters.dateTo}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, dateTo: e.target.value }))
                    }
                    className={`h-8 text-sm w-auto ${
                      filters.dateTo
                        ? "border-indigo-400 bg-indigo-50 text-indigo-800"
                        : ""
                    }`}
                  />
                  {(filters.dateFrom || filters.dateTo) && (
                    <button
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          dateFrom: "",
                          dateTo: "",
                        }))
                      }
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-xs text-indigo-700 font-medium"
                    >
                      <span>
                        {filters.dateFrom || "…"} → {filters.dateTo || "…"}
                      </span>
                      <X className="w-3 h-3 text-indigo-400 hover:text-indigo-700" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Row counter + Badge row */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {/* Left: row count */}
          <div className="text-sm text-gray-600">
            {listQuery.isLoading ? (
              <span className="inline-flex items-center gap-2 text-gray-500">
                <Spinner /> กำลังโหลดข้อมูลทั้งหมด…
              </span>
            ) : (
              <>
                แสดง{" "}
                <span className="font-medium text-gray-900">
                  {totalFilteredRows.toLocaleString("th-TH")}
                </span>{" "}
                จาก{" "}
                <span className="font-medium text-gray-900">
                  {totalAllRows.toLocaleString("th-TH")}
                </span>{" "}
                แถว
                {totalFilteredRows < totalAllRows && (
                  <span className="text-gray-400"> (กรองอยู่)</span>
                )}
              </>
            )}
          </div>
          {/* Right: summary badges */}
          {!listQuery.isLoading && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 border border-blue-200">
                <span className="text-xs font-medium text-blue-600">ราคาขาย</span>
                <span className="text-xs font-bold text-blue-800">
                  {fmtMoney(badgeSums.sellPrice)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200">
                <span className="text-xs font-medium text-emerald-600">ดาวน์</span>
                <span className="text-xs font-bold text-emerald-800">
                  {fmtMoney(badgeSums.downPayment)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-50 border border-violet-200">
                <span className="text-xs font-medium text-violet-600">ยอดจัดไฟแนนซ์</span>
                <span className="text-xs font-bold text-violet-800">
                  {fmtMoney(badgeSums.financeAmount)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200">
                <span className="text-xs font-medium text-amber-600">ยอดผ่อนรวม</span>
                <span className="text-xs font-bold text-amber-800">
                  {fmtMoney(badgeSums.totalInstallment)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-50 border border-rose-200">
                <span className="text-xs font-medium text-rose-600">Commission</span>
                <span className="text-xs font-bold text-rose-800">
                  {fmtMoney(badgeSums.commission)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Virtualized table — fills remaining viewport height */}
        {/* หุ้มตาราง: ใช้ ring+rounded แทน overflow-hidden เพื่อไม่บล็อก sticky thead */}
        <div className="relative bg-white border border-gray-200 rounded-xl shadow-sm flex flex-col flex-1 min-h-0" style={{ overflow: 'clip' }}>
          {/* ── Single scroll container: header sticky ใน thead, scroll ทั้ง x และ y พร้อมกัน ── */}
          <div
            ref={scrollRef}
            className="overflow-x-auto overflow-y-auto flex-1 min-h-0 rounded-xl"
            style={{ overscrollBehavior: "contain" }}
          >
            <table className="min-w-full text-[13px] border-separate border-spacing-0">
              <colgroup>
                  {CONTRACT_COLUMNS.filter((col) => !UI_HIDDEN_COLS.has(col.key)).map((col) => (
                  <col key={col.key} style={{ width: col.colWidth, minWidth: col.colWidth }} />
                ))}
              </colgroup>
              {/* thead sticky — ติดด้านบนเมื่อ scroll ลง, scroll ซ้าย-ขวาพร้อมกับ body อัตโนมัติ */}
              <thead className="sticky top-0 z-30">
                {/* Group header row
                    สินเชื่อ(6) | พาร์ทเนอร์(4) | ลูกค้า(15) | สินค้า(8) | ไฟแนนซ์(7) | หนี้(3) = 43
                    (ซ่อน mdmEnabled/deviceLock/itAlert ใน UI แต่ยังคง export ได้) */}
                <tr className="text-xs font-semibold text-center">
                  <th colSpan={6}  className="px-3 py-1.5 bg-slate-600  text-white border-b border-slate-500  whitespace-nowrap">สินเชื่อ</th>
                  <th colSpan={4}  className="px-3 py-1.5 bg-indigo-600 text-white border-b border-indigo-500 whitespace-nowrap">พาร์ทเนอร์</th>
                  <th colSpan={15} className="px-3 py-1.5 bg-teal-600   text-white border-b border-teal-500   whitespace-nowrap">ลูกค้า</th>
                  <th colSpan={8}  className="px-3 py-1.5 bg-amber-600  text-white border-b border-amber-500  whitespace-nowrap">สินค้า</th>
                  <th colSpan={7}  className="px-3 py-1.5 bg-rose-600   text-white border-b border-rose-500   whitespace-nowrap">ไฟแนนซ์</th>
                  <th colSpan={3}  className="px-3 py-1.5 bg-purple-600 text-white border-b border-purple-500 whitespace-nowrap">หนี้</th>
                </tr>
                {/* Column header row */}
                <tr className="text-gray-700">
                  {CONTRACT_COLUMNS.filter((col) => !UI_HIDDEN_COLS.has(col.key)).map((col, idx) => {
                    // group boundaries (UI only, hidden cols excluded): 6/4/15/8/7/3 = 43
                    const groupBg =
                      idx < 6  ? "bg-slate-50"  :
                      idx < 10 ? "bg-indigo-50" :
                      idx < 25 ? "bg-teal-50"   :
                      idx < 33 ? "bg-amber-50"  :
                      idx < 40 ? "bg-rose-50"   :
                      "bg-purple-50";
                    const isSticky = idx === 1;
                    const sortable = SORTABLE_FIELDS.includes(col.key as SortField);
                    const isActive = sortField === (col.key as SortField);
                    return (
                      <th
                        key={col.key}
                        className={`px-3 py-2 text-left whitespace-nowrap font-medium border-b border-gray-200 ${groupBg} ${
                          isSticky ? "sticky left-0 z-40 after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-slate-200" : ""
                        } ${sortable ? "cursor-pointer hover:brightness-95" : ""}`}
                        style={isSticky ? { left: 0 } : undefined}
                        onClick={sortable ? () => toggleSort(col.key as SortField) : undefined}
                      >
                        <span>{col.label}</span>
                        {sortable && isActive && (
                          <span className="ml-1 text-blue-600">
                            {sortDir === "asc" ? "▲" : "▼"}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {listQuery.isLoading && (
                  <tr>
                    <td colSpan={CONTRACT_COLUMNS.filter((c) => !UI_HIDDEN_COLS.has(c.key)).length} className="text-center py-10 text-gray-500">
                      <Spinner className="inline-block mr-2" /> กำลังโหลด…
                    </td>
                  </tr>
                )}
                {!listQuery.isLoading && filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={CONTRACT_COLUMNS.filter((c) => !UI_HIDDEN_COLS.has(c.key)).length} className="text-center py-10 text-gray-500">
                      ไม่พบข้อมูลที่ตรงเงื่อนไข
                    </td>
                  </tr>
                )}
                {virtualRows.length > 0 && (
                  <tr style={{ height: `${virtualRows[0].start}px` }} aria-hidden="true">
                    <td colSpan={CONTRACT_COLUMNS.filter((c) => !UI_HIDDEN_COLS.has(c.key)).length} />
                  </tr>
                )}
                {virtualRows.map((virtualRow) => {
                  const row: any = filteredRows[virtualRow.index];
                  const seq = virtualRow.index + 1;
                  const isHovered = hoveredRow === virtualRow.index;
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-gray-100 transition-colors cursor-default ${
                        isHovered
                          ? "bg-blue-50 shadow-[inset_3px_0_0_0_#3b82f6] relative z-10"
                          : "hover:bg-blue-50/40"
                      }`}
                      style={{ height: `${ROW_HEIGHT}px` }}
                      onMouseEnter={() => setHoveredRow(virtualRow.index)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      {CONTRACT_COLUMNS.filter((col) => !UI_HIDDEN_COLS.has(col.key)).map((col, idx) => {
                        const isSticky = idx === 1;
                        const stickyBg = isHovered ? "bg-blue-50" : "bg-white";
                        return (
                          <td
                            key={col.key}
                            className={`px-3 py-2 whitespace-nowrap ${
                              col.type === "money" || col.type === "number"
                                ? "text-right tabular-nums"
                                : ""
                            } ${
                              isSticky
                                ? `sticky z-20 ${stickyBg} after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-slate-100`
                                : ""
                            }`}
                            style={isSticky ? { left: 0 } : undefined}
                          >
                            {col.key === "lastOnlineDays" ? (
                              (() => {
                                if (!row.serialNo) return <span className="text-gray-300 text-xs">-</span>;
                                const days = row.lastOnlineDays;
                                // tooltip: แสดงวันที่และเวลาออนไลน์ล่าสุดเมื่อ hover
                                const tooltipText = (row as any).lastOnlineAt
                                  ? `ออนไลน์ล่าสุด: ${(row as any).lastOnlineAt}`
                                  : undefined;
                                // ไอคอน Lost Mode (lossStatus): 1=ล็อกเครื่อง (สีแดง), 0=ไม่ล็อค (สีเขียว), null=ไม่แสดง
                                const lossStatusVal = (row as any).lossStatus;
                                const lockIcon = lossStatusVal === 1 ? (
                                  <Lock className="inline-block w-3 h-3 text-red-500 ml-1 flex-shrink-0" aria-label="Lost Mode: ล็อกเครื่อง" />
                                ) : lossStatusVal === 0 ? (
                                  <Lock className="inline-block w-3 h-3 text-green-500 ml-1 flex-shrink-0" aria-label="Lost Mode: ไม่ล็อก" />
                                ) : null;
                                // ไอคอน MDM Control (deviceLock): true=อยู่ภายใต้ MDM (สีเขียว), false=หลุดจาก MDM (สีเทา), null=ไม่แสดง
                                const shieldIcon = row.deviceLock === true ? (
                                  <ShieldCheck className="inline-block w-3 h-3 text-green-500 ml-0.5 flex-shrink-0" aria-label="MDM: อยู่ภายใต้การควบคุม" />
                                ) : row.deviceLock === false ? (
                                  <ShieldOff className="inline-block w-3 h-3 text-gray-400 ml-0.5 flex-shrink-0" aria-label="MDM: หลุดจากการควบคุม" />
                                ) : null;
                                // ปุ่ม GPS MapPin: สีเขียว=มี location log (กดได้), สีเทา=ไม่มี log (กดไม่ได้)
                                const hasLocationLog = !!(row as any).locationLogCount && (row as any).locationLogCount > 0;
                                const mapPinBtn = row.serialNo ? (
                                  hasLocationLog ? (
                                    <button
                                      type="button"
                                      title="ดูประวัติตำแหน่ง GPS"
                                      className="inline-flex items-center justify-center w-4 h-4 ml-0.5 text-green-500 hover:text-green-700 transition-colors flex-shrink-0"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openDialog({
                                          mdmDeviceId: row.mdmDeviceId,
                                          customerName: row.customerName,
                                          contractNo: row.contractNo,
                                          serialNo: row.serialNo,
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
                              })()
                            ) : col.key === "overdueDays" ? (
                              // overdueDays: วันเกินกำหนดชำระ (นับจากงวดแรกที่ค้าง)
                              (() => {
                                const d = row.overdueDays;
                                if (d == null) return <span className="text-gray-300 text-xs">-</span>;
                                const n = Number(d);
                                if (n === 0) return <span className="text-gray-400 text-xs">0</span>;
                                // สีตาม severity
                                const cls =
                                  n <= 7   ? "text-yellow-700 bg-yellow-50" :
                                  n <= 14  ? "text-orange-700 bg-orange-50" :
                                  n <= 30  ? "text-orange-700 bg-orange-100" :
                                  n <= 60  ? "text-red-700 bg-red-50" :
                                  n <= 90  ? "text-red-700 bg-red-100" :
                                  "text-red-900 bg-red-200 font-bold";
                                return (
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${cls}`}>
                                    {n.toLocaleString("th-TH")} วัน
                                  </span>
                                );
                              })()
                            ) : col.key === "itAlert" ? (
                              // itAlert: Y ถ้า lastOnlineDays > 4 หรือ MDM = N
                              (() => {
                                const sn = row.serialNo;
                                const onlineDays = row.lastOnlineDays;
                                const dl = row.deviceLock;
                                const mdmN = dl === null || dl === undefined;
                                const onlineOver4 = sn && onlineDays != null && Number(onlineDays) > 4;
                                const isAlert = onlineOver4 || mdmN;
                                return isAlert ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">
                                    Y
                                  </span>
                                ) : (
                                  <span className="text-gray-400 text-xs">N</span>
                                );
                              })()
                            ) : formatCell(col.key, row, seq)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {virtualRows.length > 0 && (
                  <tr
                    style={{
                      height: `${
                        rowVirtualizer.getTotalSize() -
                        (virtualRows[virtualRows.length - 1]?.end ?? 0)
                      }px`,
                    }}
                    aria-hidden="true"
                  >
                    <td colSpan={CONTRACT_COLUMNS.filter((c) => !UI_HIDDEN_COLS.has(c.key)).length} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
      )}
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

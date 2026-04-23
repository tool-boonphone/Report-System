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
  RefreshCcw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

// ─── Filter state ─────────────────────────────────────────────────────────────
type Filters = {
  search: string;
  // categorical
  status: string;
  debtType: string;
  partnerCode: string;
  partnerProvince: string;
  partnerStatus: string;
  channel: string;
  nationality: string;
  gender: string;
  occupation: string;
  idProvince: string;
  addrProvince: string;
  workProvince: string;
  promotionName: string;
  device: string;
  productType: string;
  model: string;
  deviceStatus: string;
  // date range
  dateField: "submitDate" | "approveDate";
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: Filters = {
  search: "",
  status: "",
  debtType: "",
  partnerCode: "",
  partnerProvince: "",
  partnerStatus: "",
  channel: "",
  nationality: "",
  gender: "",
  occupation: "",
  idProvince: "",
  addrProvince: "",
  workProvince: "",
  promotionName: "",
  device: "",
  productType: "",
  model: "",
  deviceStatus: "",
  dateField: "approveDate",
  dateFrom: "",
  dateTo: "",
};

// Categorical filter keys (used for cascading logic)
const CAT_KEYS: Array<keyof Omit<Filters, "search" | "dateField" | "dateFrom" | "dateTo">> = [
  "status",
  "debtType",
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
  debtType: "ประเภทหนี้",
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

/** ComboboxFilter: searchable dropdown with active state styling */
function ComboboxFilter({
  label,
  value,
  onChange,
  options,
  placeholder = "ทั้งหมด",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="text-xs font-medium text-gray-500 truncate">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={`w-full px-2.5 py-1.5 text-sm border rounded-lg text-left flex items-center justify-between gap-1 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
              value
                ? "border-indigo-400 bg-indigo-50 text-indigo-800 font-medium"
                : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
            }`}
          >
            <span className="truncate">{value || placeholder}</span>
            <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput
              placeholder="พิมพ์ค้นหา..."
              className="h-8 text-sm"
            />
            <CommandList>
              <CommandEmpty>ไม่พบตัวเลือก</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="__all__"
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`mr-2 h-3.5 w-3.5 ${!value ? "opacity-100 text-indigo-600" : "opacity-0"}`}
                  />
                  <span
                    className={!value ? "text-indigo-600 font-medium" : "text-gray-500"}
                  >
                    {placeholder}
                  </span>
                </CommandItem>
                {options.map((opt) => (
                  <CommandItem
                    key={opt}
                    value={opt}
                    onSelect={(v) => {
                      const original =
                        options.find((o) => o.toLowerCase() === v) ?? v;
                      onChange(value === original ? "" : original);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={`mr-2 h-3.5 w-3.5 ${value === opt ? "opacity-100 text-indigo-600" : "opacity-0"}`}
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

  // Reset filters when section changes
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
  }, [section]);

  // ----- One-shot fetch of all rows for the section -----
  const listQuery = trpc.contracts.listAll.useQuery(
    { section: section! },
    { staleTime: 60_000, enabled: Boolean(section) },
  );

  const allRows = listQuery.data ?? [];

  // ─── Cascading dynamic options ────────────────────────────────────────────
  // For each categorical key, compute available options by applying ALL OTHER
  // active filters (+ date range + search) — so options shrink as user selects.
  const dynamicOptions = useMemo(() => {
    // Helper: does a row pass all filters EXCEPT the one we're computing options for?
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
      // categorical filters
      for (const key of CAT_KEYS) {
        if (key === excludeKey) continue;
        const fv = filters[key as keyof Filters] as string;
        if (fv && r[key] !== fv) return false;
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
      result[key] = Array.from(new Set(subset.map((r: any) => String(r[key]))))
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
      // categorical
      for (const key of CAT_KEYS) {
        const fv = f[key as keyof Filters] as string;
        if (fv && r[key] !== fv) return false;
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
      const cmp = String(av).localeCompare(String(bv), "th");
      return sortDir === "asc" ? cmp : -cmp;
    });

    return rows;
  }, [allRows, filters, sortField, sortDir]);

  // ----- Derived UI -----
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.search) n++;
    for (const key of CAT_KEYS) {
      if (filters[key as keyof Filters]) n++;
    }
    if (filters.dateFrom || filters.dateTo) n++;
    return n;
  }, [filters]);

  // ----- Export -----
  const handleExport = async () => {
    if (!section) return;
    const params = new URLSearchParams({ section });
    if (filters.search) params.set("search", filters.search);
    for (const key of CAT_KEYS) {
      const fv = filters[key as keyof Filters] as string;
      if (fv) params.set(key, fv);
    }
    if (filters.dateField) params.set("dateField", filters.dateField);
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    params.set("sortField", sortField);
    params.set("sortDir", sortDir);

    const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
    try {
      const resp = await fetch(`/api/export/contracts?${params.toString()}`, {
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
      a.download = `contracts_${section}_${new Date()
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
  };

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

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  // ----- Virtualizer -----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 36;
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? totalSize - virtualRows[virtualRows.length - 1].end
    : 0;

  const totalAllRows = allRows.length;
  const totalFilteredRows = filteredRows.length;

  // ----- Render -----
  return (
    <AppShell>
      <div className="w-full px-3 md:px-5 py-3">
        {/* Toolbar: search + refresh + export */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="ค้นหา: เลขสัญญา / ชื่อลูกค้า / พาร์ทเนอร์ / โทร / IMEI / Serial / เลขบัตร"
              className="pl-9 bg-white"
              value={filters.search}
              onChange={(e) => setFilter("search", e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="bg-white"
              onClick={() => listQuery.refetch()}
              title="โหลดข้อมูลใหม่"
            >
              <RefreshCcw
                className={`w-4 h-4 ${listQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
            {canExport && (
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={() => exportRef.current()}
              >
                <Download className="w-4 h-4 mr-1.5" />
                Export Excel
              </Button>
            )}
          </div>
        </div>

        {/* Collapsible filter panel */}
        <div className="bg-white border border-gray-200 rounded-xl mb-3">
          {/* Header: toggle + clear */}
          <div className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700">
            <button
              onClick={() => setFilterOpen((v) => !v)}
              className="flex items-center gap-2 hover:text-indigo-600 transition-colors"
            >
              <FilterIcon className="w-4 h-4 text-gray-400" />
              <span>ตัวกรองข้อมูล</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-indigo-600 rounded-full">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <div className="flex items-center gap-3">
              {activeFilterCount > 0 && (
                <button
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium"
                >
                  <X className="w-3 h-3" />
                  ล้างทั้งหมด
                </button>
              )}
              <ChevronDown
                className={`w-4 h-4 text-gray-400 transition-transform ${filterOpen ? "rotate-180" : ""}`}
              />
            </div>
          </div>

          {/* Body: filter controls */}
          {filterOpen && (
            <div className="border-t border-gray-100 p-4">
              {/* Row 1: core categorical filters */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {CAT_KEYS.map((key) => (
                  <ComboboxFilter
                    key={key}
                    label={CAT_LABELS[key] ?? key}
                    value={filters[key as keyof Filters] as string}
                    onChange={(v) => setFilter(key as keyof Filters, v as any)}
                    options={dynamicOptions[key] ?? []}
                  />
                ))}
                {/* Date field selector */}
                <div className="flex flex-col gap-1 min-w-0">
                  <label className="text-xs font-medium text-gray-500">
                    ช่วงวันที่
                  </label>
                  <select
                    value={filters.dateField}
                    onChange={(e) =>
                      setFilter(
                        "dateField",
                        e.target.value as Filters["dateField"],
                      )
                    }
                    className="h-[34px] rounded-lg border border-gray-200 bg-white px-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    <option value="approveDate">วันอนุมัติสัญญา</option>
                    <option value="submitDate">วันยื่นสินเชื่อ</option>
                  </select>
                </div>
              </div>
              {/* Date range row */}
              <div className="mt-3 pt-3 border-t border-dashed border-gray-200">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-indigo-600 tracking-wide uppercase whitespace-nowrap">
                    {filters.dateField === "approveDate"
                      ? "วันอนุมัติ"
                      : "วันยื่น"}
                  </span>
                  <Input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) => setFilter("dateFrom", e.target.value)}
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
                    onChange={(e) => setFilter("dateTo", e.target.value)}
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

        {/* Row counter */}
        <div className="mb-2 text-sm text-gray-600">
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

        {/* Virtualized table */}
        <div className="relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
          <div
            ref={scrollRef}
            className="overflow-x-auto overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 280px)", height: filteredRows.length > 0 ? Math.min(filteredRows.length * 36 + 40, window.innerHeight - 280) : undefined }}
          >
            <table className="min-w-full text-[13px]">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-gray-700">
                  {CONTRACT_COLUMNS.map((col) => {
                    const sortable = SORTABLE_FIELDS.includes(
                      col.key as SortField,
                    );
                    const isActive = sortField === (col.key as SortField);
                    return (
                      <th
                        key={col.key}
                        className={`px-3 py-2 text-left whitespace-nowrap font-medium border-b border-gray-200 ${
                          sortable ? "cursor-pointer hover:bg-gray-100" : ""
                        }`}
                        onClick={
                          sortable
                            ? () => toggleSort(col.key as SortField)
                            : undefined
                        }
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
                    <td
                      colSpan={CONTRACT_COLUMNS.length}
                      className="text-center py-10 text-gray-500"
                    >
                      <Spinner className="inline-block mr-2" /> กำลังโหลด…
                    </td>
                  </tr>
                )}
                {!listQuery.isLoading && filteredRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={CONTRACT_COLUMNS.length}
                      className="text-center py-10 text-gray-500"
                    >
                      ไม่พบข้อมูลที่ตรงเงื่อนไข
                    </td>
                  </tr>
                )}

                {paddingTop > 0 && (
                  <tr style={{ height: paddingTop }} aria-hidden="true">
                    <td colSpan={CONTRACT_COLUMNS.length} />
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
                      style={{ height: ROW_HEIGHT }}
                      onMouseEnter={() => setHoveredRow(virtualRow.index)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      {CONTRACT_COLUMNS.map((col) => (
                        <td
                          key={col.key}
                          className={`px-3 py-2 whitespace-nowrap ${
                            col.type === "money" || col.type === "number"
                              ? "text-right tabular-nums"
                              : ""
                          }`}
                        >
                          {formatCell(col.key, row, seq)}
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {paddingBottom > 0 && (
                  <tr style={{ height: paddingBottom }} aria-hidden="true">
                    <td colSpan={CONTRACT_COLUMNS.length} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

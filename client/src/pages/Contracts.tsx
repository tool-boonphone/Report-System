import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { CONTRACT_COLUMNS, type ContractColumnKey } from "@shared/const";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Download,
  Filter as FilterIcon,
  RefreshCcw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type Filters = {
  search: string;
  status: string;
  debtType: string;
  partnerCode: string;
  dateField: "submitDate" | "approveDate";
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: Filters = {
  search: "",
  status: "",
  debtType: "",
  partnerCode: "",
  dateField: "approveDate",
  dateFrom: "",
  dateTo: "",
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

export default function Contracts() {
  const { section } = useSection();
  const { setActions } = useNavActions();
  const { can } = useAppAuth();
  const canExport = can("contract", "export");

  // ----- State -----
  const [sortField, setSortField] = useState<SortField>("approveDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Reset filters when section changes
  useEffect(() => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  }, [section]);

  // ----- One-shot fetch of all rows for the section -----
  // Payload is ~4 MB for Boonphone (3.5k rows, no rawJson). tRPC caches this
  // for `staleTime` so re-entering the page is instant. Filtering/sorting
  // happen on the client below so the virtual scroller stays silky.
  const listQuery = trpc.contracts.listAll.useQuery(
    { section: section! },
    { staleTime: 60_000, enabled: Boolean(section) },
  );
  const optionsQuery = trpc.contracts.filterOptions.useQuery(
    { section: section! },
    { staleTime: 5 * 60_000, enabled: Boolean(section) },
  );

  const allRows = listQuery.data ?? [];

  // ----- Client-side filtering + sorting -----
  const filteredRows = useMemo(() => {
    const f = applied;
    const q = f.search.trim().toLowerCase();
    const dateFrom = f.dateFrom || "";
    const dateTo = f.dateTo || "";

    let rows = allRows.filter((r: any) => {
      if (f.status && r.status !== f.status) return false;
      if (f.debtType && r.debtType !== f.debtType) return false;
      if (f.partnerCode && r.partnerCode !== f.partnerCode) return false;
      if (dateFrom || dateTo) {
        const dateVal =
          f.dateField === "approveDate" ? r.approveDate : r.submitDate;
        const d = dateVal ? String(dateVal).slice(0, 10) : "";
        if (dateFrom && (!d || d < dateFrom)) return false;
        if (dateTo && (!d || d > dateTo)) return false;
      }
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

    // Sort in-place copy so we don't mutate the cache.
    rows = [...rows].sort((a: any, b: any) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (av == null && bv == null) return 0;
      if (av == null) return sortDir === "asc" ? -1 : 1;
      if (bv == null) return sortDir === "asc" ? 1 : -1;
      // Numeric-friendly comparison when both look numeric, else localeCompare
      const an = typeof av === "number" ? av : Number(av);
      const bn = typeof bv === "number" ? bv : Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
        return sortDir === "asc" ? an - bn : bn - an;
      }
      const cmp = String(av).localeCompare(String(bv), "th");
      return sortDir === "asc" ? cmp : -cmp;
    });

    return rows;
  }, [allRows, applied, sortField, sortDir]);

  // ----- Derived UI -----
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (applied.search) n++;
    if (applied.status) n++;
    if (applied.debtType) n++;
    if (applied.partnerCode) n++;
    if (applied.dateFrom || applied.dateTo) n++;
    return n;
  }, [applied]);

  // ----- Export (streams the full filtered dataset via server) -----
  const handleExport = async () => {
    if (!section) return;
    const params = new URLSearchParams({ section });
    if (applied.search) params.set("search", applied.search);
    if (applied.status) params.set("status", applied.status);
    if (applied.debtType) params.set("debtType", applied.debtType);
    if (applied.partnerCode) params.set("partnerCode", applied.partnerCode);
    if (applied.dateField) params.set("dateField", applied.dateField);
    if (applied.dateFrom) params.set("dateFrom", applied.dateFrom);
    if (applied.dateTo) params.set("dateTo", applied.dateTo);
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
        {canExport && (
          <Button
            size="sm"
            variant="outline"
            className="bg-white"
            onClick={() => exportRef.current()}
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export
          </Button>
        )}
      </div>,
    );
    return () => setActions(null);
  }, [setActions, canExport]);

  // ----- Sorting toggle -----
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const applyFilters = () => {
    setApplied(draft);
    setFilterSheetOpen(false);
  };

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };

  // ----- Virtualizer -----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 36; // px — matches `py-2 text-[13px]` line height
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
      <div className="max-w-[1600px] mx-auto px-3 md:px-5 py-4">
        {/* Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="ค้นหา: เลขสัญญา / ชื่อลูกค้า / พาร์ทเนอร์ / โทร / IMEI / Serial / เลขบัตร"
              className="pl-9 bg-white"
              value={draft.search}
              onChange={(e) =>
                setDraft((d) => ({ ...d, search: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilters();
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" className="bg-white">
                  <FilterIcon className="w-4 h-4 mr-1.5" />
                  ตัวกรอง
                  {activeFilterCount > 0 && (
                    <Badge className="ml-1.5 bg-blue-600 hover:bg-blue-600">
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full sm:max-w-md overflow-y-auto">
                <SheetHeader>
                  <SheetTitle>ตัวกรองข้อมูลสัญญา</SheetTitle>
                </SheetHeader>
                <div className="space-y-4 mt-4">
                  <div>
                    <Label>สถานะสัญญา</Label>
                    <Select
                      value={draft.status || "__all__"}
                      onValueChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          status: v === "__all__" ? "" : v,
                        }))
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="ทั้งหมด" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">ทั้งหมด</SelectItem>
                        {(optionsQuery.data?.statuses ?? []).map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>ประเภทหนี้</Label>
                    <Select
                      value={draft.debtType || "__all__"}
                      onValueChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          debtType: v === "__all__" ? "" : v,
                        }))
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="ทั้งหมด" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">ทั้งหมด</SelectItem>
                        {(optionsQuery.data?.debtTypes ?? []).map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>รหัสพาร์ทเนอร์</Label>
                    <Select
                      value={draft.partnerCode || "__all__"}
                      onValueChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          partnerCode: v === "__all__" ? "" : v,
                        }))
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="ทั้งหมด" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value="__all__">ทั้งหมด</SelectItem>
                        {(optionsQuery.data?.partnerCodes ?? []).map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="border-t pt-4">
                    <Label>ช่วงวันที่</Label>
                    <Select
                      value={draft.dateField}
                      onValueChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          dateField: v as Filters["dateField"],
                        }))
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approveDate">
                          วันอนุมัติสัญญา
                        </SelectItem>
                        <SelectItem value="submitDate">
                          วันยื่นสินเชื่อ
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <Input
                        type="date"
                        value={draft.dateFrom}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, dateFrom: e.target.value }))
                        }
                      />
                      <Input
                        type="date"
                        value={draft.dateTo}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, dateTo: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={applyFilters} className="flex-1">
                      ใช้ตัวกรอง
                    </Button>
                    <Button variant="outline" onClick={resetFilters}>
                      <X className="w-4 h-4 mr-1" />
                      ล้าง
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>

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
          </div>
        </div>

        {/* Applied filter chips */}
        {activeFilterCount > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3 text-xs">
            {applied.search && (
              <Badge variant="secondary">ค้นหา: {applied.search}</Badge>
            )}
            {applied.status && (
              <Badge variant="secondary">สถานะ: {applied.status}</Badge>
            )}
            {applied.debtType && (
              <Badge variant="secondary">ประเภทหนี้: {applied.debtType}</Badge>
            )}
            {applied.partnerCode && (
              <Badge variant="secondary">
                พาร์ทเนอร์: {applied.partnerCode}
              </Badge>
            )}
            {(applied.dateFrom || applied.dateTo) && (
              <Badge variant="secondary">
                {applied.dateField === "approveDate" ? "อนุมัติ" : "ยื่น"}:{" "}
                {applied.dateFrom || "…"} → {applied.dateTo || "…"}
              </Badge>
            )}
          </div>
        )}

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
            style={{ maxHeight: "calc(100vh - 220px)" }}
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

                {/* Top spacer to account for skipped rows above viewport */}
                {paddingTop > 0 && (
                  <tr style={{ height: paddingTop }} aria-hidden="true">
                    <td colSpan={CONTRACT_COLUMNS.length} />
                  </tr>
                )}

                {virtualRows.map((virtualRow) => {
                  const row: any = filteredRows[virtualRow.index];
                  const seq = virtualRow.index + 1;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-gray-100 hover:bg-blue-50/30"
                      style={{ height: ROW_HEIGHT }}
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

                {/* Bottom spacer for rows below viewport */}
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

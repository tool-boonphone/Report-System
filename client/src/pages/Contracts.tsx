import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { keepPreviousData } from "@tanstack/react-query";
import {
  CONTRACT_COLUMNS,
  type ContractColumnKey,
} from "@shared/const";
import {
  ChevronLeft,
  ChevronRight,
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

/** Format a cell value according to its column type. */
function formatCell(key: ContractColumnKey, row: any, seq: number): string {
  if (key === "seq") return String(seq);
  const v = row[key];
  if (v === null || v === undefined || v === "") return "-";
  const col = CONTRACT_COLUMNS.find((c) => c.key === key);
  if (col?.type === "money") {
    const n = typeof v === "string" ? Number(v) : (v as number);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (col?.type === "number") {
    const n = typeof v === "string" ? Number(v) : (v as number);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("th-TH");
  }
  return String(v);
}

export default function Contracts() {
  const { section } = useSection();
  const { setActions } = useNavActions();
  const { can } = useAppAuth();
  const canExport = can("contract", "export");

  // ----- State -----
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [sortField, setSortField] = useState<
    "contractNo" | "submitDate" | "approveDate" | "status" | "customerName" | "partnerCode"
  >("approveDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // When the section changes, reset pagination and applied filters.
  useEffect(() => {
    setPage(1);
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  }, [section]);

  // ----- Queries -----
  const listInput = useMemo(
    () => ({
      section: section!,
      page,
      pageSize,
      sort: { field: sortField, dir: sortDir },
      filters: {
        search: applied.search || undefined,
        status: applied.status || undefined,
        debtType: applied.debtType || undefined,
        partnerCode: applied.partnerCode || undefined,
        dateField: applied.dateField,
        dateFrom: applied.dateFrom || undefined,
        dateTo: applied.dateTo || undefined,
      },
    }),
    [section, page, pageSize, sortField, sortDir, applied],
  );

  const listQuery = trpc.contracts.list.useQuery(listInput, {
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled: Boolean(section),
  });
  const optionsQuery = trpc.contracts.filterOptions.useQuery(
    { section: section! },
    { staleTime: 5 * 60_000, enabled: Boolean(section) },
  );

  const totalRows = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const rows = listQuery.data?.rows ?? [];

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

  // ----- Export (streams the full filtered dataset) -----
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
        const { message } = await resp.json().catch(() => ({ message: "Export failed" }));
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
  // Use a stable ref to the latest handler so the effect doesn't re-run
  // every time applied/section state changes (which would remount the node).
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
  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setPage(1);
  };

  const applyFilters = () => {
    setApplied(draft);
    setPage(1);
    setFilterSheetOpen(false);
  };

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  // ----- Render -----
  return (
    <AppShell>
      <div className="max-w-[1600px] mx-auto px-3 md:px-5 py-4">
        {/* Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="ค้นหา: เลขสัญญา / ชื่อลูกค้า / พาร์ทเนอร์ / โทร / IMEI"
              className="pl-9 bg-white"
              value={draft.search}
              onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
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
                        setDraft((d) => ({ ...d, status: v === "__all__" ? "" : v }))
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
                        setDraft((d) => ({ ...d, debtType: v === "__all__" ? "" : v }))
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
                        <SelectItem value="approveDate">วันอนุมัติสัญญา</SelectItem>
                        <SelectItem value="submitDate">วันยื่นสินเชื่อ</SelectItem>
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
              title="โหลดหน้านี้ใหม่"
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
              <Badge variant="secondary">พาร์ทเนอร์: {applied.partnerCode}</Badge>
            )}
            {(applied.dateFrom || applied.dateTo) && (
              <Badge variant="secondary">
                {applied.dateField === "approveDate" ? "อนุมัติ" : "ยื่น"}:{" "}
                {applied.dateFrom || "…"} → {applied.dateTo || "…"}
              </Badge>
            )}
          </div>
        )}

        {/* Table */}
        <div className="relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-200px)]">
            <table className="min-w-full text-[13px]">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-gray-700">
                  {CONTRACT_COLUMNS.map((col) => {
                    const sortable = (
                      ["contractNo", "submitDate", "approveDate", "status", "customerName", "partnerCode"] as const
                    ).includes(col.key as any);
                    const isActive = sortField === (col.key as any);
                    return (
                      <th
                        key={col.key}
                        className={`px-3 py-2 text-left whitespace-nowrap font-medium border-b border-gray-200 ${
                          sortable ? "cursor-pointer hover:bg-gray-100" : ""
                        }`}
                        onClick={sortable ? () => toggleSort(col.key as any) : undefined}
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
                {!listQuery.isLoading && rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={CONTRACT_COLUMNS.length}
                      className="text-center py-10 text-gray-500"
                    >
                      ไม่พบข้อมูลที่ตรงเงื่อนไข
                    </td>
                  </tr>
                )}
                {rows.map((row, idx) => {
                  const seq = (page - 1) * pageSize + idx + 1;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-gray-100 hover:bg-blue-50/30"
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
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mt-3 text-sm text-gray-600">
          <div>
            ทั้งหมด <span className="font-medium text-gray-900">{totalRows.toLocaleString("th-TH")}</span> แถว
            {" • "}
            หน้า <span className="font-medium text-gray-900">{page}</span> / {totalPages}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="bg-white"
              disabled={page <= 1 || listQuery.isFetching}
              onClick={() => setPage(1)}
            >
              หน้าแรก
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="bg-white"
              disabled={page <= 1 || listQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="bg-white"
              disabled={page >= totalPages || listQuery.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="bg-white"
              disabled={page >= totalPages || listQuery.isFetching}
              onClick={() => setPage(totalPages)}
            >
              หน้าสุดท้าย
            </Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

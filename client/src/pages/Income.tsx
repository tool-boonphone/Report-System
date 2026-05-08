/**
 * Income.tsx — หน้ารายรับ (บัญชี > รายรับ)
 *
 * แสดงรายการรับชำระทั้งหมดจาก debt_collected_cache
 * แยกประเภท: ค่างวด, ขายเครื่อง, ปิดยอด
 * หมายเหตุ: "เงินดาวน์" ซ่อนไว้ก่อน (ไม่มีในข้อมูลจริง)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import {
  CalendarDays, ChevronDown, ChevronUp, ChevronsUpDown,
  Download, Eye, EyeOff, Search, X,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Pagination, PaginationContent, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";

// ─── Types ────────────────────────────────────────────────────────────────────
// "เงินดาวน์" ซ่อนไว้ก่อน — ไม่มีในข้อมูลจริง
type IncomeType = "ค่างวด" | "ขายเครื่อง" | "ปิดยอด";
type DateField = "paidAt" | "updatedAt";
type SortKey = "no" | "paidAt" | "incomeType" | "contractNo" | "amount" | "updatedBy" | "updatedAt";
type SortDir = "asc" | "desc";

// "เงินดาวน์" ซ่อนไว้ก่อน — ไม่มีในข้อมูลจริง (period = 0 ไม่ปรากฏใน API)
const ALL_INCOME_TYPES: IncomeType[] = ["ค่างวด", "ปิดยอด", "ขายเครื่อง"];

const TYPE_COLORS: Record<IncomeType, { bg: string; text: string; dot: string }> = {
  "ค่างวด":    { bg: "bg-blue-50",   text: "text-blue-700",   dot: "bg-blue-500" },
  "ขายเครื่อง": { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500" },
  "ปิดยอด":    { bg: "bg-purple-50", text: "text-purple-700", dot: "bg-purple-500" },
  // "เงินดาวน์" ซ่อนไว้ก่อน
};

const BADGE_COLORS: Record<IncomeType, string> = {
  "ค่างวด":    "bg-blue-600",
  "ขายเครื่อง": "bg-orange-500",
  "ปิดยอด":    "bg-purple-600",
  // "เงินดาวน์" ซ่อนไว้ก่อน
};

function fmtMoney(n: number | null | undefined): string {
  const num = Number(n ?? 0);
  if (isNaN(num)) return "0.00";
  return num.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Income() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const { setActions } = useNavActions();

  // ── Permissions ──
  const canView = can("income", "view");
  const canExport = can("income", "export");

  // ── Filter state ──
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateField, setDateField] = useState<DateField>("paidAt");
  const [activeTypes, setActiveTypes] = useState<Set<IncomeType>>(new Set(ALL_INCOME_TYPES));
  const [updatedBy, setUpdatedBy] = useState("");

  // ── Pagination ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // ── Sort ──
  const [sortKey, setSortKey] = useState<SortKey>("paidAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ── Debounce search ──
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  // Reset page on filter change
  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, dateField, activeTypes, updatedBy, pageSize]);

  // ── Nav actions ──
  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  // ── tRPC queries ──
  const incomeTypesParam = useMemo(
    () => (activeTypes.size === ALL_INCOME_TYPES.length ? undefined : Array.from(activeTypes) as IncomeType[]),
    [activeTypes],
  );

  const { data, isLoading, error } = trpc.accounting.listIncome.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateField,
      incomeTypes: incomeTypesParam,
      updatedBy: updatedBy || undefined,
      page,
      pageSize,
    },
    { enabled: !!section && canView },
  );

  const { data: updatedByList } = trpc.accounting.listIncomeUpdatedBy.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section && canView },
  );

  // ── All data for Export (no pagination) ──
  const { data: exportData, refetch: refetchExport } = trpc.accounting.listIncome.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateField,
      incomeTypes: incomeTypesParam,
      updatedBy: updatedBy || undefined,
      page: 1,
      pageSize: 10000,
    },
    { enabled: false },
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // ── Badge sums — ใช้ getIncomeSummary ที่คำนวณ SUM ใน SQL โดยตรง (ไม่ดึง rows ทั้งหมด) ──
  const { data: summaryData } = trpc.accounting.getIncomeSummary.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateField,
      updatedBy: updatedBy || undefined,
    },
    { enabled: !!section && canView },
  );

  const badgeSums = useMemo<Record<IncomeType, number>>(() => ({
    "ค่างวด": summaryData?.["ค่างวด"] ?? 0,
    "ขายเครื่อง": summaryData?.["ขายเครื่อง"] ?? 0,
    "ปิดยอด": summaryData?.["ปิดยอด"] ?? 0,
    // "เงินดาวน์" ซ่อนไว้ก่อน
  }), [summaryData]);

  const totalVisible = useMemo(() => {
    return ALL_INCOME_TYPES.filter((t) => activeTypes.has(t)).reduce((s, t) => s + (badgeSums[t] ?? 0), 0);
  }, [badgeSums, activeTypes]);

  // ── Client-side sort ──
  const sortedRows = useMemo(() => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      let av: string | number = 0;
      let bv: string | number = 0;
      if (sortKey === "no") return 0;
      if (sortKey === "paidAt") { av = a.paidAt ?? ""; bv = b.paidAt ?? ""; }
      else if (sortKey === "incomeType") { av = a.incomeType; bv = b.incomeType; }
      else if (sortKey === "contractNo") { av = a.contractNo; bv = b.contractNo; }
      else if (sortKey === "amount") { av = a.amount; bv = b.amount; }
      else if (sortKey === "updatedBy") { av = a.updatedBy ?? ""; bv = b.updatedBy ?? ""; }
      else if (sortKey === "updatedAt") { av = a.updatedAt ?? ""; bv = b.updatedAt ?? ""; }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [rows, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (col !== sortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  // ── Toggle income type visibility ──
  const toggleType = (t: IncomeType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) { if (next.size > 1) next.delete(t); }
      else next.add(t);
      return next;
    });
  };

  // ── Clear all filters ──
  const clearAll = () => {
    setSearchInput(""); setSearch("");
    setDateFrom(""); setDateTo("");
    setDateField("paidAt");
    setActiveTypes(new Set(ALL_INCOME_TYPES));
    setUpdatedBy("");
    setPage(1);
  };

  const filterCount = [
    search, dateFrom, dateTo,
    updatedBy,
    activeTypes.size < ALL_INCOME_TYPES.length ? "type" : "",
  ].filter(Boolean).length;

  // ── Export Excel ──
  const handleExport = useCallback(async () => {
    const toastId = toast.loading("กำลัง Export...");
    try {
      const { data: exp } = await refetchExport();
      const exportRows = exp?.rows ?? [];
      const wsData = [
        ["No.", "วันที่ชำระ", "ประเภท", "เลขที่สัญญา", "ชื่อลูกค้า", "ยอดเงิน", "ทำรายการโดย", "ทำรายการเมื่อ"],
        ...exportRows.map((r, i) => [
          i + 1,
          fmtDate(r.paidAt),
          r.incomeType,
          r.contractNo,
          r.customerName ?? "",
          r.amount,
          r.updatedBy ?? "",
          fmtDateTime(r.updatedAt),
        ]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws["!cols"] = [
        { wch: 6 }, { wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 24 },
        { wch: 14 }, { wch: 18 }, { wch: 20 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "รายรับ");
      XLSX.writeFile(wb, `รายรับ_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  }, [refetchExport, section]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-32 text-gray-400">
          คุณไม่มีสิทธิ์ดูหน้านี้
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell fullHeight>
      <div className="flex flex-col h-full">
        {/* ── Header: ชื่อเมนู + Export ── */}
        <div className="border-b border-gray-200">
        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 pt-4 pb-2 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-800">รายรับ</h1>
          {canExport && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors shrink-0"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Export Excel</span>
            </button>
          )}
        </div>
        </div>

        {/* ── Filter bar ── */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
          <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 pb-3 pt-2 flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="ค้นหา: เลขที่สัญญา"
                className="h-9 pl-8 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[200px]"
              />
              {searchInput && (
                <button type="button" onClick={() => { setSearchInput(""); setSearch(""); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Date field selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 whitespace-nowrap">จาก:</span>
              <select
                value={dateField}
                onChange={(e) => setDateField(e.target.value as DateField)}
                className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="paidAt">วันที่รับชำระ</option>
                <option value="updatedAt">วันที่ทำรายการ</option>
              </select>
            </div>

            {/* Date from */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 whitespace-nowrap">ตั้งแต่:</span>
              <div className="relative flex items-center">
                <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9 pl-8 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]" />
                {dateFrom && (
                  <button type="button" onClick={() => setDateFrom("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Date to */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 whitespace-nowrap">ถึง:</span>
              <div className="relative flex items-center">
                <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                  className="h-9 pl-8 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]" />
                {dateTo && (
                  <button type="button" onClick={() => setDateTo("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Updated by filter */}
            {updatedByList && updatedByList.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500 whitespace-nowrap">ผู้ทำรายการ:</span>
                <select
                  value={updatedBy}
                  onChange={(e) => setUpdatedBy(e.target.value)}
                  className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[160px]"
                >
                  <option value="">ทั้งหมด</option>
                  {updatedByList.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
                {updatedBy && (
                  <button type="button" onClick={() => setUpdatedBy("")}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Clear all */}
            {filterCount > 0 && (
              <button type="button" onClick={clearAll}
                className="flex items-center gap-1 h-8 px-2.5 text-xs font-medium rounded-md border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
                <X className="w-3 h-3" />
                ล้างทั้งหมด
                <span className="inline-flex items-center justify-center bg-red-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{filterCount}</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Count + Badges ── */}
        <div className="border-b border-gray-100 bg-gray-50">
        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-500">
            {total.toLocaleString()} รายการ
          </span>
          <div className="flex-1" />
          {/* Type badges with eye toggle */}
          <div className="flex flex-wrap items-center gap-2">
            {ALL_INCOME_TYPES.map((t) => {
              const isOn = activeTypes.has(t);
              const color = BADGE_COLORS[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={[
                    "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all",
                    isOn ? `${color} text-white` : "bg-gray-200 text-gray-400",
                  ].join(" ")}
                >
                  {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  <span>{t}</span>
                  <span className={isOn ? "opacity-90" : "opacity-60"}>
                    {fmtMoney(badgeSums[t])}
                  </span>
                </button>
              );
            })}
            {/* Total badge */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-800 text-white">
              <span>รวม</span>
              <span>{fmtMoney(totalVisible)}</span>
            </div>
          </div>
        </div>
        </div>

        {/* ── Table ── */}
        <div className="flex-1 overflow-auto">
          <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Spinner className="w-6 h-6 text-blue-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-20 text-red-500 text-sm">
              เกิดข้อผิดพลาด: {error.message}
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
              ไม่พบข้อมูล
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="bg-blue-700 text-white sticky top-0 z-10">
                <tr>
                  {[
                    { key: "no" as SortKey, label: "No.", cls: "w-12 text-center" },
                    { key: "paidAt" as SortKey, label: "วันที่ชำระ", cls: "w-32" },
                    { key: "incomeType" as SortKey, label: "ประเภท", cls: "w-28" },
                    { key: "contractNo" as SortKey, label: "เลขที่สัญญา", cls: "min-w-[160px]" },
                    { key: "amount" as SortKey, label: "ยอดเงิน", cls: "w-32 text-right" },
                    { key: "updatedBy" as SortKey, label: "ทำรายการโดย", cls: "w-32" },
                    { key: "updatedAt" as SortKey, label: "ทำรายการเมื่อ", cls: "w-40" },
                  ].map(({ key, label, cls }) => (
                    <th
                      key={key}
                      onClick={() => key !== "no" && handleSort(key)}
                      className={[
                        "px-3 py-2.5 font-medium text-left whitespace-nowrap select-none",
                        key !== "no" ? "cursor-pointer hover:bg-blue-600" : "",
                        cls,
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-1">
                        {label}
                        {key !== "no" && <SortIcon col={key} />}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, idx) => {
                  const typeColor = TYPE_COLORS[row.incomeType as IncomeType] ?? { bg: "bg-gray-50", text: "text-gray-700", dot: "bg-gray-400" };
                  const globalIdx = (page - 1) * pageSize + idx + 1;
                  return (
                    <tr
                      key={`${row.contractNo}-${idx}`}
                      className="border-b border-gray-100 hover:bg-blue-50 transition-colors"
                    >
                      <td className="px-3 py-2 text-center text-gray-400 text-xs">{globalIdx}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtDate(row.paidAt)}</td>
                      <td className="px-3 py-2">
                        <span className={[
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                          typeColor.bg, typeColor.text,
                        ].join(" ")}>
                          <span className={["w-1.5 h-1.5 rounded-full", typeColor.dot].join(" ")} />
                          {row.incomeType}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.contractNo}</td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-800">{fmtMoney(row.amount)}</td>
                      <td className="px-3 py-2 text-gray-600 text-xs">{row.updatedBy ?? "-"}</td>
                      <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtDateTime(row.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          </div>
        </div>

        {/* ── Pagination ── */}
        {total > 0 && (
          <div className="px-4 py-3 border-t border-gray-200 bg-white flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span>แสดง</span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                className="h-8 px-2 rounded border border-gray-200 text-sm"
              >
                {[50, 100, 500, 1000].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span>รายการ / หน้า &nbsp;|&nbsp; รวม {total.toLocaleString()} รายการ</span>
            </div>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }}
                    className={page <= 1 ? "pointer-events-none opacity-40" : ""}
                  />
                </PaginationItem>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let p = i + 1;
                  if (totalPages > 5) {
                    if (page <= 3) p = i + 1;
                    else if (page >= totalPages - 2) p = totalPages - 4 + i;
                    else p = page - 2 + i;
                  }
                  return (
                    <PaginationItem key={p}>
                      <PaginationLink
                        href="#"
                        isActive={p === page}
                        onClick={(e) => { e.preventDefault(); setPage(p); }}
                      >
                        {p}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1); }}
                    className={page >= totalPages ? "pointer-events-none opacity-40" : ""}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
      </div>
    </AppShell>
  );
}

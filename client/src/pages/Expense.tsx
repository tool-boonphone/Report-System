/**
 * Expense.tsx — หน้ารายจ่าย (บัญชี > รายจ่าย)
 *
 * Tab 3 แถบ:
 *  1. สรุปรายปี   — ตารางสรุปยอดแยกตามปี
 *  2. สรุปรายเดือน — ตารางสรุปยอดแยกตามเดือน-ปี
 *  3. รายการค่าคอมมิชชั่น — รายการค่าคอมมิชชั่นทั้งหมด (หน้าเดิม)
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
  Download, Search, User, X,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Pagination, PaginationContent, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";

// ─── Types ────────────────────────────────────────────────────────────────────
type SortKey = "no" | "approveDate" | "expenseType" | "contractNo" | "amount" | "updatedBy" | "updatedAt";
type SortDir = "asc" | "desc";
type ActiveTab = "yearly" | "monthly" | "all";

const MONTH_NAMES = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
function fmtMonthYear(period: string): string {
  if (!period || !period.includes("-")) return period;
  const [y, m] = period.split("-");
  const mIdx = parseInt(m, 10) - 1;
  const thYear = parseInt(y, 10) + 543;
  return `${MONTH_NAMES[mIdx] ?? m} ${thYear}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Expense() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const { setActions } = useNavActions();

  const canView = can("expense", "view");
  const canExport = can("expense", "export");

  // ── Active Tab ──
  const [activeTab, setActiveTab] = useState<ActiveTab>("yearly");

  // ── Filter state (all tab) ──
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [updatedBy, setUpdatedBy] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey>("approveDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ── Yearly filter ──
  const currentYear = new Date().getFullYear();
  const [yearlyYear, setYearlyYear] = useState<string>("");

  // ── Monthly filter ──
  const [monthlyYear, setMonthlyYear] = useState<string>(String(currentYear));
  const [monthlyMonths, setMonthlyMonths] = useState<Set<number>>(new Set());

  // ── Debounce search ──
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, updatedBy, pageSize]);

  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  // ── tRPC queries ──
  const { data, isLoading, error } = trpc.accounting.listExpense.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      updatedBy: updatedBy || undefined,
      page,
      pageSize,
    },
    { enabled: !!section && canView && activeTab === "all" },
  );

  const { data: updatedByList } = trpc.accounting.listExpenseUpdatedBy.useQuery(
    { section: section ?? "Boonphone" },
    { enabled: !!section && canView },
  );

  const { refetch: refetchExport } = trpc.accounting.listExpense.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      updatedBy: updatedBy || undefined,
      page: 1,
      pageSize: 10000,
    },
    { enabled: false },
  );

  const { data: summaryData } = trpc.accounting.getExpenseSummary.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    },
    { enabled: !!section && canView && activeTab === "all" },
  );

  // ── Yearly summary ──
  const yearlyYearsParam = useMemo(
    () => (yearlyYear ? [parseInt(yearlyYear, 10)] : undefined),
    [yearlyYear],
  );
  const { data: yearlyData, isLoading: yearlyLoading } = trpc.accounting.getExpenseSummaryByPeriod.useQuery(
    { section: section ?? "Boonphone", groupBy: "year", years: yearlyYearsParam },
    { enabled: !!section && canView && activeTab === "yearly" },
  );

  // ── Monthly summary ──
  const monthlyYearsParam = useMemo(
    () => (monthlyYear ? [parseInt(monthlyYear, 10)] : undefined),
    [monthlyYear],
  );
  const monthlyMonthsParam = useMemo(
    () => (monthlyMonths.size > 0 ? Array.from(monthlyMonths) : undefined),
    [monthlyMonths],
  );
  const { data: monthlyData, isLoading: monthlyLoading } = trpc.accounting.getExpenseSummaryByPeriod.useQuery(
    { section: section ?? "Boonphone", groupBy: "month", years: monthlyYearsParam, months: monthlyMonthsParam },
    { enabled: !!section && canView && activeTab === "monthly" },
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const totalAmount = summaryData?.total ?? 0;

  const sortedRows = useMemo(() => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      let av: string | number = 0;
      let bv: string | number = 0;
      if (sortKey === "no") return 0;
      if (sortKey === "approveDate") { av = a.approveDate ?? ""; bv = b.approveDate ?? ""; }
      else if (sortKey === "expenseType") { av = a.expenseType; bv = b.expenseType; }
      else if (sortKey === "contractNo") { av = a.contractNo; bv = b.contractNo; }
      else if (sortKey === "amount") { av = a.amount; bv = b.amount; }
      else if (sortKey === "updatedBy") { av = (a as any).updatedBy ?? ""; bv = (b as any).updatedBy ?? ""; }
      else if (sortKey === "updatedAt") { av = (a as any).updatedAt ?? ""; bv = (b as any).updatedAt ?? ""; }
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

  const clearAll = () => {
    setSearchInput(""); setSearch("");
    setDateFrom(""); setDateTo("");
    setUpdatedBy("");
    setPage(1);
  };

  const filterCount = [search, dateFrom, dateTo, updatedBy].filter(Boolean).length;

  const handleExport = useCallback(async () => {
    const toastId = toast.loading("กำลัง Export...");
    try {
      const { data: exp } = await refetchExport();
      const exportRows = exp?.rows ?? [];
      const wsData = [
        ["No.", "วันที่อนุมัติ", "ประเภท", "เลขที่สัญญา", "ยอดเงิน", "ทำรายการโดย", "ทำรายการเมื่อ"],
        ...exportRows.map((r, i) => [
          i + 1, fmtDate(r.approveDate), r.expenseType, r.contractNo,
          r.amount, (r as any).updatedBy ?? "", fmtDateTime((r as any).updatedAt),
        ]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws["!cols"] = [{ wch: 6 }, { wch: 14 }, { wch: 18 }, { wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 20 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "รายจ่าย");
      XLSX.writeFile(wb, `รายจ่าย_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  }, [refetchExport, section]);

  const handleExportYearly = () => {
    const rows2 = yearlyData ?? [];
    if (!rows2.length) { toast.error("ไม่มีข้อมูล"); return; }
    const wsData = [
      ["ปี", "ค่าคอมมิชชั่น", "รวม"],
      ...rows2.map((r) => [parseInt(r.period, 10) + 543, r["ค่าคอมมิชชั่น"], r.total]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 8 }, { wch: 18 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "สรุปรายปี");
    XLSX.writeFile(wb, `รายจ่าย_สรุปรายปี_${section}.xlsx`);
  };

  const handleExportMonthly = () => {
    const rows2 = monthlyData ?? [];
    if (!rows2.length) { toast.error("ไม่มีข้อมูล"); return; }
    const wsData = [
      ["เดือน-ปี", "ค่าคอมมิชชั่น", "รวม"],
      ...rows2.map((r) => [fmtMonthYear(r.period), r["ค่าคอมมิชชั่น"], r.total]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 14 }, { wch: 18 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "สรุปรายเดือน");
    XLSX.writeFile(wb, `รายจ่าย_สรุปรายเดือน_${section}.xlsx`);
  };

  const yearOptions = useMemo(() => {
    const years: number[] = [];
    for (let y = currentYear; y >= currentYear - 5; y--) years.push(y);
    return years;
  }, [currentYear]);

  const toggleMonth = (m: number) => {
    setMonthlyMonths((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  };

  const tabCls = (t: ActiveTab) => [
    "px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
    activeTab === t
      ? "border-red-600 text-red-600"
      : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
  ].join(" ");

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

        {/* ── Header: ชื่อเมนู + Tab bar + Export ── */}
        <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 pt-3 border-b border-gray-200 bg-white">
          <div className="flex items-end gap-4">
            <h1 className="text-lg font-semibold text-gray-800 shrink-0 pb-2">รายจ่าย</h1>
            <div className="flex items-end gap-0 flex-1 overflow-x-auto">
              <button className={tabCls("yearly")} onClick={() => setActiveTab("yearly")}>สรุปรายปี</button>
              <button className={tabCls("monthly")} onClick={() => setActiveTab("monthly")}>สรุปรายเดือน</button>
              <button className={tabCls("all")} onClick={() => setActiveTab("all")}>รายการค่าคอมมิชชั่น</button>
            </div>
            {canExport && activeTab === "all" && (
              <button onClick={handleExport}
                className="flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors shrink-0 mb-1">
                <Download className="w-4 h-4" /><span className="hidden sm:inline">Export Excel</span>
              </button>
            )}
            {canExport && activeTab === "yearly" && (
              <button onClick={handleExportYearly}
                className="flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors shrink-0 mb-1">
                <Download className="w-4 h-4" /><span className="hidden sm:inline">Export Excel</span>
              </button>
            )}
            {canExport && activeTab === "monthly" && (
              <button onClick={handleExportMonthly}
                className="flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors shrink-0 mb-1">
                <Download className="w-4 h-4" /><span className="hidden sm:inline">Export Excel</span>
              </button>
            )}
          </div>
        </div>

        {/* ══ TAB: สรุปรายปี ══ */}
        {activeTab === "yearly" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2 bg-white border-b border-gray-200 shadow-sm">
              <span className="text-xs text-gray-500 whitespace-nowrap">ปี:</span>
              <select value={yearlyYear} onChange={(e) => setYearlyYear(e.target.value)}
                className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500">
                <option value="">ทั้งหมด</option>
                {yearOptions.map((y) => <option key={y} value={String(y)}>{y + 543}</option>)}
              </select>
              {yearlyYear && (
                <button type="button" onClick={() => setYearlyYear("")}
                  className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2">
                {yearlyLoading ? (
                  <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-red-500" /></div>
                ) : !yearlyData || yearlyData.length === 0 ? (
                  <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-red-700 text-white text-xs">
                        {[
                          { label: "ปี", cls: "w-20 text-left" },
                          { label: "ค่าคอมมิชชั่น", cls: "text-right" },
                          { label: "รวม", cls: "text-right font-bold" },
                        ].map(({ label, cls }) => (
                          <th key={label} className={`px-4 py-2.5 font-medium whitespace-nowrap ${cls}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyData.map((row, idx) => (
                        <tr key={row.period} className={`border-b border-gray-100 hover:bg-red-50 transition-colors ${idx % 2 === 1 ? "bg-gray-50" : ""}`}>
                          <td className="px-4 py-2.5 font-semibold text-gray-800">{parseInt(row.period, 10) + 543}</td>
                          <td className="px-4 py-2.5 text-right text-red-700">{fmtMoney(row["ค่าคอมมิชชั่น"])}</td>
                          <td className="px-4 py-2.5 text-right font-bold text-gray-900">{fmtMoney(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold text-sm">
                        <td className="px-4 py-2.5 text-gray-700">รวมทั้งหมด</td>
                        <td className="px-4 py-2.5 text-right text-red-700">{fmtMoney(yearlyData.reduce((s, r) => s + r["ค่าคอมมิชชั่น"], 0))}</td>
                        <td className="px-4 py-2.5 text-right text-gray-900">{fmtMoney(yearlyData.reduce((s, r) => s + r.total, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ TAB: สรุปรายเดือน ══ */}
        {activeTab === "monthly" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2 bg-white border-b border-gray-200 shadow-sm">
              <span className="text-xs text-gray-500 whitespace-nowrap">ปี:</span>
              <select value={monthlyYear} onChange={(e) => setMonthlyYear(e.target.value)}
                className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500">
                <option value="">ทั้งหมด</option>
                {yearOptions.map((y) => <option key={y} value={String(y)}>{y + 543}</option>)}
              </select>
              <span className="text-xs text-gray-500 whitespace-nowrap ml-2">เดือน:</span>
              <div className="flex flex-wrap gap-1">
                {MONTH_NAMES.map((name, idx) => {
                  const m = idx + 1;
                  const isOn = monthlyMonths.has(m);
                  return (
                    <button key={m} type="button" onClick={() => toggleMonth(m)}
                      className={[
                        "px-2 py-1 rounded text-xs font-medium border transition-colors",
                        isOn ? "bg-red-600 text-white border-red-600" : "bg-white text-gray-600 border-gray-200 hover:border-red-400 hover:text-red-600",
                      ].join(" ")}>
                      {name}
                    </button>
                  );
                })}
                {monthlyMonths.size > 0 && (
                  <button type="button" onClick={() => setMonthlyMonths(new Set())}
                    className="flex items-center gap-0.5 px-2 py-1 rounded text-xs text-red-500 border border-red-200 hover:bg-red-50">
                    <X className="w-3 h-3" /> ล้าง
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2">
                {monthlyLoading ? (
                  <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-red-500" /></div>
                ) : !monthlyData || monthlyData.length === 0 ? (
                  <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-red-700 text-white text-xs">
                        {[
                          { label: "เดือน-ปี", cls: "w-28 text-left" },
                          { label: "ค่าคอมมิชชั่น", cls: "text-right" },
                          { label: "รวม", cls: "text-right font-bold" },
                        ].map(({ label, cls }) => (
                          <th key={label} className={`px-4 py-2.5 font-medium whitespace-nowrap ${cls}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyData.map((row, idx) => (
                        <tr key={row.period} className={`border-b border-gray-100 hover:bg-red-50 transition-colors ${idx % 2 === 1 ? "bg-gray-50" : ""}`}>
                          <td className="px-4 py-2.5 font-semibold text-gray-800 whitespace-nowrap">{fmtMonthYear(row.period)}</td>
                          <td className="px-4 py-2.5 text-right text-red-700">{fmtMoney(row["ค่าคอมมิชชั่น"])}</td>
                          <td className="px-4 py-2.5 text-right font-bold text-gray-900">{fmtMoney(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold text-sm">
                        <td className="px-4 py-2.5 text-gray-700">รวมทั้งหมด</td>
                        <td className="px-4 py-2.5 text-right text-red-700">{fmtMoney(monthlyData.reduce((s, r) => s + r["ค่าคอมมิชชั่น"], 0))}</td>
                        <td className="px-4 py-2.5 text-right text-gray-900">{fmtMoney(monthlyData.reduce((s, r) => s + r.total, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ TAB: รายการทั้งหมด ══ */}
        {activeTab === "all" && (
          <>
            {/* Filter bar */}
            <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 pb-3 pt-2 flex flex-wrap items-center gap-2 bg-white border-b border-gray-200 shadow-sm">
              <div className="relative flex items-center">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="ค้นหาสัญญา / ลูกค้า"
                  className="h-9 pl-8 pr-8 rounded-md border border-gray-200 bg-white text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 w-[200px]" />
                {searchInput && (
                  <button type="button" onClick={() => setSearchInput("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5 text-gray-400" />
                <span className="text-xs text-gray-500 whitespace-nowrap">วันที่อนุมัติ:</span>
              </div>
              <div className="flex items-center gap-1">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500 w-[140px]" />
                <span className="text-gray-400 text-xs">–</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                  className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500 w-[140px]" />
                {(dateFrom || dateTo) && (
                  <button type="button" onClick={() => { setDateFrom(""); setDateTo(""); }}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500 whitespace-nowrap">ทำรายการโดย:</span>
                <div className="relative flex items-center">
                  <User className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <select value={updatedBy} onChange={(e) => setUpdatedBy(e.target.value)}
                    className="h-9 pl-8 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500 w-[180px] appearance-none">
                    <option value="">ทั้งหมด</option>
                    {(updatedByList ?? []).map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  {updatedBy && (
                    <button type="button" onClick={() => setUpdatedBy("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              {filterCount > 0 && (
                <button type="button" onClick={clearAll}
                  className="flex items-center gap-1 h-8 px-2.5 text-xs font-medium rounded-md border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
                  <X className="w-3 h-3" />ล้างทั้งหมด
                  <span className="inline-flex items-center justify-center bg-red-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{filterCount}</span>
                </button>
              )}
            </div>
            {/* Summary bar */}
            <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2 bg-gray-50 border-b border-gray-100">
              <span className="text-sm text-gray-500">{total.toLocaleString()} รายการ</span>
              <div className="flex-1" />
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-600 text-white">
                <span>ค่าคอมมิชชั่น</span>
                <span>{fmtMoney(totalAmount)}</span>
              </div>
            </div>
            {/* Table */}
            <div className="flex-1 overflow-auto">
              <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2">
                {isLoading ? (
                  <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-red-500" /></div>
                ) : error ? (
                  <div className="flex items-center justify-center py-20 text-red-500 text-sm">เกิดข้อผิดพลาด: {error.message}</div>
                ) : sortedRows.length === 0 ? (
                  <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-red-700 text-white text-xs sticky top-0 z-10">
                        {([
                          { key: "no" as SortKey, label: "No.", cls: "w-10 text-center" },
                          { key: "approveDate" as SortKey, label: "วันที่อนุมัติ", cls: "w-28" },
                          { key: "expenseType" as SortKey, label: "ประเภท", cls: "w-28" },
                          { key: "contractNo" as SortKey, label: "เลขที่สัญญา", cls: "w-36" },
                          { key: "amount" as SortKey, label: "ยอดเงิน", cls: "w-28 text-right" },
                          { key: "updatedBy" as SortKey, label: "ทำรายการโดย", cls: "w-32" },
                          { key: "updatedAt" as SortKey, label: "ทำรายการเมื่อ", cls: "w-36" },
                        ] as { key: SortKey; label: string; cls: string }[]).map(({ key, label, cls }) => (
                          <th key={key} onClick={() => key !== "no" && handleSort(key)}
                            className={["px-3 py-2.5 font-medium text-left whitespace-nowrap select-none",
                              key !== "no" ? "cursor-pointer hover:bg-red-600" : "", cls].join(" ")}>
                            <div className="flex items-center gap-1">
                              {label}{key !== "no" && <SortIcon col={key} />}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row, idx) => {
                        const globalIdx = (page - 1) * pageSize + idx + 1;
                        return (
                          <tr key={`${row.contractNo}-${idx}`} className="border-b border-gray-100 hover:bg-red-50 transition-colors">
                            <td className="px-3 py-2 text-center text-gray-400 text-xs">{globalIdx}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtDate(row.approveDate)}</td>
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                {row.expenseType}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.contractNo}</td>
                            <td className="px-3 py-2 text-right font-semibold text-gray-800">{fmtMoney(row.amount)}</td>
                            <td className="px-3 py-2 text-gray-600 text-xs">{(row as any).updatedBy ?? "-"}</td>
                            <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtDateTime((row as any).updatedAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            {/* Pagination */}
            {total > 0 && (
              <div className="border-t border-gray-200 bg-white">
                <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-3 flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 text-sm text-gray-500 mr-auto">
                    <span>แสดง</span>
                    <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                      className="h-8 px-2 rounded border border-gray-200 text-sm">
                      {[50, 100, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <span>รายการ / หน้า &nbsp;|&nbsp; รวม {total.toLocaleString()} รายการ</span>
                  </div>
                  <Pagination className="w-auto mx-0">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }}
                          className={page <= 1 ? "pointer-events-none opacity-40" : ""} />
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
                            <PaginationLink href="#" isActive={p === page}
                              onClick={(e) => { e.preventDefault(); setPage(p); }}>{p}</PaginationLink>
                          </PaginationItem>
                        );
                      })}
                      <PaginationItem>
                        <PaginationNext href="#" onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1); }}
                          className={page >= totalPages ? "pointer-events-none opacity-40" : ""} />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

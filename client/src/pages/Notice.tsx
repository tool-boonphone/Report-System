/**
 * Notice.tsx — หน้าระบบหนังสือแจ้งเตือน (Notice)
 *
 * Phase 1 (อ่านอย่างเดียว):
 *  - การ์ดสรุป: รายการเข้าเงื่อนไข (ค้างชำระ ≥ 60 วัน) + ได้เครื่องคืนแล้ว
 *  - แถบฟิลเตอร์: ค้นหา / จำนวนครั้งที่ส่ง / ช่วงวันอนุมัติ / ช่วงวันค้างชำระ / สถานะคืนเครื่อง
 *  - ตารางรายการ: วันที่อนุมัติ, เลขที่สัญญา, ชื่อ-นามสกุล, ค้างชำระ(วัน), ส่งแล้ว, สถานะ
 *  - Pagination 10 รายการ/หน้า (server-side)
 *
 * ยังไม่รวม (รอเฟสถัดไป): การพิมพ์ PDF + Excel จ่าหน้าซอง, Log การพิมพ์/แก้ไข,
 * การ Restore รอบล่าสุด และ Modal สถิติรายเดือน
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SectionKey } from "@shared/const";
import { AppShell } from "@/components/AppShell";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import {
  CalendarDays, ChevronDown, ChevronUp, ChevronsUpDown, Search, X,
} from "lucide-react";
import {
  Pagination, PaginationContent, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";

type SortField = "approveDate" | "overdueDays";
type SortDir = "asc" | "desc";
type ReturnedFilter = "all" | "hide" | "only";
type SentFilter = "all" | "0" | "1" | "2" | "3";

const MAX_NOTICE_ROUNDS = 3;

function fmtDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function Notice() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("notice", "view");

  // ── Filter state ──
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sentFilter, setSentFilter] = useState<SentFilter>("all");
  const [returnedFilter, setReturnedFilter] = useState<ReturnedFilter>("all");
  const [approveFrom, setApproveFrom] = useState("");
  const [approveTo, setApproveTo] = useState("");
  const [overdueMin, setOverdueMin] = useState("");
  const [overdueMax, setOverdueMax] = useState("");

  // ── Sort / pagination ──
  const [sortField, setSortField] = useState<SortField>("approveDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const pageSize = 10;

  // ── Debounce search ──
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [search, sentFilter, returnedFilter, approveFrom, approveTo, overdueMin, overdueMax, sortField, sortDir]);

  const filters = useMemo(
    () => ({
      search: search || undefined,
      returned: returnedFilter,
      approveDateFrom: approveFrom || undefined,
      approveDateTo: approveTo || undefined,
      overdueMin: overdueMin ? Math.max(60, parseInt(overdueMin, 10) || 0) : undefined,
      overdueMax: overdueMax ? parseInt(overdueMax, 10) || undefined : undefined,
    }),
    [search, returnedFilter, approveFrom, approveTo, overdueMin, overdueMax],
  );

  const sectionKey = (section ?? "Boonphone") as SectionKey;

  const { data: listData, isLoading, error } = trpc.notice.list.useQuery(
    {
      section: sectionKey,
      filters,
      sort: { field: sortField, dir: sortDir },
      page,
      pageSize,
    },
    { enabled: !!section && canView },
  );

  const { data: summaryData } = trpc.notice.summary.useQuery(
    { section: sectionKey, filters },
    { enabled: !!section && canView },
  );

  const rows = listData?.rows ?? [];
  const total = listData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // sentFilter เป็น client-side guard — Phase 1 ทุกรายการมีค่า sentCount = 0
  const displayRows = useMemo(() => {
    if (sentFilter === "all") return rows;
    const target = parseInt(sentFilter, 10);
    return rows.filter((r) => r.sentCount === target);
  }, [rows, sentFilter]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir(field === "approveDate" ? "desc" : "desc"); }
  };
  const SortIcon = ({ col }: { col: SortField }) => {
    if (col !== sortField) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  const filterCount = [
    search, approveFrom, approveTo, overdueMin, overdueMax,
    sentFilter !== "all" ? "sent" : "",
    returnedFilter !== "all" ? "returned" : "",
  ].filter(Boolean).length;

  const clearAll = () => {
    setSearchInput(""); setSearch("");
    setSentFilter("all"); setReturnedFilter("all");
    setApproveFrom(""); setApproveTo("");
    setOverdueMin(""); setOverdueMax("");
    setPage(1);
  };

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

        {/* ── Summary cards ── */}
        <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 pt-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
              <div className="text-xs text-gray-500">รายการเข้าเงื่อนไข</div>
              <div className="mt-1 text-2xl font-bold text-blue-700">
                {(summaryData?.eligible ?? 0).toLocaleString()}
              </div>
              <div className="text-[11px] text-gray-400">ค้างชำระตั้งแต่ 60 วันขึ้นไป</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
              <div className="text-xs text-gray-500">ได้เครื่องคืนแล้ว</div>
              <div className="mt-1 text-2xl font-bold text-green-700">
                {(summaryData?.returned ?? 0).toLocaleString()}
              </div>
              <div className="text-[11px] text-gray-400">ระงับสัญญา (ล็อกไม่ให้พิมพ์)</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm hidden sm:block">
              <div className="text-xs text-gray-500">แสดงตามฟิลเตอร์</div>
              <div className="mt-1 text-2xl font-bold text-gray-800">
                {total.toLocaleString()}
              </div>
              <div className="text-[11px] text-gray-400">รายการที่ตรงเงื่อนไขการค้นหา</div>
            </div>
          </div>
        </div>

        {/* ── Header ── */}
        <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 pt-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h1 className="text-lg font-semibold text-gray-800">รายการเข้าเงื่อนไขส่ง Notice</h1>
              <p className="text-xs text-gray-400">แสดงเฉพาะลูกค้าค้างชำระตั้งแต่ 60 วันขึ้นไป</p>
            </div>
          </div>
        </div>

        {/* ── Filter bar ── */}
        <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 pb-3 pt-2 flex flex-wrap items-center gap-2">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
            <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              placeholder="ชื่อ-นามสกุล / เลขที่สัญญา"
              className="h-9 pl-8 pr-8 rounded-md border border-gray-200 bg-white text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[220px]" />
            {searchInput && (
              <button type="button" onClick={() => setSearchInput("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 whitespace-nowrap">ส่งแล้ว:</span>
            <select value={sentFilter} onChange={(e) => setSentFilter(e.target.value as SentFilter)}
              className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="all">ทั้งหมด</option>
              <option value="0">ยังไม่เคยส่ง</option>
              <option value="1">ส่งแล้ว 1 ครั้ง</option>
              <option value="2">ส่งแล้ว 2 ครั้ง</option>
              <option value="3">ส่งครบ 3 ครั้ง</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 whitespace-nowrap">คืนเครื่อง:</span>
            <select value={returnedFilter} onChange={(e) => setReturnedFilter(e.target.value as ReturnedFilter)}
              className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="all">แสดงทั้งหมด</option>
              <option value="hide">ไม่แสดงที่คืนแล้ว</option>
              <option value="only">เฉพาะที่คืนแล้ว</option>
            </select>
          </div>

          <div className="flex items-center gap-1">
            <CalendarDays className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs text-gray-500 whitespace-nowrap">อนุมัติ:</span>
            <input type="date" value={approveFrom} onChange={(e) => setApproveFrom(e.target.value)}
              className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[140px]" />
            <span className="text-gray-400 text-xs">–</span>
            <input type="date" value={approveTo} onChange={(e) => setApproveTo(e.target.value)}
              className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[140px]" />
          </div>

          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 whitespace-nowrap">ค้าง(วัน):</span>
            <input type="number" min={60} value={overdueMin} onChange={(e) => setOverdueMin(e.target.value)}
              placeholder="60"
              className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[80px]" />
            <span className="text-gray-400 text-xs">–</span>
            <input type="number" min={60} value={overdueMax} onChange={(e) => setOverdueMax(e.target.value)}
              placeholder="∞"
              className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[80px]" />
          </div>

          {filterCount > 0 && (
            <button type="button" onClick={clearAll}
              className="flex items-center gap-1 h-8 px-2.5 text-xs font-medium rounded-md border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
              <X className="w-3 h-3" />ล้างทั้งหมด
              <span className="inline-flex items-center justify-center bg-red-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{filterCount}</span>
            </button>
          )}
        </div>

        {/* ── Table ── */}
        <div className="flex-1 overflow-auto">
          <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-blue-500" /></div>
            ) : error ? (
              <div className="flex items-center justify-center py-20 text-red-500 text-sm">เกิดข้อผิดพลาด: {error.message}</div>
            ) : displayRows.length === 0 ? (
              <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-blue-700 text-white text-xs sticky top-0 z-10">
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap text-center w-10">
                      <input type="checkbox" disabled title="การพิมพ์จะเปิดใช้งานในเฟสถัดไป" className="opacity-50 cursor-not-allowed" />
                    </th>
                    <th onClick={() => handleSort("approveDate")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-left w-28">
                      <div className="flex items-center gap-1">วันที่อนุมัติ<SortIcon col="approveDate" /></div>
                    </th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap text-left w-44">เลขที่สัญญา</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap text-left">ชื่อ-นามสกุล</th>
                    <th onClick={() => handleSort("overdueDays")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-right w-32">
                      <div className="flex items-center justify-end gap-1">ค้างชำระ(วัน)<SortIcon col="overdueDays" /></div>
                    </th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap text-center w-40">ส่งแล้ว</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap text-left w-36">สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, idx) => {
                    const rowNo = (page - 1) * pageSize + idx + 1;
                    return (
                      <tr key={row.id}
                        className={[
                          "border-b border-gray-100 transition-colors",
                          row.isReturned ? "bg-green-50/60 hover:bg-green-50" : "hover:bg-blue-50",
                        ].join(" ")}>
                        <td className="px-3 py-2 text-center">
                          <input type="checkbox" disabled
                            title={row.isReturned ? "ได้เครื่องคืนแล้ว — พิมพ์ไม่ได้" : "การพิมพ์จะเปิดใช้งานในเฟสถัดไป"}
                            className="opacity-50 cursor-not-allowed" />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtDate(row.approveDate)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.contractNo}</td>
                        <td className="px-3 py-2 text-gray-800">{row.customerName ?? "-"}</td>
                        <td className="px-3 py-2 text-right font-semibold text-gray-800">
                          {row.overdueDays != null ? row.overdueDays.toLocaleString() : "-"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-xs text-gray-500">{row.sentCount}/{MAX_NOTICE_ROUNDS} ครั้ง</span>
                            <div className="flex items-center gap-1">
                              {[1, 2, 3].map((n) => (
                                <span key={n}
                                  className={[
                                    "inline-flex items-center justify-center w-5 h-5 rounded text-[11px] font-medium",
                                    n <= row.sentCount ? "bg-green-500 text-white" : "bg-gray-100 text-gray-400",
                                  ].join(" ")}>
                                  {n}
                                </span>
                              ))}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {row.isReturned ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                              ได้เครื่องคืนแล้ว
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">รอส่ง Notice</span>
                          )}
                        </td>
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
          <div className="border-t border-gray-200 bg-white">
            <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-sm text-gray-500 mr-auto">
                <span>รวม {total.toLocaleString()} รายการ — หน้า {page}/{totalPages}</span>
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
      </div>
    </AppShell>
  );
}

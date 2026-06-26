/**
 * Notice.tsx — หน้าระบบหนังสือแจ้งเตือน (Notice)
 *
 * UI อิงจาก mockup `notice_printing_dashboard_v12.html`:
 *  - การ์ดสรุป 5 ใบ (เข้าเงื่อนไข / ยังไม่เคยส่ง / ส่ง 1-2 ครั้ง / ส่งครบ 3 / ได้เครื่องคืน)
 *  - แถบฟิลเตอร์ + ปุ่ม "ดูสถิติรายเดือน"
 *  - แถบปุ่มพิมพ์รายการที่เลือก + ล้างรายการ + ตัวนับที่เลือก
 *  - ตาราง 8 คอลัมน์: checkbox, วันที่อนุมัติ, เลขที่สัญญา, ชื่อ-นามสกุล,
 *    ค้างชำระ(วัน), ส่งแล้ว (badge + round dots + restore), Log การพิมพ์, Log การแก้ไข
 *  - Pagination 10 รายการ/หน้า (server-side)
 *
 * Phase 1 (อ่านอย่างเดียว): ยังไม่มีตาราง log จึงแสดง sentCount = 0 ทุกแถว
 * การพิมพ์ PDF/Excel, การนับรอบ, Restore และ Modal สถิติ จะทำในเฟสถัดไป
 * — ปุ่มที่เกี่ยวข้องจึงแสดงผลแต่ยังไม่ทำงานจริง (แจ้งเตือนว่ารอเฟสถัดไป)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SectionKey } from "@shared/const";
import { AppShell } from "@/components/AppShell";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import { BarChart3, Printer, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";

type SortField = "approveDate" | "overdueDays";
type SortDir = "asc" | "desc";
type ReturnedFilter = "all" | "hide" | "only";
type SentFilter = "all" | "0" | "1" | "2" | "3";

const MAX_NOTICE_ROUNDS = 3;
const PAGE_SIZE = 10;

function fmtDateOnly(s: string | null | undefined): string {
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

  // ── Sort / pagination / selection ──
  const [sortField, setSortField] = useState<SortField>("approveDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
      pageSize: PAGE_SIZE,
    },
    { enabled: !!section && canView },
  );

  const { data: summaryData } = trpc.notice.summary.useQuery(
    { section: sectionKey, filters },
    { enabled: !!section && canView },
  );

  const rows = listData?.rows ?? [];
  const total = listData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // sentFilter เป็น client-side guard — Phase 1 ทุกรายการมีค่า sentCount = 0
  const displayRows = useMemo(() => {
    if (sentFilter === "all") return rows;
    const target = parseInt(sentFilter, 10);
    return rows.filter((r) => r.sentCount === target);
  }, [rows, sentFilter]);

  // ── Metrics (Phase 1: รายการ active ทั้งหมดยังไม่เคยส่ง) ──
  const metrics = useMemo(() => {
    const eligible = summaryData?.eligible ?? 0;
    const returned = summaryData?.returned ?? 0;
    const active = Math.max(0, eligible - returned);
    return {
      eligible,
      returned,
      never: active,   // Phase 1: active ทุกรายการ sentCount = 0
      inProgress: 0,   // Phase 2 จะคำนวณจาก log จริง
      maxed: 0,
    };
  }, [summaryData]);

  // ── Selection helpers ──
  const isSelectable = (r: { isReturned: boolean; sentCount: number }) =>
    !r.isReturned && r.sentCount < MAX_NOTICE_ROUNDS;

  const selectableOnPage = displayRows.filter(isSelectable);
  const allOnPageSelected = selectableOnPage.length > 0 && selectableOnPage.every((r) => selected.has(r.externalId));

  const toggleOne = (key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  };
  const toggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      selectableOnPage.forEach((r) => { if (checked) next.add(r.externalId); else next.delete(r.externalId); });
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const handlePrint = () => {
    if (selected.size === 0) { toast.error("กรุณาเลือกรายการก่อน"); return; }
    toast.info("การพิมพ์ PDF + Excel จ่าหน้าซองจะเปิดใช้งานในเฟสถัดไป");
  };
  const handleStats = () => {
    toast.info("สถิติรายเดือนจะเปิดใช้งานในเฟสถัดไป");
  };
  const handleRestore = () => {
    toast.info("การ Restore รอบล่าสุดจะเปิดใช้งานในเฟสถัดไป");
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("desc"); }
  };
  const sortMark = (field: SortField) =>
    sortField === field ? (sortDir === "asc" ? "▲" : "▼") : "";

  const inputCls =
    "w-full h-10 px-3 rounded-xl border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/15";
  const labelCls = "block text-xs font-bold text-gray-700 mb-1.5";

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
    <AppShell>
      <div className="max-w-[1500px] mx-auto w-full px-3 sm:px-5 py-5">

        {/* ── Metrics ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3.5 mb-3.5">
          {[
            { label: "เข้าเงื่อนไข 60 วันขึ้นไป", value: metrics.eligible, hint: "ค้างชำระตั้งแต่ 60 วัน", color: "text-gray-900" },
            { label: "ยังไม่เคยส่ง", value: metrics.never, hint: "เฉพาะรายการที่ยังพิมพ์ได้", color: "text-gray-900" },
            { label: "ส่งแล้ว 1-2 ครั้ง", value: metrics.inProgress, hint: "ยังส่งรอบถัดไปได้", color: "text-gray-900" },
            { label: "ส่งครบ 3 ครั้ง", value: metrics.maxed, hint: "ระบบจะไม่ให้พิมพ์ซ้ำ", color: "text-gray-900" },
            { label: "ได้เครื่องคืนแล้ว", value: metrics.returned, hint: "แสดงในตาราง แต่พิมพ์ไม่ได้", color: "text-green-700" },
          ].map((m) => (
            <div key={m.label} className="bg-white border border-gray-200 rounded-[18px] p-4 shadow-[0_8px_20px_rgba(15,23,42,.04)]">
              <div className="text-[13px] text-gray-500">{m.label}</div>
              <div className={`text-[28px] font-extrabold mt-1.5 ${m.color}`}>{m.value.toLocaleString()}</div>
              <div className="text-xs text-gray-400 mt-1">{m.hint}</div>
            </div>
          ))}
        </div>

        {/* ── Panel ── */}
        <section className="bg-white border border-gray-200 rounded-[18px] shadow-[0_12px_30px_rgba(15,23,42,.08)] overflow-hidden">

          {/* Panel head */}
          <div className="px-4 sm:px-[18px] py-4 border-b border-gray-200 flex items-start justify-between gap-3.5 flex-wrap">
            <div>
              <div className="text-lg font-extrabold text-gray-900">รายการเข้าเงื่อนไขส่ง Notice</div>
              <div className="mt-1 text-gray-500 text-sm">แสดงเฉพาะลูกค้าค้างชำระตั้งแต่ 60 วันขึ้นไป</div>
            </div>
            <button onClick={handleStats}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-indigo-50 text-indigo-800 hover:bg-indigo-100 transition-colors">
              <BarChart3 className="w-4 h-4" /> ดูสถิติรายเดือน
            </button>
          </div>

          {/* Filters */}
          <div className="px-4 sm:px-[18px] py-4 border-b border-gray-200 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            <div className="xl:col-span-2">
              <label className={labelCls}>ค้นหา</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="ชื่อ-นามสกุล / เลขที่สัญญา" className={inputCls + " pl-8"} />
              </div>
            </div>
            <div>
              <label className={labelCls}>ส่งแล้วกี่ครั้ง</label>
              <select value={sentFilter} onChange={(e) => setSentFilter(e.target.value as SentFilter)} className={inputCls}>
                <option value="all">ทั้งหมด</option>
                <option value="0">ยังไม่เคยส่ง</option>
                <option value="1">ส่งแล้ว 1 ครั้ง</option>
                <option value="2">ส่งแล้ว 2 ครั้ง</option>
                <option value="3">ส่งครบ 3 ครั้ง</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>อนุมัติตั้งแต่</label>
              <input type="date" value={approveFrom} onChange={(e) => setApproveFrom(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>อนุมัติถึง</label>
              <input type="date" value={approveTo} onChange={(e) => setApproveTo(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>ค้างชำระตั้งแต่</label>
              <input type="number" min={60} value={overdueMin} onChange={(e) => setOverdueMin(e.target.value)} placeholder="เช่น 60" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>ค้างชำระถึง</label>
              <input type="number" min={60} value={overdueMax} onChange={(e) => setOverdueMax(e.target.value)} placeholder="เช่น 180" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>สถานะได้เครื่องคืน</label>
              <select value={returnedFilter} onChange={(e) => setReturnedFilter(e.target.value as ReturnedFilter)} className={inputCls}>
                <option value="all">แสดง</option>
                <option value="hide">ไม่แสดง</option>
                <option value="only">แสดงเฉพาะได้เครื่องคืน</option>
              </select>
            </div>
          </div>

          {/* Actions */}
          <div className="px-4 sm:px-[18px] py-3.5 border-b border-gray-200 flex items-center gap-2.5 flex-wrap">
            <button onClick={handlePrint}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors">
              <Printer className="w-4 h-4" /> พิมพ์รายการที่เลือก
            </button>
            <button onClick={clearSelection}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-gray-100 text-gray-900 hover:bg-gray-200 transition-colors">
              ล้างรายการที่เลือก
            </button>
            <span className="ml-auto text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-full px-3 py-2">
              เลือก {selected.size} รายการ
            </span>
          </div>

          {/* Table */}
          <div className="overflow-auto max-h-[620px]">
            {isLoading ? (
              <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-orange-500" /></div>
            ) : error ? (
              <div className="py-7 text-center text-red-500 text-sm">เกิดข้อผิดพลาด: {error.message}</div>
            ) : displayRows.length === 0 ? (
              <div className="py-7 text-center text-gray-400 text-sm">ไม่พบรายการตามเงื่อนไขที่กรอง</div>
            ) : (
              <table className="w-full border-separate border-spacing-0 min-w-[1100px]">
                <thead>
                  <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:bg-[#fafafa] [&>th]:z-[2] [&>th]:text-xs [&>th]:text-gray-700 [&>th]:font-bold [&>th]:text-left [&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-3 [&>th]:border-b [&>th]:border-gray-200">
                    <th className="!text-center !w-[42px]">
                      <input type="checkbox" checked={allOnPageSelected}
                        onChange={(e) => toggleAll(e.target.checked)}
                        className="accent-orange-500 cursor-pointer" />
                    </th>
                    <th className="w-[108px]">
                      <button onClick={() => handleSort("approveDate")} className="font-bold text-gray-700 hover:text-orange-500">
                        วันที่อนุมัติ <span className="text-orange-500 font-black">{sortMark("approveDate")}</span>
                      </button>
                    </th>
                    <th className="w-[190px]">เลขที่สัญญา</th>
                    <th className="w-[180px]">ชื่อ-นามสกุล</th>
                    <th className="w-[106px]">
                      <button onClick={() => handleSort("overdueDays")} className="font-bold text-gray-700 hover:text-orange-500">
                        ค้างชำระ(วัน) <span className="text-orange-500 font-black">{sortMark("overdueDays")}</span>
                      </button>
                    </th>
                    <th className="w-[255px]">ส่งแล้ว</th>
                    <th className="w-[260px]">Log การพิมพ์</th>
                    <th className="w-[200px]">Log การแก้ไข</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => {
                    const disabled = !isSelectable(row);
                    const done = row.sentCount;
                    const sentBadgeCls =
                      done >= MAX_NOTICE_ROUNDS ? "bg-emerald-50 text-emerald-700"
                        : done === 0 ? "bg-gray-100 text-gray-700"
                          : "bg-blue-50 text-blue-700";
                    const currentRound = row.isReturned || done >= MAX_NOTICE_ROUNDS ? -1 : done; // index ของรอบถัดไป
                    return (
                      <tr key={row.externalId}
                        className={[
                          "[&>td]:px-3 [&>td]:py-3 [&>td]:border-b [&>td]:border-gray-100 [&>td]:align-top [&>td]:text-[13px]",
                          row.isReturned ? "bg-green-50/70 hover:bg-green-100/70" : "hover:bg-orange-50/70",
                        ].join(" ")}>
                        <td className="!text-center">
                          <input type="checkbox" checked={selected.has(row.externalId)} disabled={disabled}
                            title={disabled ? (row.isReturned ? "ได้เครื่องคืนแล้ว" : "ส่งครบ 3 ครั้งแล้ว") : undefined}
                            onChange={(e) => toggleOne(row.externalId, e.target.checked)}
                            className="accent-orange-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed" />
                        </td>
                        <td className="whitespace-nowrap text-gray-700">{fmtDateOnly(row.approveDate)}</td>
                        <td className="break-words"><strong className="text-gray-900">{row.contractNo}</strong></td>
                        <td className="break-words"><span className="font-extrabold text-gray-900">{row.customerName ?? "-"}</span></td>
                        <td className="whitespace-nowrap">
                          <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold bg-red-50 text-red-700">
                            {row.overdueDays != null ? `${row.overdueDays.toLocaleString()} วัน` : "-"}
                          </span>
                        </td>
                        <td>
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${sentBadgeCls}`}>
                              {done}/{MAX_NOTICE_ROUNDS} ครั้ง
                            </span>
                            <div className="flex items-center gap-1.5">
                              {[0, 1, 2].map((i) => {
                                const isDone = i < done;
                                const isCurrent = i === currentRound;
                                return (
                                  <span key={i}
                                    title={isDone ? `ส่งครั้งที่ ${i + 1} แล้ว` : `รอบ ${i + 1}: ยังไม่เคยส่ง`}
                                    className={[
                                      "inline-grid place-items-center w-6 h-6 rounded-full border text-[11px] font-black",
                                      isDone ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                        : "bg-white text-gray-400 border-gray-200",
                                      isCurrent ? "ring-2 ring-orange-500/15" : "",
                                    ].join(" ")}>
                                    {i + 1}
                                  </span>
                                );
                              })}
                              {done > 0 && (
                                <button onClick={handleRestore} title="ยกเลิกรอบส่งล่าสุด"
                                  className="ml-1 inline-grid place-items-center w-[26px] h-[26px] rounded-full border border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200 text-[15px] font-black">
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="text-gray-600">
                          {done === 0 && !row.isReturned ? (
                            <span className="text-gray-400">ยังไม่มี log</span>
                          ) : (
                            <div className="grid gap-1">
                              {row.isReturned && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold bg-emerald-50 text-emerald-700">
                                    ได้เครื่องคืนแล้ว
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="text-gray-600"><span className="text-gray-400">-</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          <div className="px-4 sm:px-[18px] py-3.5 bg-[#fafafa] border-t border-gray-200 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[13px] text-gray-500">
              {total > 0
                ? `แสดง ${(page - 1) * PAGE_SIZE + 1}-${Math.min(page * PAGE_SIZE, total)} จาก ${total.toLocaleString()} รายการ`
                : "แสดง 0 รายการ"}
            </div>
            {total > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="min-w-[38px] px-2.5 py-2 rounded-xl border border-gray-200 bg-white text-gray-700 text-sm font-bold hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed">
                  ก่อนหน้า
                </button>
                {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                  let p = i + 1;
                  if (totalPages > 7) {
                    if (page <= 4) p = i + 1;
                    else if (page >= totalPages - 3) p = totalPages - 6 + i;
                    else p = page - 3 + i;
                  }
                  return (
                    <button key={p} onClick={() => setPage(p)}
                      className={[
                        "min-w-[38px] px-2.5 py-2 rounded-xl border text-sm font-bold",
                        p === page ? "bg-orange-500 border-orange-500 text-white" : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50",
                      ].join(" ")}>
                      {p}
                    </button>
                  );
                })}
                <button disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="min-w-[38px] px-2.5 py-2 rounded-xl border border-gray-200 bg-white text-gray-700 text-sm font-bold hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed">
                  ถัดไป
                </button>
              </div>
            )}
          </div>

          <div className="px-4 sm:px-[18px] py-3 bg-[#fafafa] text-gray-500 text-xs leading-relaxed border-t border-gray-200">
            หมายเหตุ: การพิมพ์ PDF + Excel จ่าหน้าซอง, การนับรอบส่ง, Log การพิมพ์/แก้ไข และการ Restore
            จะเปิดใช้งานในเฟสถัดไป — ขณะนี้แสดงเฉพาะรายการที่เข้าเงื่อนไขเท่านั้น
          </div>
        </section>
      </div>
    </AppShell>
  );
}

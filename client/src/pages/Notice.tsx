/**
 * Notice.tsx — หน้าระบบหนังสือแจ้งเตือน (Notice)
 *
 * UI อิงจาก mockup `notice_printing_dashboard_v12.html`:
 *  - การ์ดสรุป 5 ใบ (เข้าเงื่อนไข / ยังไม่เคยส่ง / ส่ง 1-2 ครั้ง / ส่งครบ 3 / ได้เครื่องคืน)
 *  - แถบฟิลเตอร์ 8 ช่อง + ปุ่ม "ดูสถิติรายเดือน"
 *  - แถบปุ่มพิมพ์รายการที่เลือก + ล้างรายการ + ตัวนับที่เลือก
 *  - ตาราง 9 คอลัมน์: checkbox, วันที่อนุมัติ, เลขที่สัญญา, ชื่อ-นามสกุล,
 *    ค้างชำระ(วัน), ส่งแล้ว, เลขที่เอกสาร, Log การพิมพ์, Log การแก้ไข
 *  - Pagination เลือกจำนวนแถว/หน้าได้ (server-side)
 *
 * Phase 2: นับรอบส่งจริงจากตาราง log
 *  - sentCount / Log การพิมพ์ / Log การแก้ไข มาจาก notice_print_logs + notice_restore_logs
 *  - ปุ่ม "พิมพ์รายการที่เลือก" บันทึกรอบส่ง (recordPrint) — Phase 3 จะ generate PDF/Excel ก่อน
 *  - ปุ่ม ↺ Restore ยกเลิกรอบล่าสุด (มี popup ยืนยัน)
 *  - Modal สถิติรายเดือน (Phase 4)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SectionKey } from "@shared/const";
import { AppShell } from "@/components/AppShell";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import { BarChart3, Download, Printer, RotateCcw, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";

type SortField = "approveDate" | "overdueDays" | "sentCount";
type SortDir = "asc" | "desc";
type ReturnedFilter = "all" | "hide" | "only";
type SentFilter = "all" | "0" | "1" | "2" | "3";

type PrintLogEntry = { round: number; documentNo: string | null; printedAt: string; printedBy: string };
type RestoreLogEntry = { round: number; restoredAt: string; restoredBy: string };
type NoticeRow = {
  externalId: string;
  contractNo: string;
  approveDate: string | null;
  customerName: string | null;
  overdueDays: number | null;
  isReturned: boolean;
  sentCount: number;
  documentNo: string | null;
  printLogs: PrintLogEntry[];
  restoreLogs: RestoreLogEntry[];
};

const MAX_NOTICE_ROUNDS = 3;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 300, 500, 1000];

function fmtDateOnly(s: string | null | undefined): string {
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

export default function Notice() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("notice", "view");
  const canEdit = can("notice", "edit");
  const canExport = can("notice", "export");
  const utils = trpc.useUtils();

  // ── Filter state ──
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sentFilter, setSentFilter] = useState<SentFilter>("all");
  const [returnedFilter, setReturnedFilter] = useState<ReturnedFilter>("all");
  const [approveFrom, setApproveFrom] = useState("");
  const [approveTo, setApproveTo] = useState("");
  const [overdueMin, setOverdueMin] = useState("");
  const [overdueMax, setOverdueMax] = useState("");
  const [adminFilter, setAdminFilter] = useState("all");

  // ── Sort / pagination / selection ──
  const [sortField, setSortField] = useState<SortField>("approveDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── Restore modal ──
  const [pendingRestore, setPendingRestore] = useState<NoticeRow | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<{
    parsedRows: number;
    toInsert: number;
    skipNoContract: number;
    skipDuplicate: number;
    sample: Array<{ contractNo: string; round: number; documentNo: string }>;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ── Debounce search ──
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [search, sentFilter, returnedFilter, approveFrom, approveTo, overdueMin, overdueMax, adminFilter, sortField, sortDir, pageSize]);

  const filters = useMemo(
    () => ({
      search: search || undefined,
      returned: returnedFilter,
      sent: sentFilter,
      admin: adminFilter !== "all" ? adminFilter : undefined,
      approveDateFrom: approveFrom || undefined,
      approveDateTo: approveTo || undefined,
      overdueMin: overdueMin ? Math.max(60, parseInt(overdueMin, 10) || 0) : undefined,
      overdueMax: overdueMax ? parseInt(overdueMax, 10) || undefined : undefined,
    }),
    [search, returnedFilter, sentFilter, adminFilter, approveFrom, approveTo, overdueMin, overdueMax],
  );

  const sectionKey = (section ?? "Boonphone") as SectionKey;

  const listQuery = trpc.notice.list.useQuery(
    { section: sectionKey, filters, sort: { field: sortField, dir: sortDir }, page, pageSize },
    { enabled: !!section && canView },
  );
  const { data: listData, isLoading, error } = listQuery;

  const { data: summaryData } = trpc.notice.summary.useQuery(
    { section: sectionKey, filters },
    { enabled: !!section && canView },
  );

  const { data: adminOptionsData } = trpc.notice.adminOptions.useQuery(
    { section: sectionKey },
    { enabled: !!section && canView },
  );
  const adminOptions = adminOptionsData ?? [];

  const { data: monthlyStats, isLoading: statsLoading } = trpc.notice.monthlyStats.useQuery(
    { section: sectionKey },
    { enabled: !!section && canView && statsOpen },
  );

  const rows = (listData?.rows ?? []) as NoticeRow[];
  const total = listData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const refetchAll = () => {
    utils.notice.list.invalidate();
    utils.notice.summary.invalidate();
    utils.notice.adminOptions.invalidate();
  };

  const [printing, setPrinting] = useState(false);

  const restoreMut = trpc.notice.restoreLatest.useMutation({
    onSuccess: (res) => {
      setPendingRestore(null);
      refetchAll();
      if (res.ok) toast.success(`ยกเลิกการส่ง Notice รอบที่ ${res.restoredRound} แล้ว`);
      else toast.error(res.message ?? "ยกเลิกไม่สำเร็จ");
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Metrics ──
  const metrics = {
    eligible: summaryData?.eligible ?? 0,
    returned: summaryData?.returned ?? 0,
    never: summaryData?.never ?? 0,
    inProgress: summaryData?.inProgress ?? 0,
    maxed: summaryData?.maxed ?? 0,
  };

  // ── Selection helpers ──
  const isSelectable = (r: NoticeRow) => !r.isReturned && r.sentCount < MAX_NOTICE_ROUNDS;
  const selectableOnPage = rows.filter(isSelectable);
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

  const handlePrint = async () => {
    if (!canEdit) { toast.error("คุณไม่มีสิทธิ์พิมพ์ Notice"); return; }
    if (selected.size === 0) { toast.error("กรุณาเลือกรายการก่อน"); return; }
    setPrinting(true);
    const toastId = toast.loading("กำลังสร้างเอกสาร PDF + Excel จ่าหน้าซอง...");
    try {
      const resp = await fetch("/api/notice/print", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: sectionKey, externalIds: Array.from(selected) }),
      });
      if (!resp.ok) {
        const { message } = await resp.json().catch(() => ({ message: "สร้างเอกสารไม่สำเร็จ" }));
        toast.error(message, { id: toastId });
        return;
      }
      const printedCount = Number(resp.headers.get("X-Notice-Printed-Count") ?? "0");
      const hasPdf = resp.headers.get("X-Notice-Pdf") === "1";
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `notice_${sectionKey}_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      clearSelection();
      refetchAll();
      toast.success(
        `สร้างเอกสาร ${printedCount} รายการและบันทึกการส่งแล้ว` +
          (hasPdf ? "" : " (ระบบสร้างเป็น DOCX เพราะเซิร์ฟเวอร์ยังไม่มี LibreOffice)"),
        { id: toastId },
      );
    } catch (e) {
      toast.error((e as Error).message ?? "สร้างเอกสารไม่สำเร็จ", { id: toastId });
    } finally {
      setPrinting(false);
    }
  };
  const handleStats = () => setStatsOpen(true);

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.split(",")[1] ?? "");
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const handleExportExcel = async () => {
    if (!section || exporting) return;
    setExporting(true);
    const toastId = toast.loading("กำลังสร้างไฟล์ Excel...");
    try {
      const params = new URLSearchParams({
        section: sectionKey,
        filters: JSON.stringify(filters),
        sort: JSON.stringify({ field: sortField, dir: sortDir }),
      });
      const resp = await fetch(`/api/notice/export?${params}`, { credentials: "include" });
      if (!resp.ok) {
        const { message } = await resp.json().catch(() => ({ message: "Export ไม่สำเร็จ" }));
        toast.error(message, { id: toastId });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `notice_history_${sectionKey}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลด Excel สำเร็จ", { id: toastId });
    } catch (e) {
      toast.error((e as Error).message ?? "Export ไม่สำเร็จ", { id: toastId });
    } finally {
      setExporting(false);
    }
  };

  const runImportPreview = async (file: File) => {
    const toastId = toast.loading("กำลังตรวจสอบไฟล์...");
    try {
      const fileBase64 = await fileToBase64(file);
      const resp = await fetch("/api/notice/import-preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: sectionKey, fileBase64 }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        toast.error(data.message ?? "ตรวจสอบไฟล์ไม่สำเร็จ", { id: toastId });
        return;
      }
      setImportPreview(data);
      toast.success(`พบ ${data.parsedRows} แถว — จะนำเข้า ${data.toInsert} รายการ`, { id: toastId });
    } catch (e) {
      toast.error((e as Error).message ?? "ตรวจสอบไฟล์ไม่สำเร็จ", { id: toastId });
    }
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setImportFile(file);
    setImportPreview(null);
    if (file) await runImportPreview(file);
    e.target.value = "";
  };

  const handleDownloadImportTemplate = async () => {
    const toastId = toast.loading("กำลังดาวน์โหลด template...");
    try {
      const resp = await fetch("/api/notice/import-template", { credentials: "include" });
      if (!resp.ok) {
        const { message } = await resp.json().catch(() => ({ message: "ดาวน์โหลดไม่สำเร็จ" }));
        toast.error(message, { id: toastId });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "notice_import_template.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลด template สำเร็จ", { id: toastId });
    } catch (e) {
      toast.error((e as Error).message ?? "ดาวน์โหลดไม่สำเร็จ", { id: toastId });
    }
  };

  const handleImportConfirm = async () => {
    if (!importFile || importing) return;
    if (!window.confirm(`ยืนยันนำเข้าประวัติ Notice → ${sectionKey}?\n\nจะเพิ่ม ${importPreview?.toInsert ?? "?"} รายการ (ข้ามรายการซ้ำ)`)) return;
    setImporting(true);
    const toastId = toast.loading("กำลังนำเข้าข้อมูล...");
    try {
      const fileBase64 = await fileToBase64(importFile);
      const resp = await fetch("/api/notice/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: sectionKey, fileBase64 }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        toast.error(data.message ?? "นำเข้าไม่สำเร็จ", { id: toastId });
        return;
      }
      setImportOpen(false);
      setImportFile(null);
      setImportPreview(null);
      refetchAll();
      utils.notice.monthlyStats.invalidate();
      toast.success(`นำเข้าสำเร็จ ${data.imported} รายการ (ข้าม ${data.skipped})`, { id: toastId });
    } catch (e) {
      toast.error((e as Error).message ?? "นำเข้าไม่สำเร็จ", { id: toastId });
    } finally {
      setImporting(false);
    }
  };

  const confirmRestore = () => {
    if (!pendingRestore) return;
    restoreMut.mutate({ section: sectionKey, externalId: pendingRestore.externalId });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("desc"); }
  };
  const sortMark = (field: SortField) => (sortField === field ? (sortDir === "asc" ? "▲" : "▼") : "");

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
            <div className="flex items-center gap-2 flex-wrap">
              {canExport && (
                <button onClick={handleExportExcel} disabled={exporting}
                  className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition-colors disabled:opacity-50">
                  <Download className="w-4 h-4" /> {exporting ? "กำลัง Export..." : "Export Excel"}
                </button>
              )}
              {canEdit && (
                <button onClick={() => { setImportOpen(true); setImportFile(null); setImportPreview(null); }}
                  className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-amber-50 text-amber-900 hover:bg-amber-100 transition-colors">
                  <Upload className="w-4 h-4" /> Import Excel
                </button>
              )}
              <button onClick={handleStats}
                className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-indigo-50 text-indigo-800 hover:bg-indigo-100 transition-colors">
                <BarChart3 className="w-4 h-4" /> ดูสถิติรายเดือน
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="px-4 sm:px-[18px] py-4 border-b border-gray-200 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            <div>
              <label className={labelCls}>ค้นหา</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="ชื่อ / เลขสัญญา / เลขที่เอกสาร" className={inputCls + " pl-8"} />
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
            <div>
              <label className={labelCls}>ชื่อแอดมิน</label>
              <select value={adminFilter} onChange={(e) => setAdminFilter(e.target.value)}
                disabled={adminOptions.length === 0}
                title={adminOptions.length === 0 ? "จะมีตัวเลือกเมื่อมีประวัติการพิมพ์" : undefined}
                className={inputCls + (adminOptions.length === 0 ? " opacity-60 cursor-not-allowed" : "")}>
                <option value="all">ทั้งหมด</option>
                {adminOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          </div>

          {/* Actions */}
          <div className="px-4 sm:px-[18px] py-3.5 border-b border-gray-200 flex items-center gap-2.5 flex-wrap">
            <button onClick={handlePrint} disabled={!canEdit || printing}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <Printer className="w-4 h-4" /> {printing ? "กำลังสร้างเอกสาร..." : "พิมพ์รายการที่เลือก"}
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
            ) : rows.length === 0 ? (
              <div className="py-7 text-center text-gray-400 text-sm">ไม่พบรายการตามเงื่อนไขที่กรอง</div>
            ) : (
              <table className="w-full border-separate border-spacing-0 min-w-[1240px]">
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
                    <th className="w-[210px] min-w-[210px]">เลขที่สัญญา</th>
                    <th className="w-[160px]">ชื่อ-นามสกุล</th>
                    <th className="w-[106px]">
                      <button onClick={() => handleSort("overdueDays")} className="font-bold text-gray-700 hover:text-orange-500">
                        ค้างชำระ(วัน) <span className="text-orange-500 font-black">{sortMark("overdueDays")}</span>
                      </button>
                    </th>
                    <th className="w-[230px]">
                      <button onClick={() => handleSort("sentCount")} className="font-bold text-gray-700 hover:text-orange-500">
                        ส่งแล้ว <span className="text-orange-500 font-black">{sortMark("sentCount")}</span>
                      </button>
                    </th>
                    <th className="w-[90px]">เลขที่เอกสาร</th>
                    <th className="w-[240px]">Log การพิมพ์</th>
                    <th className="w-[180px]">Log การแก้ไข</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const disabled = !isSelectable(row);
                    const done = row.sentCount;
                    const sentBadgeCls =
                      done >= MAX_NOTICE_ROUNDS ? "bg-emerald-50 text-emerald-700"
                        : done === 0 ? "bg-gray-100 text-gray-700"
                          : "bg-blue-50 text-blue-700";
                    const currentRound = row.isReturned || done >= MAX_NOTICE_ROUNDS ? -1 : done; // index ของรอบถัดไป
                    const logByRound = new Map(row.printLogs.map((l) => [l.round, l]));
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
                        <td className="whitespace-nowrap"><strong className="text-gray-900">{row.contractNo}</strong></td>
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
                                const lg = logByRound.get(i + 1);
                                const tip = lg
                                  ? `ส่งครั้งที่ ${i + 1}: ${fmtDateTime(lg.printedAt)} โดย ${lg.printedBy}`
                                  : `รอบ ${i + 1}: ยังไม่เคยส่ง`;
                                return (
                                  <span key={i} title={tip}
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
                              {done > 0 && canEdit && (
                                <button onClick={() => setPendingRestore(row)} title="ยกเลิกรอบส่งล่าสุด"
                                  className="ml-1 inline-grid place-items-center w-[26px] h-[26px] rounded-full border border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200">
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap">
                          {row.documentNo ? (
                            <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold bg-indigo-50 text-indigo-800">
                              {row.documentNo}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="text-gray-600">
                          {row.printLogs.length === 0 && !row.isReturned ? (
                            <span className="text-gray-400">ยังไม่มี log</span>
                          ) : (
                            <div className="grid gap-1">
                              {row.printLogs.map((l) => (
                                <div key={l.round} className="text-xs leading-relaxed text-gray-700">
                                  <strong className="text-gray-900">{l.round}</strong> : {fmtDateTime(l.printedAt)} โดย {l.printedBy}
                                </div>
                              ))}
                              {row.isReturned && (
                                <div className="mt-0.5">
                                  <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold bg-emerald-50 text-emerald-700">
                                    ได้เครื่องคืนแล้ว
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="text-gray-600">
                          {row.restoreLogs.length === 0 ? (
                            <span className="text-gray-400">-</span>
                          ) : (
                            <div className="grid gap-1">
                              {row.restoreLogs.map((l, idx) => (
                                <div key={idx} className="text-xs leading-relaxed text-gray-700">
                                  <strong className="text-gray-900">Restore รอบ {l.round}</strong> : {fmtDateTime(l.restoredAt)} โดย {l.restoredBy}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          <div className="px-4 sm:px-[18px] py-3.5 bg-[#fafafa] border-t border-gray-200 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 text-[13px] text-gray-500">
                <span>แสดง</span>
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
                  className="h-8 px-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:border-orange-500">
                  {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span>รายการ/หน้า</span>
              </div>
              <span className="text-gray-300">|</span>
              <div className="text-[13px] text-gray-500">
                {total > 0
                  ? `แสดง ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} จาก ${total.toLocaleString()} รายการ`
                  : "แสดง 0 รายการ"}
              </div>
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
            หมายเหตุ: Export Excel ส่งออกเฉพาะรายการที่มีประวัติส่งแล้ว — Import ใช้รูปแบบเดียวกับ template ประวัติ (section ปัจจุบัน)
            · ปุ่ม "พิมพ์รายการที่เลือก" สร้าง ZIP และนับรอบส่งอัตโนมัติ
          </div>
        </section>
      </div>

      {/* ── Monthly stats modal (layout ตาม docs/stats-layout.png) ── */}
      {statsOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-5 bg-black/45"
          onClick={() => setStatsOpen(false)}>
          <div
            className="w-full max-w-[920px] max-h-[90vh] overflow-y-auto bg-white rounded-[18px] shadow-2xl border border-gray-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-200 flex items-start justify-between gap-4">
              <div>
                <div className="text-xl font-extrabold text-gray-900">สถิติการส่ง Notice รายเดือน</div>
                <div className="mt-1.5 text-sm text-gray-500">
                  {monthlyStats?.subtitle ?? "กำลังโหลด..."}
                </div>
              </div>
              <button
                onClick={() => setStatsOpen(false)}
                className="shrink-0 rounded-xl px-3.5 py-2 text-sm font-bold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
              >
                ปิด
              </button>
            </div>

            <div className="px-5 sm:px-6 py-5">
              {statsLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Spinner className="w-6 h-6 text-orange-500" />
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-5">
                    {[
                      {
                        label: "ส่งสะสมทั้งหมด",
                        value: monthlyStats?.totalSent ?? 0,
                        hint: "รายการ Notice",
                      },
                      {
                        label: "เฉลี่ยต่อเดือน",
                        value: monthlyStats?.avgPerMonth ?? 0,
                        hint: monthlyStats?.months[0]?.monthLabel
                          ? `ตั้งแต่ ${monthlyStats.months[0].monthLabel}`
                          : "-",
                      },
                      {
                        label: monthlyStats?.latestMonthLabel
                          ? `เดือนล่าสุด (${monthlyStats.latestMonthLabel})`
                          : "เดือนล่าสุด",
                        value: monthlyStats?.latestMonthSent ?? 0,
                        hint: monthlyStats?.latestMonthHint || "ยังไม่มีข้อมูล",
                      },
                      {
                        label: "ได้เครื่องคืนสะสม",
                        value: monthlyStats?.totalReturned ?? 0,
                        hint: "รวมทุกเดือน",
                      },
                    ].map((card) => (
                      <div
                        key={card.label}
                        className="bg-white border border-gray-200 rounded-xl p-4"
                      >
                        <div className="text-[13px] text-gray-500">{card.label}</div>
                        <div className="text-[28px] font-extrabold text-gray-900 mt-1.5">
                          {card.value.toLocaleString()}
                        </div>
                        <div className="text-xs text-gray-400 mt-1">{card.hint}</div>
                      </div>
                    ))}
                  </div>

                  {/* Monthly table */}
                  {(monthlyStats?.months.length ?? 0) === 0 ? (
                    <div className="py-10 text-center text-gray-400 text-sm">ยังไม่มีข้อมูลการส่ง Notice</div>
                  ) : (
                    <div className="border border-gray-200 rounded-xl overflow-hidden">
                      <table className="w-full border-separate border-spacing-0">
                        <thead>
                          <tr className="bg-[#fafafa] [&>th]:text-xs [&>th]:font-bold [&>th]:text-gray-700 [&>th]:px-3 [&>th]:py-3 [&>th]:border-b [&>th]:border-gray-200 [&>th]:whitespace-nowrap">
                            <th className="text-left">เดือน</th>
                            <th className="text-left">ส่งทั้งหมด</th>
                            <th className="text-center">รอบ 1</th>
                            <th className="text-center">รอบ 2</th>
                            <th className="text-center">รอบ 3</th>
                            <th className="text-left">ได้เครื่องคืน</th>
                            <th className="text-left min-w-[120px]">สัดส่วน</th>
                          </tr>
                        </thead>
                        <tbody>
                          {monthlyStats?.months.map((m) => (
                            <tr
                              key={m.monthKey}
                              className="[&>td]:px-3 [&>td]:py-3 [&>td]:border-b [&>td]:border-gray-100 [&>td]:text-[13px] [&>td]:text-gray-700 hover:bg-orange-50/40"
                            >
                              <td className="font-semibold text-gray-900">{m.monthLabel}</td>
                              <td>{m.totalSent.toLocaleString()} รายการ</td>
                              <td className="text-center">{m.round1.toLocaleString()}</td>
                              <td className="text-center">{m.round2.toLocaleString()}</td>
                              <td className="text-center">{m.round3.toLocaleString()}</td>
                              <td>{m.returned.toLocaleString()} เครื่อง</td>
                              <td>
                                <div className="h-2.5 w-full max-w-[140px] rounded-full bg-gray-100 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#f27121] transition-all"
                                    style={{ width: `${m.proportion}%` }}
                                  />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Import Excel modal ── */}
      {importOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-5 bg-black/45"
          onClick={() => !importing && setImportOpen(false)}>
          <div className="w-full max-w-[560px] bg-white rounded-[18px] shadow-2xl border border-gray-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-extrabold text-gray-900">นำเข้าประวัติ Notice จาก Excel</div>
                <div className="mt-1 text-sm text-gray-500">Section: <strong>{sectionKey}</strong></div>
              </div>
              <button onClick={() => !importing && setImportOpen(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[13px] text-gray-600 leading-relaxed flex-1 min-w-[200px]">
                  กรอกข้อมูลใน template แล้วอัปโหลด — ข้ามรายการที่มี log รอบนั้นแล้ว
                </div>
                <button type="button" onClick={handleDownloadImportTemplate} disabled={importing}
                  className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold bg-sky-50 text-sky-800 hover:bg-sky-100 transition-colors disabled:opacity-50 shrink-0">
                  <Download className="w-4 h-4" /> ดาวน์โหลด template
                </button>
              </div>
              <input ref={importInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                onChange={handleImportFileChange} />
              <button onClick={() => importInputRef.current?.click()} disabled={importing}
                className="w-full rounded-xl border-2 border-dashed border-amber-200 bg-amber-50/50 px-4 py-8 text-sm font-bold text-amber-900 hover:bg-amber-50 transition-colors disabled:opacity-50">
                {importFile ? importFile.name : "เลือกไฟล์ .xlsx"}
              </button>
              {importPreview && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5 text-[13px] text-gray-700 grid gap-1">
                  <div>แถวในไฟล์: <strong>{importPreview.parsedRows}</strong></div>
                  <div>จะนำเข้า: <strong className="text-emerald-700">{importPreview.toInsert}</strong></div>
                  <div>ข้าม (ไม่พบสัญญา): {importPreview.skipNoContract}</div>
                  <div>ข้าม (มี log แล้ว): {importPreview.skipDuplicate}</div>
                </div>
              )}
            </div>
            <div className="px-5 pb-5 flex justify-end gap-2.5">
              <button onClick={() => setImportOpen(false)} disabled={importing}
                className="rounded-xl px-3.5 py-2.5 text-sm font-bold bg-gray-100 text-gray-900 hover:bg-gray-200 disabled:opacity-50">
                ยกเลิก
              </button>
              <button onClick={handleImportConfirm}
                disabled={importing || !importFile || !importPreview || importPreview.toInsert === 0}
                className="rounded-xl px-3.5 py-2.5 text-sm font-bold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
                {importing ? "กำลังนำเข้า..." : "ยืนยันนำเข้า"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Restore confirm modal ── */}
      {pendingRestore && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-5 bg-black/45"
          onClick={() => setPendingRestore(null)}>
          <div className="w-full max-w-[560px] bg-white rounded-[22px] shadow-2xl border border-gray-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-[18px] py-4 border-b border-gray-200 flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-black text-gray-900">ยกเลิกรอบการส่ง Notice</div>
                <div className="text-[13px] text-gray-500 mt-1">ใช้สำหรับกรณีสั่งพิมพ์ซ้ำหรือบันทึกผิดรอบ</div>
              </div>
              <button onClick={() => setPendingRestore(null)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-[18px]">
              <div className="border border-gray-200 bg-gray-50 rounded-2xl p-3.5 grid gap-1.5 text-[13px] text-gray-700">
                <div><strong>เลขที่สัญญา:</strong> {pendingRestore.contractNo}</div>
                <div><strong>ชื่อ-นามสกุล:</strong> {pendingRestore.customerName ?? "-"}</div>
                <div><strong>รอบที่จะยกเลิก:</strong> ครั้งที่ {pendingRestore.sentCount}</div>
                {(() => {
                  const last = pendingRestore.printLogs.find((l) => l.round === pendingRestore.sentCount);
                  return last ? (
                    <>
                      <div><strong>วันที่/เวลา:</strong> {fmtDateTime(last.printedAt)}</div>
                      <div><strong>ผู้สั่งพิมพ์:</strong> {last.printedBy}</div>
                    </>
                  ) : null;
                })()}
              </div>
              <div className="mt-3 border border-orange-200 bg-orange-50 text-orange-800 rounded-2xl p-3 text-[13px] leading-relaxed">
                <strong>ยืนยันก่อนยกเลิก</strong><br />
                ระบบจะยกเลิกเฉพาะ <strong>รอบล่าสุด</strong> เพื่อไม่ให้ลำดับ 1 / 2 / 3 ข้ามกัน
                หลังยกเลิกแล้วรายการนี้จะกลับไปพิมพ์รอบเดิมได้อีกครั้ง
              </div>
            </div>
            <div className="px-[18px] pb-[18px] flex justify-end gap-2.5 flex-wrap">
              <button onClick={() => setPendingRestore(null)}
                className="rounded-xl px-3.5 py-2.5 text-sm font-bold bg-gray-100 text-gray-900 hover:bg-gray-200">
                ไม่ยกเลิก
              </button>
              <button onClick={confirmRestore} disabled={restoreMut.isPending}
                className="rounded-xl px-3.5 py-2.5 text-sm font-bold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                ยืนยัน Restore รอบล่าสุด
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

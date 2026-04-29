/**
 * BadDebtSummary — Phase 99 (no overflow-x-auto, fluid table layout)
 * หน้าสรุปกำไร/ขาดทุนจากหนี้เสีย แบ่งเป็น 3 แถบ:
 *   1. รายการขายเครื่อง
 *   2. สรุปรายเดือน
 *   3. สรุปรายปี
 */
import React, { useMemo, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Banknote,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  TrendingDown,
  TrendingUp,
  Wallet,
  Download,
  CalendarDays,
  CalendarRange,
  List,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const fmtMoney = (v: number | null | undefined) =>
  v == null
    ? "-"
    : v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (s: string | null | undefined) => {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
};

const fmtMonthLabel = (ym: string) => {
  const [y, m] = ym.split("-");
  const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const mIdx = parseInt(m, 10) - 1;
  const buddhistYear = parseInt(y, 10) + 543;
  return `${monthNames[mIdx] ?? m} ${buddhistYear}`;
};

type SortKey =
  | "contractNo" | "approveDate" | "financeAmount" | "commissionNet"
  | "installmentPaid" | "deviceSaleAmount" | "totalRevenue" | "cost"
  | "profitLoss" | "saleDate";
type MonthlySortKey = "ym" | "count" | "financeAmount" | "commissionNet" | "cost" | "installmentPaid" | "deviceSaleAmount" | "totalRevenue" | "profitLoss";
type YearlySortKey = "year" | "count" | "financeAmount" | "commissionNet" | "cost" | "installmentPaid" | "deviceSaleAmount" | "totalRevenue" | "profitLoss";
type SortDir = "asc" | "desc";
type ActiveTab = "list" | "monthly" | "yearly";

/* ─── ProfitBadge ─────────────────────────────────────────────────────────── */
function ProfitBadge({ value }: { value: number }) {
  if (value > 0)
    return (
      <span className="inline-flex items-center gap-1 text-green-600 font-semibold">
        <TrendingUp className="w-3.5 h-3.5" />
        {fmtMoney(value)}
      </span>
    );
  if (value < 0)
    return (
      <span className="inline-flex items-center gap-1 text-red-500 font-semibold">
        <TrendingDown className="w-3.5 h-3.5" />
        {fmtMoney(value)}
      </span>
    );
  return <span className="text-gray-500">{fmtMoney(value)}</span>;
}

/* ─── SummaryCard ─────────────────────────────────────────────────────────── */
function SummaryCard({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string; color: string;
}) {
  return (
    <div className={`rounded-lg border p-3 flex items-center gap-3 bg-white ${color}`}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 truncate">{label}</p>
        <p className="text-sm font-bold text-gray-800 truncate">{value}</p>
      </div>
    </div>
  );
}

/* ─── main component ────────────────────────────────────────────────────────── */
export default function BadDebtSummary() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const canView = can("bad_debt_summary", "view");
  const canExport = can("bad_debt_summary", "export");
  const { setActions } = useNavActions();

  const [approveMonth, setApproveMonth] = useState("");
  const [saleMonth, setSaleMonth] = useState("");
  const [filterYear, setFilterYear] = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("list");
  const [sortKey, setSortKey] = useState<SortKey>("saleDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [monthlySortKey, setMonthlySortKey] = useState<MonthlySortKey>("ym");
  const [monthlySortDir, setMonthlySortDir] = useState<SortDir>("desc");
  const [yearlySortKey, setYearlySortKey] = useState<YearlySortKey>("year");
  const [yearlySortDir, setYearlySortDir] = useState<SortDir>("desc");

  const { data, isLoading } = trpc.badDebt.summary.useQuery(
    section ? { section, approveMonth: approveMonth || undefined, saleMonth: saleMonth || undefined } : (undefined as any),
    { enabled: canView && !!section, staleTime: 5 * 60 * 1000 },
  );

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  /* ── saleMonth options ── */
  const saleMonthOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.saleDate) set.add(r.saleDate.slice(0, 7)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── approveMonth options (dropdown) ── */
  const approveMonthOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.approveDate) set.add(r.approveDate.slice(0, 7)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── year options ── */
  const yearOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.saleDate) set.add(r.saleDate.slice(0, 4)); });
    return Array.from(set).sort().reverse();
  }, [rows]);

  /* ── filtered rows (list tab) ── */
  const filteredRows = useMemo(() => {
    const r = [...rows];
    r.sort((a, b) => {
      const av: any = a[sortKey as keyof typeof a] ?? "";
      const bv: any = b[sortKey as keyof typeof b] ?? "";
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return r;
  }, [rows, sortKey, sortDir]);

  /* ── monthly summary ── */
  const monthlyRows = useMemo(() => {
    const src = filterYear ? rows.filter((r) => (r.saleDate ?? "").startsWith(filterYear)) : rows;
    const map = new Map<string, {
      ym: string; count: number;
      financeAmount: number; commissionNet: number; cost: number;
      installmentPaid: number; deviceSaleAmount: number; totalRevenue: number; profitLoss: number;
    }>();
    src.forEach((r) => {
      const ym = (r.saleDate ?? "").slice(0, 7) || "ไม่ระบุ";
      const cur = map.get(ym) ?? { ym, count: 0, financeAmount: 0, commissionNet: 0, cost: 0, installmentPaid: 0, deviceSaleAmount: 0, totalRevenue: 0, profitLoss: 0 };
      cur.count++;
      cur.financeAmount += r.financeAmount;
      cur.commissionNet += r.commissionNet;
      cur.cost += r.cost;
      cur.installmentPaid += r.installmentPaid;
      cur.deviceSaleAmount += r.deviceSaleAmount;
      cur.totalRevenue += r.totalRevenue;
      cur.profitLoss += r.profitLoss;
      map.set(ym, cur);
    });
    const raw = Array.from(map.values());
    raw.sort((a, b) => {
      const av: any = a[monthlySortKey as keyof typeof a] ?? "";
      const bv: any = b[monthlySortKey as keyof typeof b] ?? "";
      if (typeof av === "number" && typeof bv === "number") return monthlySortDir === "asc" ? av - bv : bv - av;
      return monthlySortDir === "asc" ? String(av).localeCompare(String(bv), "th") : String(bv).localeCompare(String(av), "th");
    });
    return raw;
  }, [rows, filterYear, monthlySortKey, monthlySortDir]);

  /* ── yearly summary ── */
  const yearlyRows = useMemo(() => {
    const src = filterYear ? rows.filter((r) => (r.saleDate ?? "").startsWith(filterYear)) : rows;
    const map = new Map<string, {
      year: string; count: number;
      financeAmount: number; commissionNet: number; cost: number;
      installmentPaid: number; deviceSaleAmount: number; totalRevenue: number; profitLoss: number;
    }>();
    src.forEach((r) => {
      const year = (r.saleDate ?? "").slice(0, 4) || "ไม่ระบุ";
      const cur = map.get(year) ?? { year, count: 0, financeAmount: 0, commissionNet: 0, cost: 0, installmentPaid: 0, deviceSaleAmount: 0, totalRevenue: 0, profitLoss: 0 };
      cur.count++;
      cur.financeAmount += r.financeAmount;
      cur.commissionNet += r.commissionNet;
      cur.cost += r.cost;
      cur.installmentPaid += r.installmentPaid;
      cur.deviceSaleAmount += r.deviceSaleAmount;
      cur.totalRevenue += r.totalRevenue;
      cur.profitLoss += r.profitLoss;
      map.set(year, cur);
    });
    const raw = Array.from(map.values());
    raw.sort((a, b) => {
      const av: any = a[yearlySortKey as keyof typeof a] ?? "";
      const bv: any = b[yearlySortKey as keyof typeof b] ?? "";
      if (typeof av === "number" && typeof bv === "number") return yearlySortDir === "asc" ? av - bv : bv - av;
      return yearlySortDir === "asc" ? String(av).localeCompare(String(bv), "th") : String(bv).localeCompare(String(av), "th");
    });
    return raw;
  }, [rows, filterYear, yearlySortKey, yearlySortDir]);

  /* ── sort toggle (list tab) ── */
  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return key; }
      setSortDir("desc");
      return key;
    });
  }, []);

  /* ── sort toggle (monthly tab) ── */
  const toggleMonthlySort = useCallback((key: MonthlySortKey) => {
    setMonthlySortKey((prev) => {
      if (prev === key) { setMonthlySortDir((d) => (d === "asc" ? "desc" : "asc")); return key; }
      setMonthlySortDir("desc");
      return key;
    });
  }, []);

  /* ── sort toggle (yearly tab) ── */
  const toggleYearlySort = useCallback((key: YearlySortKey) => {
    setYearlySortKey((prev) => {
      if (prev === key) { setYearlySortDir((d) => (d === "asc" ? "desc" : "asc")); return key; }
      setYearlySortDir("desc");
      return key;
    });
  }, []);

  /* ── export ── */
  const handleExport = useCallback(async () => {
    if (!section) return;
    const params = new URLSearchParams({ section });
    if (approveMonth) params.set("approveMonth", approveMonth);
    if (saleMonth) params.set("saleMonth", saleMonth);
    const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
    try {
      const resp = await fetch(`/api/export/bad-debt?${params.toString()}`, { credentials: "include" });
      if (!resp.ok) {
        const { message } = await resp.json().catch(() => ({ message: "Export failed" }));
        toast.error(message, { id: toastId });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bad_debt_summary_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลดสำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  }, [section, approveMonth, saleMonth]);

  /* ── nav actions ── */
  useEffect(() => {
    setActions([]);
    return () => setActions([]);
  }, [setActions]);

  /* ── SortIcon helper ── */
  const SortIcon = ({ col }: { col: SortKey }) => {
    if (col !== sortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };
  const MonthlySortIcon = ({ col }: { col: MonthlySortKey }) => {
    if (col !== monthlySortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return monthlySortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };
  const YearlySortIcon = ({ col }: { col: YearlySortKey }) => {
    if (col !== yearlySortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return yearlySortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  /* ── Th helpers ── */
  const Th = ({ label, col, className = "" }: { label: string; col?: SortKey; className?: string }) => (
    <th
      className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`}
      onClick={col ? () => toggleSort(col) : undefined}
    >
      <span className="inline-flex items-center gap-1 justify-center">
        {label}
        {col && <SortIcon col={col} />}
      </span>
    </th>
  );
  const ThM = ({ label, col, className = "", rowSpan }: { label: string; col?: MonthlySortKey; className?: string; rowSpan?: number }) => (
    <th
      rowSpan={rowSpan}
      className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`}
      onClick={col ? () => toggleMonthlySort(col) : undefined}
    >
      <span className="inline-flex items-center gap-1 justify-center">
        {label}
        {col && <MonthlySortIcon col={col} />}
      </span>
    </th>
  );
  const ThY = ({ label, col, className = "", rowSpan }: { label: string; col?: YearlySortKey; className?: string; rowSpan?: number }) => (
    <th
      rowSpan={rowSpan}
      className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap select-none ${col ? "cursor-pointer hover:bg-white/10" : ""} ${className}`}
      onClick={col ? () => toggleYearlySort(col) : undefined}
    >
      <span className="inline-flex items-center gap-1 justify-center">
        {label}
        {col && <YearlySortIcon col={col} />}
      </span>
    </th>
  );

  /* ── tabs ── */
  const tabs: { key: ActiveTab; label: string; icon: React.ReactNode }[] = [
    { key: "list", label: "รายการขายเครื่อง", icon: <List className="w-4 h-4" /> },
    { key: "monthly", label: "สรุปรายเดือน", icon: <CalendarDays className="w-4 h-4" /> },
    { key: "yearly", label: "สรุปรายปี", icon: <CalendarRange className="w-4 h-4" /> },
  ];

  if (!canView) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-32 text-gray-400">
          <AlertTriangle className="w-5 h-5 mr-2" />
          คุณไม่มีสิทธิ์ดูหน้านี้
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell fullHeight>
      <div className="flex flex-col h-full">
      <div className="px-4 py-4 space-y-4">

        {/* ── Tabs + Export Excel ── */}
        <div className="flex items-center justify-between border-b border-gray-200">
          <div className="flex gap-0">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === t.key ? "border-red-600 text-red-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          {canExport && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-1.5 mb-1 rounded-md text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Export Excel</span>
            </button>
          )}
        </div>

        {/* ── Summary Cards ── */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard icon={<AlertTriangle className="w-5 h-5 text-red-500" />} label="จำนวนสัญญา" value={`${summary.contractCount.toLocaleString("th-TH")} รายการ`} color="border-red-100" />
            <SummaryCard icon={<Banknote className="w-5 h-5 text-blue-500" />} label="ยอดจัดไฟแนนซ์รวม" value={fmtMoney(summary.totalFinanceAmount)} color="border-blue-100" />
            <SummaryCard icon={<Wallet className="w-5 h-5 text-purple-500" />} label="ต้นทุนรวม" value={fmtMoney(summary.totalCost)} color="border-purple-100" />
            <SummaryCard icon={<Wallet className="w-5 h-5 text-teal-500" />} label="รวมรายรับ" value={fmtMoney(summary.totalInstallmentPaid + summary.totalDeviceSaleAmount)} color="border-teal-100" />
            <SummaryCard
              icon={summary.totalProfitLoss >= 0 ? <TrendingUp className="w-5 h-5 text-green-600" /> : <TrendingDown className="w-5 h-5 text-red-500" />}
              label="กำไร/ขาดทุนรวม"
              value={fmtMoney(summary.totalProfitLoss)}
              color={summary.totalProfitLoss >= 0 ? "border-green-100" : "border-red-100"}
            />
            <SummaryCard icon={<TrendingUp className="w-5 h-5 text-green-500" />} label="กำไร / เสมอ / ขาดทุน" value={`${summary.profitCount} / ${summary.breakEvenCount} / ${summary.lossCount}`} color="border-gray-100" />
          </div>
        )}

        {/* ── Filters ── */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">เดือนที่อนุมัติ</label>
            <select value={approveMonth} onChange={(e) => setApproveMonth(e.target.value)} className="border rounded px-2 py-1.5 text-sm h-9 bg-white">
              <option value="">ทุกเดือน</option>
              {approveMonthOptions.map((ym) => (
                <option key={ym} value={ym}>{fmtMonthLabel(ym)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">เดือนที่ขายเครื่อง</label>
            <select value={saleMonth} onChange={(e) => setSaleMonth(e.target.value)} className="border rounded px-2 py-1.5 text-sm h-9 bg-white">
              <option value="">ทุกเดือน</option>
              {saleMonthOptions.map((ym) => (
                <option key={ym} value={ym}>{fmtMonthLabel(ym)}</option>
              ))}
            </select>
          </div>
          {(activeTab === "monthly" || activeTab === "yearly") && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">ปีที่ขาย</label>
              <select value={filterYear} onChange={(e) => setFilterYear(e.target.value)} className="border rounded px-2 py-1.5 text-sm h-9 bg-white">
                <option value="">ทุกปี</option>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{parseInt(y, 10) + 543}</option>
                ))}
              </select>
            </div>
          )}
          <button onClick={() => { setApproveMonth(""); setSaleMonth(""); setFilterYear(""); }} className="h-9 px-3 text-sm border rounded hover:bg-gray-50 text-gray-600">
            ล้างตัวกรอง
          </button>
        </div>

        {/* ── Loading ── */}
        {isLoading && (
          <div className="flex justify-center py-16"><Spinner /></div>
        )}

      </div>
        {/* ╔════════════════ TAB 1: รายการขายเครื่อง ════════════════ */}
        {!isLoading && activeTab === "list" && (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
          <div className="rounded-lg border border-gray-200 shadow-sm">
            <table className="w-full text-sm">              <thead className="bg-red-700 text-white sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-2 text-center text-xs font-semibold w-10">#</th>
                  <Th label="วันที่อนุมัติ" col="approveDate" />
                  <Th label="เลขที่สัญญา" col="contractNo" />
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">ชื่อ-นามสกุล</th>
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">เบอร์โทร</th>
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">รุ่น</th>
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">ราคา</th>
                  <Th label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                  <Th label="ค่าคอมมิชชั่น" col="commissionNet" />
                  <Th label="ต้นทุน" col="cost" />
                  <th className="px-2 py-2 text-center text-xs font-semibold whitespace-nowrap">งวดที่ชำระ</th>
                  <Th label="ยอดเก็บค่างวด" col="installmentPaid" />
                  <Th label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                  <Th label="รวมรายรับ" col="totalRevenue" />
                  <Th label="วันที่ขาย" col="saleDate" />
                  <Th label="กำไร/ขาดทุน" col="profitLoss" />
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr><td colSpan={16} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                ) : (
                  filteredRows.map((r, idx) => (
                    <tr key={r.contractExternalId} className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                      <td className="px-2 py-2 text-center text-gray-400 text-xs">{idx + 1}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">{fmtDate(r.approveDate)}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap font-mono text-xs">{r.contractNo ?? "-"}</td>
                      <td className="px-2 py-2 whitespace-nowrap text-xs">{r.customerName ?? "-"}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">{r.phone ?? "-"}</td>
                      <td className="px-2 py-2 whitespace-nowrap text-xs">{r.model ?? "-"}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.salePrice)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.financeAmount)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.commissionNet)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs font-medium text-orange-700">{fmtMoney(r.cost)}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">
                        {r.installmentCount != null ? `${r.paidInstallments}/${r.installmentCount}` : `${r.paidInstallments}`}
                      </td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">{fmtMoney(r.installmentPaid)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs font-medium">{fmtMoney(r.totalRevenue)}</td>
                      <td className="px-2 py-2 text-center whitespace-nowrap text-xs">{fmtDate(r.saleDate)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs"><ProfitBadge value={r.profitLoss} /></td>
                    </tr>
                  ))
                )}
              </tbody>
              {filteredRows.length > 0 && (
                <tfoot className="bg-red-50 border-t-2 border-red-200 font-semibold text-xs">
                  <tr>
                    <td colSpan={7} className="px-2 py-2 text-right text-gray-600">รวม {filteredRows.length} รายการ</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                    <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(filteredRows.reduce((s, r) => s + r.cost, 0))}</td>
                    <td className="px-2 py-2"></td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                    <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(filteredRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(filteredRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                    <td className="px-2 py-2"></td>
                    <td className="px-2 py-2 text-right"><ProfitBadge value={filteredRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          </div>
        )}
        {/* ╔════════════════ TAB 2: สรุปรายเดือน ════════════════ */}
        {!isLoading && activeTab === "monthly" && (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
          <div className="rounded-lg border border-gray-200 shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-blue-700 text-white sticky top-0 z-10">
                {/* Group header row */}
                <tr>
                  <ThM label="เดือน-ปีที่ขาย" col="ym" rowSpan={2} className="px-3 text-left border-r border-blue-500" />
                  <ThM label="จำนวน" col="count" rowSpan={2} className="border-r border-blue-500" />
                  <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-blue-500 border-r border-blue-500">ต้นทุน</th>
                  <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-blue-500 border-r border-blue-500">รายรับ</th>
                  <ThM label="กำไร/ขาดทุน" col="profitLoss" rowSpan={2} />
                </tr>
                <tr>
                  <ThM label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                  <ThM label="ค่าคอมมิชชั่น" col="commissionNet" />
                  <ThM label="ต้นทุนรวม" col="cost" className="border-r border-blue-500" />
                  <ThM label="ยอดเก็บค่างวด" col="installmentPaid" />
                  <ThM label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                  <ThM label="รวมรายรับ" col="totalRevenue" className="border-r border-blue-500" />
                </tr>
              </thead>
              <tbody>
                {monthlyRows.length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                ) : (
                  monthlyRows.map((r, idx) => (
                    <tr key={r.ym} className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                      <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">{r.ym === "ไม่ระบุ" ? "ไม่ระบุ" : fmtMonthLabel(r.ym)}</td>
                      <td className="px-2 py-2 text-center text-sm">{r.count.toLocaleString("th-TH")}</td>
                      <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.financeAmount)}</td>
                      <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.commissionNet)}</td>
                      <td className="px-2 py-2 text-right text-sm text-orange-700 font-medium">{fmtMoney(r.cost)}</td>
                      <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.installmentPaid)}</td>
                      <td className="px-2 py-2 text-right text-sm text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                      <td className="px-2 py-2 text-right text-sm font-medium">{fmtMoney(r.totalRevenue)}</td>
                      <td className="px-2 py-2 text-right text-sm"><ProfitBadge value={r.profitLoss} /></td>
                    </tr>
                  ))
                )}
              </tbody>
              {monthlyRows.length > 0 && (
                <tfoot className="bg-blue-50 border-t-2 border-blue-200 font-semibold text-xs">
                  <tr>
                    <td className="px-3 py-2 text-gray-600">รวม {monthlyRows.length} เดือน</td>
                    <td className="px-2 py-2 text-center">{monthlyRows.reduce((s, r) => s + r.count, 0).toLocaleString("th-TH")}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(monthlyRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(monthlyRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                    <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(monthlyRows.reduce((s, r) => s + r.cost, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(monthlyRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                    <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(monthlyRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(monthlyRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                    <td className="px-2 py-2 text-right"><ProfitBadge value={monthlyRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          </div>
        )}
        {/* ╔════════════════ TAB 3: สรุปรายปี ════════════════ */}
        {!isLoading && activeTab === "yearly" && (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
          <div className="rounded-lg border border-gray-200 shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-purple-700 text-white sticky top-0 z-10">
                {/* Group header row */}
                <tr>
                  <ThY label="ปีที่ขาย" col="year" rowSpan={2} className="px-3 text-left border-r border-purple-500" />
                  <ThY label="จำนวน" col="count" rowSpan={2} className="border-r border-purple-500" />
                  <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-purple-500 border-r border-purple-500">ต้นทุน</th>
                  <th colSpan={3} className="px-2 py-1 text-center text-xs font-semibold border-b border-purple-500 border-r border-purple-500">รายรับ</th>
                  <ThY label="กำไร/ขาดทุน" col="profitLoss" rowSpan={2} />
                </tr>
                <tr>
                  <ThY label="ยอดจัดไฟแนนซ์" col="financeAmount" />
                  <ThY label="ค่าคอมมิชชั่น" col="commissionNet" />
                  <ThY label="ต้นทุนรวม" col="cost" className="border-r border-purple-500" />
                  <ThY label="ยอดเก็บค่างวด" col="installmentPaid" />
                  <ThY label="ยอดขายเครื่อง" col="deviceSaleAmount" />
                  <ThY label="รวมรายรับ" col="totalRevenue" className="border-r border-purple-500" />
                </tr>
              </thead>
              <tbody>
                {yearlyRows.length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400">ไม่พบข้อมูล</td></tr>
                ) : (
                  yearlyRows.map((r, idx) => (
                    <tr key={r.year} className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
                      <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">
                        {r.year === "ไม่ระบุ" ? "ไม่ระบุ" : `พ.ศ. ${parseInt(r.year, 10) + 543}`}
                      </td>
                      <td className="px-2 py-2 text-center text-sm">{r.count.toLocaleString("th-TH")}</td>
                      <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.financeAmount)}</td>
                      <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.commissionNet)}</td>
                      <td className="px-2 py-2 text-right text-sm text-orange-700 font-medium">{fmtMoney(r.cost)}</td>
                      <td className="px-2 py-2 text-right text-sm">{fmtMoney(r.installmentPaid)}</td>
                      <td className="px-2 py-2 text-right text-sm text-blue-700 font-medium">{fmtMoney(r.deviceSaleAmount)}</td>
                      <td className="px-2 py-2 text-right text-sm font-medium">{fmtMoney(r.totalRevenue)}</td>
                      <td className="px-2 py-2 text-right text-sm"><ProfitBadge value={r.profitLoss} /></td>
                    </tr>
                  ))
                )}
              </tbody>
              {yearlyRows.length > 0 && (
                <tfoot className="bg-purple-50 border-t-2 border-purple-200 font-semibold text-xs">
                  <tr>
                    <td className="px-3 py-2 text-gray-600">รวม {yearlyRows.length} ปี</td>
                    <td className="px-2 py-2 text-center">{yearlyRows.reduce((s, r) => s + r.count, 0).toLocaleString("th-TH")}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(yearlyRows.reduce((s, r) => s + r.financeAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(yearlyRows.reduce((s, r) => s + r.commissionNet, 0))}</td>
                    <td className="px-2 py-2 text-right text-orange-700">{fmtMoney(yearlyRows.reduce((s, r) => s + r.cost, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(yearlyRows.reduce((s, r) => s + r.installmentPaid, 0))}</td>
                    <td className="px-2 py-2 text-right text-blue-700">{fmtMoney(yearlyRows.reduce((s, r) => s + r.deviceSaleAmount, 0))}</td>
                    <td className="px-2 py-2 text-right">{fmtMoney(yearlyRows.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                    <td className="px-2 py-2 text-right"><ProfitBadge value={yearlyRows.reduce((s, r) => s + r.profitLoss, 0)} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          </div>
        )}

      </div>
    </AppShell>
  );
}

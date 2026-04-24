/**
 * BadDebtSummary — Phase 9k
 * หน้าสรุปกำไร/ขาดทุนจากหนี้เสีย
 *
 * แสดง:
 *   - Summary cards (จำนวนสัญญา, ยอดไฟแนนซ์, ยอดเก็บได้, กำไร/ขาดทุน)
 *   - ตารางรายสัญญา (เรียงจากขาดทุนมากสุด → กำไรมากสุด)
 *   - Filter: ค้นหาชื่อ/สัญญา, กรองตาม approve month
 */
import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Banknote,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  FileText,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
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
  return d.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

type SortKey =
  | "contractNo"
  | "approveDate"
  | "financeAmount"
  | "totalPaid"
  | "profitLoss";
type SortDir = "asc" | "desc";

/* ─── component ────────────────────────────────────────────────────────────── */
export default function BadDebtSummary() {
  const { can } = useAppAuth();
  const { section } = useSection();
  const canView = can("bad_debt_summary", "view");

  const [search, setSearch] = useState("");
  const [approveMonthFilter, setApproveMonthFilter] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("profitLoss");
  const [sortDir, setSortDir] = useState<SortDir>("asc"); // ขาดทุนมากสุดก่อน

  const query = trpc.badDebt.summary.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section },
  );

  const { rows = [], summary } = query.data ?? {};

  /* ── approve month options ── */
  const approveMonthOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r.approveDate) s.add(r.approveDate.slice(0, 7));
    }
    return Array.from(s).sort().reverse();
  }, [rows]);

  /* ── filtered + sorted rows ── */
  const filteredRows = useMemo(() => {
    let out = rows;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          (r.contractNo ?? "").toLowerCase().includes(q) ||
          (r.customerName ?? "").toLowerCase().includes(q) ||
          (r.phone ?? "").toLowerCase().includes(q),
      );
    }
    if (approveMonthFilter) {
      out = out.filter((r) => (r.approveDate ?? "").startsWith(approveMonthFilter));
    }
    return [...out].sort((a, b) => {
      let va: any, vb: any;
      switch (sortKey) {
        case "contractNo":
          va = a.contractNo ?? "";
          vb = b.contractNo ?? "";
          break;
        case "approveDate":
          va = a.approveDate ?? "";
          vb = b.approveDate ?? "";
          break;
        case "financeAmount":
          va = a.financeAmount;
          vb = b.financeAmount;
          break;
        case "totalPaid":
          va = a.totalPaid;
          vb = b.totalPaid;
          break;
        case "profitLoss":
        default:
          va = a.profitLoss;
          vb = b.profitLoss;
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [rows, search, approveMonthFilter, sortKey, sortDir]);

  /* ── filtered summary ── */
  const filteredSummary = useMemo(() => {
    let totalFinanceAmount = 0,
      totalPaid = 0,
      totalProfitLoss = 0,
      profitCount = 0,
      lossCount = 0;
    for (const r of filteredRows) {
      totalFinanceAmount += r.financeAmount;
      totalPaid += r.totalPaid;
      totalProfitLoss += r.profitLoss;
      if (r.profitLoss > 0) profitCount++;
      else if (r.profitLoss < 0) lossCount++;
    }
    return {
      contractCount: filteredRows.length,
      totalFinanceAmount,
      totalPaid,
      totalProfitLoss,
      profitCount,
      lossCount,
    };
  }, [filteredRows]);

  /* ── sort toggle ── */
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? (
      <ChevronUp className="w-3 h-3" />
    ) : (
      <ChevronDown className="w-3 h-3" />
    );
  };

  /* ── render ── */
  if (!canView) {
    return (
      <div className="flex items-center justify-center py-32 text-gray-400">
        <AlertTriangle className="w-5 h-5 mr-2" />
        คุณไม่มีสิทธิ์ดูหน้านี้
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-screen-2xl mx-auto">
          <h1 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <TrendingDown className="w-5 h-5 text-red-500" />
            สรุปหนี้เสีย
            {section && (
              <span className="ml-2 text-xs font-normal px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                {section}
              </span>
            )}
          </h1>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-4 py-4 space-y-4">
        {/* ── Summary Cards ── */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard
              label="สัญญาทั้งหมด"
              value={filteredSummary.contractCount.toLocaleString("th-TH")}
              sub={`จาก ${summary.contractCount.toLocaleString("th-TH")} สัญญา`}
              icon={<FileText className="w-4 h-4 text-gray-500" />}
              color="gray"
            />
            <SummaryCard
              label="ยอดจัดไฟแนนซ์"
              value={fmtMoney(filteredSummary.totalFinanceAmount)}
              icon={<Banknote className="w-4 h-4 text-blue-500" />}
              color="blue"
            />
            <SummaryCard
              label="ยอดเก็บได้"
              value={fmtMoney(filteredSummary.totalPaid)}
              icon={<Wallet className="w-4 h-4 text-emerald-500" />}
              color="emerald"
            />
            <SummaryCard
              label="กำไร/ขาดทุนรวม"
              value={fmtMoney(filteredSummary.totalProfitLoss)}
              icon={
                filteredSummary.totalProfitLoss >= 0 ? (
                  <TrendingUp className="w-4 h-4 text-emerald-500" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-red-500" />
                )
              }
              color={filteredSummary.totalProfitLoss >= 0 ? "emerald" : "red"}
              bold
            />
            <SummaryCard
              label="กำไร"
              value={filteredSummary.profitCount.toLocaleString("th-TH") + " สัญญา"}
              icon={<TrendingUp className="w-4 h-4 text-emerald-500" />}
              color="emerald"
            />
            <SummaryCard
              label="ขาดทุน"
              value={filteredSummary.lossCount.toLocaleString("th-TH") + " สัญญา"}
              icon={<TrendingDown className="w-4 h-4 text-red-500" />}
              color="red"
            />
          </div>
        )}

        {/* ── Filters ── */}
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            placeholder="ค้นหาชื่อ / เลขสัญญา / โทรศัพท์…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <select
            value={approveMonthFilter}
            onChange={(e) => setApproveMonthFilter(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="">เดือนอนุมัติ: ทั้งหมด</option>
            {approveMonthOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {(search || approveMonthFilter) && (
            <button
              onClick={() => {
                setSearch("");
                setApproveMonthFilter("");
              }}
              className="text-xs text-gray-500 underline hover:text-gray-700"
            >
              ล้างตัวกรอง
            </button>
          )}
        </div>

        {/* ── Table ── */}
        {query.isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Spinner />
          </div>
        ) : query.error ? (
          <div className="flex items-center justify-center py-20 text-red-500 gap-2">
            <AlertTriangle className="w-5 h-5" />
            {query.error.message}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            ไม่พบข้อมูล
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm bg-white">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-100 text-gray-600 text-left">
                  <th className="px-3 py-2 font-semibold border-b border-gray-200 w-8 text-center">
                    #
                  </th>
                  <SortTh label="เลขสัญญา" sortKey="contractNo" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <th className="px-3 py-2 font-semibold border-b border-gray-200">ชื่อลูกค้า</th>
                  <th className="px-3 py-2 font-semibold border-b border-gray-200">โทรศัพท์</th>
                  <SortTh label="วันอนุมัติ" sortKey="approveDate" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <th className="px-3 py-2 font-semibold border-b border-gray-200">รุ่น</th>
                  <th className="px-3 py-2 font-semibold border-b border-gray-200 text-right">ราคาขาย</th>
                  <SortTh label="ยอดไฟแนนซ์" sortKey="financeAmount" current={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <SortTh label="ยอดเก็บได้" sortKey="totalPaid" current={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <SortTh label="กำไร/ขาดทุน" sortKey="profitLoss" current={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <th className="px-3 py-2 font-semibold border-b border-gray-200 text-center">งวดที่ชำระ</th>
                  <th className="px-3 py-2 font-semibold border-b border-gray-200">วันที่หนี้เสีย</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, i) => {
                  const isProfit = r.profitLoss > 0;
                  const isLoss = r.profitLoss < 0;
                  return (
                    <tr
                      key={r.contractExternalId}
                      className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                        isLoss ? "bg-red-50/30" : isProfit ? "bg-emerald-50/30" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5 text-center text-gray-400">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-700">{r.contractNo ?? r.contractExternalId}</td>
                      <td className="px-3 py-1.5 text-gray-700">{r.customerName ?? "-"}</td>
                      <td className="px-3 py-1.5 text-gray-500">{r.phone ?? "-"}</td>
                      <td className="px-3 py-1.5 text-gray-500">{fmtDate(r.approveDate)}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.model ?? "-"}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{fmtMoney(r.salePrice)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-700">{fmtMoney(r.financeAmount)}</td>
                      <td className="px-3 py-1.5 text-right text-emerald-700 font-medium">{fmtMoney(r.totalPaid)}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-semibold ${
                          isProfit
                            ? "text-emerald-600"
                            : isLoss
                            ? "text-red-600"
                            : "text-gray-500"
                        }`}
                      >
                        {isProfit ? "+" : ""}
                        {fmtMoney(r.profitLoss)}
                      </td>
                      <td className="px-3 py-1.5 text-center text-gray-500">
                        {r.paidInstallments}
                        {r.installmentCount != null ? `/${r.installmentCount}` : ""}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500">{fmtDate(r.badDebtDate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── sub-components ────────────────────────────────────────────────────────── */
function SummaryCard({
  label,
  value,
  sub,
  icon,
  color,
  bold,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: "gray" | "blue" | "emerald" | "red";
  bold?: boolean;
}) {
  const bg = {
    gray: "bg-gray-50 border-gray-200",
    blue: "bg-blue-50 border-blue-200",
    emerald: "bg-emerald-50 border-emerald-200",
    red: "bg-red-50 border-red-200",
  }[color];
  const text = {
    gray: "text-gray-700",
    blue: "text-blue-700",
    emerald: "text-emerald-700",
    red: "text-red-700",
  }[color];
  return (
    <div className={`rounded-lg border p-3 ${bg}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[11px] text-gray-500">{label}</span>
      </div>
      <div className={`text-sm ${bold ? "font-bold" : "font-semibold"} ${text} leading-tight`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function SortTh({
  label,
  sortKey,
  current,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = current === sortKey;
  return (
    <th
      className={`px-3 py-2 font-semibold border-b border-gray-200 cursor-pointer select-none hover:bg-gray-200 transition-colors ${
        align === "right" ? "text-right" : "text-left"
      }`}
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        {active ? (
          dir === "asc" ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </span>
    </th>
  );
}

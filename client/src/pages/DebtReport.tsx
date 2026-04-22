import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import {
  AlertCircle,
  ArrowDownRight,
  Banknote,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/* --------------------------- utilities ---------------------------- */

function fmtBaht(n: number) {
  return n.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(n: number) {
  return `${(n * 100).toLocaleString("th-TH", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function fmtMonth(ym: string) {
  // "2026-04" -> "เม.ย. 2026"
  const [y, m] = ym.split("-");
  const months = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];
  const idx = Number(m) - 1;
  if (idx < 0 || idx > 11) return ym;
  return `${months[idx]} ${y}`;
}

/** Default range = current year (Jan 1 — Dec 31). */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/* ------------------------------ Page ----------------------------- */

export default function DebtReport() {
  const { section } = useSection();
  const { setActions } = useNavActions();
  const { can } = useAppAuth();

  const canView = can("debt_report", "view");
  const canExport = can("debt_report", "export");

  // Range state (applied only when user clicks "ดูรายงาน").
  const [input, setInput] = useState(defaultRange);
  const [applied, setApplied] = useState(defaultRange);

  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  // Reset applied range when section changes.
  useEffect(() => {
    setApplied(defaultRange());
    setInput(defaultRange());
  }, [section]);

  const summaryQuery = trpc.debt.summary.useQuery(
    {
      section: section!,
      from: applied.from,
      to: applied.to,
    },
    { enabled: Boolean(section) && canView, staleTime: 30_000 },
  );

  const overdueQuery = trpc.debt.overdueTop.useQuery(
    { section: section!, asOf: applied.to, limit: 15 },
    { enabled: Boolean(section) && canView, staleTime: 60_000 },
  );

  const summary = summaryQuery.data?.summary;
  const monthly = summaryQuery.data?.monthly ?? [];

  // Pick the month with the best collection rate for a quick highlight.
  const bestMonth = useMemo(() => {
    if (!monthly.length) return null;
    return monthly.reduce((a, b) => (b.rate > a.rate ? b : a));
  }, [monthly]);

  /* ---------------------------- Export ---------------------------- */

  const handleExport = async () => {
    if (!section) return;
    const params = new URLSearchParams({
      section,
      from: applied.from,
      to: applied.to,
    });
    const resp = await fetch(`/api/export/debt?${params.toString()}`, {
      credentials: "include",
    });
    if (!resp.ok) {
      alert("Export ล้มเหลว โปรดตรวจสอบสิทธิ์และลองอีกครั้ง");
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `DebtReport_${section}_${applied.from}_${applied.to}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* ---------------------------- Render ---------------------------- */

  if (!canView) {
    return (
      <AppShell>
        <div className="max-w-screen-md mx-auto px-4 py-12">
          <div className="bg-white border border-amber-200 rounded-xl p-8 text-center">
            <AlertCircle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
            <h1 className="text-lg font-semibold text-gray-900">ไม่มีสิทธิ์ดูรายงานหนี้</h1>
            <p className="text-sm text-gray-500 mt-1">
              กรุณาติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์ debt_report.view
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-screen-2xl mx-auto px-4 py-5 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
              <Banknote className="w-5 h-5 text-emerald-600" />
              รายงานหนี้
            </h1>
            <p className="text-sm text-gray-500">
              Section: <span className="font-medium">{section}</span>
            </p>
          </div>
        </div>

        {/* Range selector */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="grid gap-3 md:grid-cols-[auto_1fr_1fr_auto] md:items-end">
            <div>
              <label className="text-xs text-gray-500">ช่วงรายงาน</label>
              <div className="mt-1">
                <Select
                  value="custom"
                  onValueChange={(v) => {
                    const now = new Date();
                    const y = now.getFullYear();
                    if (v === "thisYear") {
                      setInput({ from: `${y}-01-01`, to: `${y}-12-31` });
                    } else if (v === "thisMonth") {
                      const mm = String(now.getMonth() + 1).padStart(2, "0");
                      const last = new Date(y, now.getMonth() + 1, 0).getDate();
                      setInput({
                        from: `${y}-${mm}-01`,
                        to: `${y}-${mm}-${String(last).padStart(2, "0")}`,
                      });
                    } else if (v === "lastMonth") {
                      const lm = new Date(y, now.getMonth() - 1, 1);
                      const mm = String(lm.getMonth() + 1).padStart(2, "0");
                      const last = new Date(
                        lm.getFullYear(),
                        lm.getMonth() + 1,
                        0,
                      ).getDate();
                      setInput({
                        from: `${lm.getFullYear()}-${mm}-01`,
                        to: `${lm.getFullYear()}-${mm}-${String(last).padStart(2, "0")}`,
                      });
                    }
                  }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="กำหนดเอง" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">กำหนดเอง</SelectItem>
                    <SelectItem value="thisYear">ปีปัจจุบัน</SelectItem>
                    <SelectItem value="thisMonth">เดือนปัจจุบัน</SelectItem>
                    <SelectItem value="lastMonth">เดือนก่อนหน้า</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">ตั้งแต่วันที่</label>
              <Input
                type="date"
                value={input.from}
                onChange={(e) =>
                  setInput((s) => ({ ...s, from: e.target.value }))
                }
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">ถึงวันที่</label>
              <Input
                type="date"
                value={input.to}
                onChange={(e) =>
                  setInput((s) => ({ ...s, to: e.target.value }))
                }
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => setApplied(input)}
                disabled={!input.from || !input.to}
              >
                ดูรายงาน
              </Button>
              {canExport && (
                <Button
                  variant="outline"
                  onClick={handleExport}
                  className="bg-white"
                >
                  Export
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            title="เป้าเก็บหนี้"
            value={summary ? fmtBaht(summary.target) : "—"}
            sub={summary ? `${summary.targetCount.toLocaleString()} งวด` : ""}
            icon={<Target className="w-5 h-5 text-blue-600" />}
            color="blue"
          />
          <SummaryCard
            title="ยอดเก็บหนี้"
            value={summary ? fmtBaht(summary.collected) : "—"}
            sub={
              summary
                ? `${summary.collectedCount.toLocaleString()} รายการ`
                : ""
            }
            icon={<TrendingUp className="w-5 h-5 text-emerald-600" />}
            color="emerald"
          />
          <SummaryCard
            title="คงค้างชำระ"
            value={summary ? fmtBaht(Math.max(summary.gap, 0)) : "—"}
            sub={
              summary && summary.gap < 0
                ? `ชำระเกินเป้า ${fmtBaht(-summary.gap)}`
                : ""
            }
            icon={<TrendingDown className="w-5 h-5 text-rose-600" />}
            color="rose"
          />
          <SummaryCard
            title="อัตราเก็บหนี้"
            value={summary ? fmtPct(summary.rate) : "—"}
            sub={
              bestMonth
                ? `สูงสุด ${fmtMonth(bestMonth.month)} (${fmtPct(bestMonth.rate)})`
                : ""
            }
            icon={<ArrowDownRight className="w-5 h-5 text-indigo-600" />}
            color="indigo"
          />
        </div>

        {/* Monthly table */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-medium text-gray-900">ยอดเก็บหนี้รายเดือน</h2>
            <span className="text-xs text-gray-500">
              {monthly.length} เดือน
            </span>
          </div>
          <div className="overflow-x-auto">
            {summaryQuery.isLoading ? (
              <div className="py-10 flex justify-center">
                <Spinner />
              </div>
            ) : monthly.length === 0 ? (
              <div className="py-10 text-center text-sm text-gray-500">
                ไม่มีข้อมูลในช่วงที่เลือก
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">เดือน</th>
                    <th className="px-4 py-2 text-right">เป้า (บาท)</th>
                    <th className="px-4 py-2 text-right">งวด</th>
                    <th className="px-4 py-2 text-right">เก็บได้ (บาท)</th>
                    <th className="px-4 py-2 text-right">รายการ</th>
                    <th className="px-4 py-2 text-right">ส่วนต่าง</th>
                    <th className="px-4 py-2 text-right">อัตรา</th>
                    <th className="px-4 py-2">ความคืบหน้า</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {monthly.map((m) => (
                    <tr key={m.month} className="hover:bg-gray-50/60">
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {fmtMonth(m.month)}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">
                        {fmtBaht(m.target)}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-500">
                        {m.targetCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right text-emerald-700">
                        {fmtBaht(m.collected)}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-500">
                        {m.collectedCount.toLocaleString()}
                      </td>
                      <td
                        className={`px-4 py-2 text-right ${
                          m.gap <= 0 ? "text-emerald-700" : "text-rose-700"
                        }`}
                      >
                        {fmtBaht(m.gap)}
                      </td>
                      <td className="px-4 py-2 text-right font-medium text-gray-900">
                        {fmtPct(m.rate)}
                      </td>
                      <td className="px-4 py-2 w-40">
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className={`h-2 ${
                              m.rate >= 0.9
                                ? "bg-emerald-500"
                                : m.rate >= 0.7
                                  ? "bg-amber-500"
                                  : "bg-rose-500"
                            }`}
                            style={{
                              width: `${Math.min(100, Math.max(0, m.rate * 100))}%`,
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Overdue top list */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-medium text-gray-900">
              สัญญาค้างชำระสูงสุด (ณ {applied.to})
            </h2>
            <span className="text-xs text-gray-500">
              {overdueQuery.data?.length ?? 0} สัญญา
            </span>
          </div>
          <div className="overflow-x-auto">
            {overdueQuery.isLoading ? (
              <div className="py-10 flex justify-center">
                <Spinner />
              </div>
            ) : (overdueQuery.data ?? []).length === 0 ? (
              <div className="py-10 text-center text-sm text-gray-500">
                ไม่มีสัญญาค้างชำระ
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">เลขที่สัญญา</th>
                    <th className="px-4 py-2 text-left">ลูกค้า</th>
                    <th className="px-4 py-2 text-left">โทรศัพท์</th>
                    <th className="px-4 py-2 text-right">ยอดที่ต้องชำระ</th>
                    <th className="px-4 py-2 text-right">ชำระแล้ว</th>
                    <th className="px-4 py-2 text-right">คงค้าง</th>
                    <th className="px-4 py-2 text-right">งวดค้าง</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {overdueQuery.data!.map((r) => (
                    <tr
                      key={`${r.contractExternalId ?? ""}-${r.contractNo ?? ""}`}
                      className="hover:bg-gray-50/60"
                    >
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {r.contractNo ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-gray-700">
                        {r.customerName ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-gray-500 whitespace-nowrap">
                        {r.phone ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">
                        {fmtBaht(r.dueAmount)}
                      </td>
                      <td className="px-4 py-2 text-right text-emerald-700">
                        {fmtBaht(r.paidAmount)}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-rose-700">
                        {fmtBaht(r.outstanding)}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-500">
                        {r.overdueCount.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/* ---------------------------- Sub parts --------------------------- */

function SummaryCard({
  title,
  value,
  sub,
  icon,
  color,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: "blue" | "emerald" | "rose" | "indigo";
}) {
  const bgMap: Record<typeof color, string> = {
    blue: "bg-blue-50",
    emerald: "bg-emerald-50",
    rose: "bg-rose-50",
    indigo: "bg-indigo-50",
  };
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center ${bgMap[color]}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-gray-500">{title}</div>
          <div className="text-base md:text-lg font-semibold text-gray-900 truncate">
            {value}
          </div>
          {sub ? <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div> : null}
        </div>
      </div>
    </div>
  );
}

import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { Badge } from "@/components/ui/badge";
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
import { useVirtualizer } from "@tanstack/react-virtual";
import { Coins, Download, Search, Target } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/* -------------------------------------------------------------------- */
/* Utilities                                                            */
/* -------------------------------------------------------------------- */

const DEBT_STATUSES = [
  "ปกติ",
  "เกิน 1-7",
  "เกิน 8-14",
  "เกิน 15-30",
  "เกิน 31-60",
  "เกิน 61-90",
  "เกิน >90",
  "ระงับสัญญา",
  "สิ้นสุดสัญญา",
  "หนี้เสีย",
] as const;

type DebtStatus = (typeof DEBT_STATUSES)[number];

function fmtMoney(n: number | null | undefined) {
  if (n == null || Number.isNaN(Number(n))) return "";
  const num = Number(n);
  if (num === 0) return "0.00";
  return num.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "-";
  return d.slice(0, 10);
}

/** Mapping: status label → Tailwind classes for the colored pill badge. */
function statusPillClasses(status: string): string {
  // Colors taken from boonphone.co.th/mm.html reference palette.
  switch (status) {
    case "ปกติ":
      return "bg-green-100 text-green-800 border-green-300";
    case "เกิน 1-7":
      return "bg-yellow-100 text-yellow-900 border-yellow-300";
    case "เกิน 8-14":
      return "bg-amber-200 text-amber-900 border-amber-400";
    case "เกิน 15-30":
      return "bg-orange-200 text-orange-900 border-orange-400";
    case "เกิน 31-60":
      return "bg-red-200 text-red-900 border-red-400";
    case "เกิน 61-90":
      return "bg-red-300 text-red-900 border-red-500";
    case "เกิน >90":
      return "bg-rose-700 text-white border-rose-800";
    case "ระงับสัญญา":
      return "bg-gray-800 text-white border-gray-900";
    case "สิ้นสุดสัญญา":
      return "bg-blue-100 text-blue-800 border-blue-300";
    case "หนี้เสีย":
      return "bg-gray-700 text-white border-gray-800";
    default:
      return "bg-gray-100 text-gray-700 border-gray-200";
  }
}

/* -------------------------------------------------------------------- */
/* Types                                                                */
/* -------------------------------------------------------------------- */

type InstallmentCell = {
  period: number | null;
  dueDate: string | null;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  /** ค่าปลดล็อก (unlock fee) for this period. */
  unlockFee?: number;
  amount: number;
  paid: number;
  /** Baseline per-contract installment amount (from contracts.installment_amount). */
  baselineAmount: number;
  /** Delta vs baseline: > 0 when API deducted overpaid from this period. */
  overpaidApplied: number;
  /** True when the period is reported as already closed (amount=0 with baseline>0). */
  isClosed: boolean;
  /** True when the period is ระงับสัญญา or หนี้เสีย. */
  isSuspended?: boolean;
  /** Label to render: "ระงับสัญญา" or "หนี้เสีย" (null when !isSuspended). */
  suspendLabel?: string | null;
  /** YYYY-MM-DD that the contract changed to suspended/bad-debt. */
  suspendedAt?: string | null;
  /** True when this period's displayed amounts include carry-forward from unpaid prior periods. */
  isArrears?: boolean;
  /** True when this is the current (first unpaid past/current) period — sky-50 BG highlight. */
  isCurrentPeriod?: boolean;
};

type PaymentCell = {
  /** Installment period (1..N) this payment was applied to. */
  period: number | null;
  /** 0 = primary row, >0 = sub-row "- แบ่งชำระ -". */
  splitIndex: number;
  isCloseRow: boolean;
  isBadDebtRow: boolean;
  paidAt: string | null;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  unlockFee: number;
  discount: number;
  overpaid: number;
  closeInstallmentAmount: number;
  badDebt: number;
  total: number;
  receiptNo: string | null;
  remark: string | null;
};

type TargetRow = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  installmentCount: number | null;
  installmentAmount: number | null;
  totalAmount: number;
  totalPaid: number;
  remaining: number;
  debtStatus: string;
  daysOverdue: number;
  installments: InstallmentCell[];
};

type CollectedRow = TargetRow & { payments: PaymentCell[] };

/* -------------------------------------------------------------------- */
/* Page                                                                 */
/* -------------------------------------------------------------------- */

export default function DebtReport() {
  const { can } = useAppAuth();
  const { section } = useSection();
  const { setActions } = useNavActions();

  const canView = can("debt_report", "view");
  const canExport = can("debt_report", "export");

  const [tab, setTab] = useState<"target" | "collected">("target");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  // Switch: true = เฉพาะเงินต้น (แสดง penalty/unlockFee = 0 ทุกงวด), false = รวมค่าปรับ+ค่าปลดล็อก
  const [principalOnly, setPrincipalOnly] = useState(true);

  // One-shot load per tab. Query disables itself when user lacks permission.
  const targetQuery = trpc.debt.listTarget.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section && tab === "target" },
  );
  const collectedQuery = trpc.debt.listCollected.useQuery(
    section ? { section } : (undefined as any),
    { enabled: canView && !!section && tab === "collected" },
  );

  const isLoading =
    tab === "target" ? targetQuery.isLoading : collectedQuery.isLoading;

  const activeRows: (TargetRow | CollectedRow)[] =
    (tab === "target"
      ? (targetQuery.data?.rows as TargetRow[])
      : (collectedQuery.data?.rows as CollectedRow[])) ?? [];

  /* ---- Filter (client-side) ---- */
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeRows.filter((r) => {
      if (statusFilter && r.debtStatus !== statusFilter) return false;
      if (!q) return true;
      return (
        (r.contractNo ?? "").toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q)
      );
    });
  }, [activeRows, search, statusFilter]);

  /* ---- Max periods for the repeating group block ---- */
  const maxPeriods = useMemo(() => {
    let max = 0;
    for (const r of filteredRows) {
      const n = r.installments.length;
      if (n > max) max = n;
    }
    // Cap at 36 to keep the DOM bounded; users can export for >36-งวด contracts.
    return Math.min(max, 36);
  }, [filteredRows]);

  /* ---- Per-row sub-rows: collected-tab payments grouped per period ---- */
  /** For collected tab, count max sub-rows per period across all rows so we
   * know how many cells the matrix needs in each group column. */
  // Currently unused at the matrix level (each row sizes itself), kept for
  // potential future use such as a global splitDepth-aware header.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
   const _splitDepth = useMemo(() => {
    if (tab !== "collected") return new Map<number, number>();
    const m = new Map<number, number>();
    for (const r of filteredRows as CollectedRow[]) {
      const perPeriod = new Map<number, number>();
      for (const p of r.payments ?? []) {
        if (p.period == null) continue;
        perPeriod.set(p.period, (perPeriod.get(p.period) ?? 0) + 1);
      }
      perPeriod.forEach((v, k) => {
        if (v > (m.get(k) ?? 0)) m.set(k, v);
      });
    }
    return m;
  }, [filteredRows, tab]);

  /** Per row "line count" = max number of sub-rows that any of its periods has. */
  function rowLineCount(r: CollectedRow): number {
    if (tab !== "collected") return 1;
    let max = 1;
    const perPeriod = new Map<number, number>();
    for (const p of r.payments ?? []) {
      if (p.period == null) continue;
      perPeriod.set(p.period, (perPeriod.get(p.period) ?? 0) + 1);
    }
    perPeriod.forEach((v) => {
      if (v > max) max = v;
    });
    return max;
  }

  /* ---- TopNav actions (sync + export) ---- */
  useEffect(() => {
    const handleExport = async () => {
      if (!section) return;
      const params = new URLSearchParams({ section, variant: tab });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
      try {
        const resp = await fetch(`/api/export/debt?${params.toString()}`, {
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
        a.download = `debt_${tab}_${section}_${new Date()
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

    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar />
        {canExport && (
          <Button
            size="sm"
            variant="outline"
            className="bg-white"
            onClick={handleExport}
          >
            <Download className="w-4 h-4 mr-1.5" />
            ดาวน์โหลดไฟล์
          </Button>
        )}
      </div>,
    );
    return () => setActions(null);
  }, [setActions, canExport, section, tab, search, statusFilter]);

  /* ---- Virtual scroll ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 40;
  const SUB_ROW_HEIGHT = 32;
  // collected tab rows can have multiple sub-rows for split payments;
  // give the virtualizer an estimate per row for accurate scrollbar.
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      if (tab !== "collected") return ROW_HEIGHT;
      const r = filteredRows[i] as CollectedRow;
      const lines = rowLineCount(r);
      return ROW_HEIGHT + (lines - 1) * SUB_ROW_HEIGHT;
    },
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? totalSize - virtualRows[virtualRows.length - 1].end
    : 0;

  /* ---- Render ---- */
  if (!canView) {
    return (
      <AppShell>
        <div className="p-6 text-gray-500">
          คุณไม่มีสิทธิ์เข้าถึงหน้ารายงานหนี้
        </div>
      </AppShell>
    );
  }

  // Column widths (px) for the left-fixed block.
  const LEFT_COLS = [
    { key: "approveDate", label: "วันที่อนุมัติ", width: 110 },
    { key: "contractNo", label: "เลขที่สัญญา", width: 195 },
    { key: "customerName", label: "ชื่อ-นามสกุล", width: 260 },
    { key: "phone", label: "เบอร์โทร", width: 110 },
    { key: "totalAmount", label: "ยอดผ่อนรวม", width: 110, align: "right" },
    { key: "installmentCount", label: "งวดผ่อน", width: 70, align: "right" },
    {
      key: "installmentAmount",
      label: "ผ่อนงวดละ",
      width: 100,
      align: "right",
    },
    { key: "debtStatus", label: "สถานะหนี้", width: 110 },
    { key: "daysOverdue", label: "เกินกำหนด", width: 90, align: "right" },
  ] as const;

  // Per-period group sub-columns (mirrors reference layout exactly).
  const groupCols =
    tab === "target"
      ? [
          { key: "period", label: "งวดที่", width: 55 },
          { key: "dueDate", label: "วันที่ต้องชำระ", width: 105 },
          { key: "principal", label: "เงินต้น", width: 90, align: "right" },
          { key: "interest", label: "ดอกเบี้ย", width: 90, align: "right" },
          { key: "fee", label: "ค่าดำเนินการ", width: 95, align: "right" },
          { key: "penalty", label: "ค่าปรับ", width: 80, align: "right" },
          { key: "unlockFee", label: "ค่าปลดล็อก", width: 90, align: "right" },
          { key: "amount", label: "ยอดหนี้รวม", width: 115, align: "right" },
        ]
      : [
          // collected tab: ซ่อน closeInstallmentAmount (ซ้ำซ้อนกับ principal+interest+fee)
          { key: "period", label: "งวดที่", width: 55 },
          { key: "paidAt", label: "วันที่ชำระ", width: 100 },
          { key: "principal", label: "เงินต้น", width: 80, align: "right" },
          { key: "interest", label: "ดอกเบี้ย", width: 80, align: "right" },
          { key: "fee", label: "ค่าดำเนินการ", width: 95, align: "right" },
          { key: "penalty", label: "ค่าปรับ", width: 70, align: "right" },
          { key: "unlockFee", label: "ค่าปลดล็อก", width: 80, align: "right" },
          { key: "discount", label: "ส่วนลด", width: 70, align: "right" },
          { key: "overpaid", label: "ชำระเกิน", width: 80, align: "right" },
          { key: "badDebt", label: "หนี้เสีย", width: 80, align: "right" },
          { key: "total", label: "ยอดที่ชำระรวม", width: 100, align: "right" },
        ];

  const GROUP_WIDTH = groupCols.reduce((s, c) => s + c.width, 0);
  const LEFT_WIDTH = LEFT_COLS.reduce((s, c) => s + c.width, 0);

  return (
    <AppShell>
      <div className="max-w-[1600px] mx-auto px-3 md:px-5 py-4">
        {/* Title + Tabs */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
          <h1 className="text-xl font-semibold">รายงานหนี้</h1>
          <div className="flex items-center gap-2">
            <Button
              variant={tab === "target" ? "default" : "outline"}
              className={
                tab === "target"
                  ? "bg-amber-600 hover:bg-amber-700 text-white border-amber-600"
                  : "bg-gray-200 hover:bg-gray-300 text-gray-600 border-gray-200"
              }
              onClick={() => setTab("target")}
            >
              <Target className="w-4 h-4 mr-1.5" />
              เป้าเก็บหนี้
            </Button>
            <Button
              variant={tab === "collected" ? "default" : "outline"}
              className={
                tab === "collected"
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600"
                  : "bg-gray-200 hover:bg-gray-300 text-gray-600 border-gray-200"
              }
              onClick={() => setTab("collected")}
            >
              <Coins className="w-4 h-4 mr-1.5" />
              ยอดเก็บหนี้
            </Button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="ค้นหา: เลขที่สัญญา / ชื่อลูกค้า / เบอร์โทร"
              className="pl-9 bg-white"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={statusFilter || "__all__"}
              onValueChange={(v) => setStatusFilter(v === "__all__" ? "" : v)}
            >
              <SelectTrigger className="w-[180px] bg-white">
                <SelectValue placeholder="ทุกสถานะหนี้" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">ทุกสถานะหนี้</SelectItem>
                {DEBT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tab === "target" && (
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5">
                <Switch
                  id="principal-only"
                  checked={principalOnly}
                  onCheckedChange={setPrincipalOnly}
                />
                <label
                  htmlFor="principal-only"
                  className="text-xs text-gray-600 cursor-pointer select-none whitespace-nowrap"
                >
                  เฉพาะเงินต้น
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Summary line */}
        <div className="text-xs text-gray-500 mb-2">
          ทั้งหมด {activeRows.length.toLocaleString("th-TH")} สัญญา · แสดง{" "}
          {filteredRows.length.toLocaleString("th-TH")} รายการ ·{" "}
          {tab === "target" ? "ข้อมูลเป้าเก็บหนี้" : "ข้อมูลยอดเก็บหนี้"} ของงวดที่{" "}
          1–{maxPeriods || "-"}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Spinner />
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="border rounded-lg bg-white overflow-auto"
            style={{ maxHeight: "calc(100vh - 220px)" }}
          >
            <div style={{ width: LEFT_WIDTH + GROUP_WIDTH * maxPeriods }}>
              {/* Header row */}
              <div className="sticky top-0 z-20 bg-white">
                {/* Tier 1: group header over installment columns */}
                <div className="flex border-b bg-slate-100 text-[12px] font-semibold text-slate-700">
                  <div
                    className="bg-slate-100 border-r"
                    style={{ width: LEFT_WIDTH, height: 28 }}
                  />
                  {Array.from({ length: maxPeriods }, (_, i) => (
                    <div
                      key={`gh-${i}`}
                      className="border-r text-center flex items-center justify-center text-white"
                      style={{
                        width: GROUP_WIDTH,
                        height: 28,
                        background:
                          // amber-700 for target, emerald-700 for collected
                          tab === "target" ? "#b45309" : "#047857",
                      }}
                    >
                      ข้อมูลชำระงวดที่ {i + 1}
                    </div>
                  ))}
                </div>
                {/* Tier 2: left columns + sub-columns of each group */}
                <div className="flex border-b bg-slate-50 text-[12px] font-semibold text-slate-700">
                  {LEFT_COLS.map((c) => (
                    <div
                      key={c.key}
                      className="px-2 py-2 border-r whitespace-nowrap"
                      style={{
                        width: c.width,
                        textAlign:
                          (c as any).align === "right" ? "right" : "left",
                      }}
                    >
                      {c.label}
                    </div>
                  ))}
                  {Array.from({ length: maxPeriods }, (_, i) =>
                    groupCols.map((gc) => {
                      // Alternating tint per reference (indigo-50 / indigo-100 for target,
                      // rose-50 flat for collected).
                      const subBg =
                        // target: amber-50 / amber-100 alternating; collected: emerald-50 flat
                        tab === "target"
                          ? i % 2 === 0
                            ? "#fffbeb" // amber-50
                            : "#fef3c7" // amber-100
                          : "#ecfdf5"; // emerald-50
                      const subColor =
                        // amber-900 for target, emerald-900 for collected
                        tab === "target" ? "#78350f" : "#064e3b";
                      return (
                        <div
                          key={`h-${i}-${gc.key}`}
                          className="px-2 py-2 border-r whitespace-nowrap"
                          style={{
                            width: gc.width,
                            textAlign:
                              (gc as any).align === "right" ? "right" : "left",
                            background: subBg,
                            color: subColor,
                          }}
                        >
                          {gc.label}
                        </div>
                      );
                    }),
                  )}
                </div>
              </div>

              {/* Body (virtualized) */}
              <div style={{ paddingTop, paddingBottom }}>
                {virtualRows.map((vr) => {
                  const r = filteredRows[vr.index];
                  // For collected tab, compute sub-row count to size the row.
                  const lineCount =
                    tab === "collected"
                      ? rowLineCount(r as CollectedRow)
                      : 1;
                  const rowH =
                    ROW_HEIGHT + (lineCount - 1) * SUB_ROW_HEIGHT;
                  // Build per-period payments map for collected tab
                  const paymentsByPeriod = new Map<number, PaymentCell[]>();
                  if (tab === "collected") {
                    for (const p of (r as CollectedRow).payments ?? []) {
                      if (p.period == null) continue;
                      if (!paymentsByPeriod.has(p.period))
                        paymentsByPeriod.set(p.period, []);
                      paymentsByPeriod.get(p.period)!.push(p);
                    }
                  }
                  return (
                    <div
                      key={vr.key}
                      className="flex border-b text-[12px] hover:bg-slate-50"
                      style={{ height: rowH }}
                    >
                      {/* Left fixed columns — no `truncate`: show full text,
                          especially for long contract numbers. */}
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{ width: LEFT_COLS[0].width }}
                      >
                        {fmtDate(r.approveDate)}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{ width: LEFT_COLS[1].width }}
                        title={r.contractNo ?? undefined}
                      >
                        {r.contractNo ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{ width: LEFT_COLS[2].width }}
                        title={r.customerName ?? undefined}
                      >
                        {r.customerName ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{ width: LEFT_COLS[3].width }}
                      >
                        {r.phone ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{ width: LEFT_COLS[4].width }}
                      >
                        {fmtMoney(r.totalAmount)}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{ width: LEFT_COLS[5].width }}
                      >
                        {r.installmentCount ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{ width: LEFT_COLS[6].width }}
                      >
                        {fmtMoney(r.installmentAmount)}
                      </div>
                      <div
                        className="px-2 py-1.5 border-r"
                        style={{ width: LEFT_COLS[7].width }}
                      >
                        <Badge
                          variant="outline"
                          className={`${statusPillClasses(
                            r.debtStatus,
                          )} font-medium`}
                        >
                          {r.debtStatus}
                        </Badge>
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{ width: LEFT_COLS[8].width }}
                      >
                        {r.daysOverdue > 0 ? r.daysOverdue : 0}
                      </div>
                      {/* Repeating groups */}
                      {Array.from({ length: maxPeriods }, (_, i) => {
                        const periodNo = i + 1;
                        if (tab === "target") {
                          const inst = r.installments[i];
                          const closed = !!inst?.isClosed;
                          const suspended = !!inst?.isSuspended;
                          const suspendLabel = inst?.suspendLabel ?? "ระงับสัญญา";
                          // Grey-out applies to both closed AND suspended cells.
                          const dimmed = closed || suspended;
                          return groupCols.map((gc) => {
                            let v: any = "";
                            let annotation: string | null = null;
                            let annotationClass = "";
                            if (inst) {
                              if (gc.key === "period") {
                                // Period number stays visible on closed/suspended rows too.
                                v = inst.period ?? periodNo;
                              } else if (gc.key === "dueDate") {
                                // For suspended/bad-debt: show the status-change date
                                // (suspendedAt) instead of the scheduled due date —
                                // user rule 2026-04-23.
                                if (suspended && inst.suspendedAt) {
                                  v = fmtDate(inst.suspendedAt);
                                } else {
                                  v = fmtDate(inst.dueDate);
                                }
                              } else if (gc.key === "principal") {
                                v = dimmed ? "0" : fmtMoney(inst.principal);
                              } else if (gc.key === "interest") {
                                v = dimmed ? "0" : fmtMoney(inst.interest);
                              } else if (gc.key === "fee") {
                                v = dimmed ? "0" : fmtMoney(inst.fee);
                              } else if (gc.key === "penalty") {
                                // Bug 2 fix (Phase 9AA): Switch เฉพาะเงินต้น applies to ALL periods
                                // including past periods. The "past periods show real values" rule
                                // applies to principal/interest/fee/amount only, NOT penalty/unlockFee.
                                v = dimmed ? "0" : fmtMoney(principalOnly ? 0 : (inst.penalty ?? 0));
                              } else if (gc.key === "unlockFee") {
                                // Bug 2 fix (Phase 9AA): same as penalty — switch applies to all periods
                                v = dimmed ? "0" : fmtMoney(principalOnly ? 0 : (inst.unlockFee ?? 0));
                              } else if (gc.key === "amount") {
                                if (suspended) {
                                  // แสดงลาเบลสถานะในคอลัมน์ยอดรวม
                                  v = suspendLabel;
                                } else if (closed) {
                                  v = "ปิดค่างวดแล้ว";
                                } else {
                                  // Phase 9AF: amount = principal+interest+fee always as base.
                                  // When principalOnly=ON → show base only (no penalty/unlockFee).
                                  // When principalOnly=OFF → add penalty+unlockFee on top.
                                  const penalty = inst.penalty ?? 0;
                                  const unlockFee = inst.unlockFee ?? 0;
                                  // base = inst.amount already has penalty/unlockFee baked in
                                  // (from debtDb arrears pass). Strip them out to get the base.
                                  const baseAmount = Math.max(0, inst.amount - penalty - unlockFee);
                                  const displayAmount = principalOnly
                                      ? baseAmount
                                      : inst.amount; // full amount incl. penalty+unlockFee
                                  v = fmtMoney(displayAmount);
                                  if (
                                    inst.overpaidApplied > 0.009 &&
                                    inst.baselineAmount > inst.amount + 0.009
                                  ) {
                                    annotation = `(-หักชำระเกิน: ${fmtMoney(inst.overpaidApplied)})`;
                                    annotationClass = "text-emerald-600 font-semibold";
                                  }
                                }
                              }
                            }
                            const isArrears = !dimmed && !!inst?.isArrears;
                            const isCurrentPeriod = !dimmed && !!inst?.isCurrentPeriod;
                            const baseStyle: Record<string, string | number> = {
                              width: gc.width,
                              textAlign:
                                (gc as any).align === "right"
                                  ? "right"
                                  : "left",
                            };
                            if (dimmed) {
                              baseStyle.background = "#f3f4f6"; // gray-100
                              baseStyle.color = "#9ca3af"; // gray-400
                              baseStyle.fontStyle = "italic";
                            } else if (isArrears) {
                              // Arrears carry: amber-100 bg + amber-800 bold text
                              // to signal "this amount includes unpaid from prior periods"
                              baseStyle.background = "#fef3c7"; // amber-100
                              baseStyle.color = "#92400e"; // amber-800
                              baseStyle.fontWeight = "700";
                            } else if (isCurrentPeriod) {
                              // Current period: sky-50 BG to make it easy to spot
                              // without needing to read the due date column.
                              baseStyle.background = "#f0f9ff"; // sky-50
                            }
                            const tooltip = suspended
                              ? suspendLabel
                              : closed
                              ? "ปิดค่างวดแล้ว"
                              : (annotation ?? undefined);
                            return (
                              <div
                                key={`c-${vr.index}-${i}-${gc.key}`}
                                className={
                                  dimmed
                                    ? "px-2 py-2 border-r whitespace-nowrap"
                                    : "px-2 py-2 border-r whitespace-nowrap tabular-nums"
                                }
                                style={baseStyle}
                                title={tooltip}
                              >
                                <div>{v}</div>
                                {annotation && (
                                  <div
                                    className={`text-[10px] leading-tight ${annotationClass}`}
                                  >
                                    {annotation}
                                  </div>
                                )}
                              </div>
                            );
                          });
                        }
                        // ---------- Collected tab ----------
                        const pays = paymentsByPeriod.get(periodNo) ?? [];

                        // Phase 9N: "inactive period" in collected tab.
                        // A period is inactive (grey out) when:
                        //   1. periodNo > installmentCount — the contract has
                        //      fewer periods than the table's maxPeriods, so
                        //      this column doesn't apply to this contract.
                        //   2. The contract is suspended or bad-debt AND the
                        //      period has no payment recorded — no need to
                        //      collect, show as grey placeholder.
                        const instCount = r.installmentCount ?? maxPeriods;
                        const contractSuspended =
                          r.debtStatus === "ระงับสัญญา" ||
                          r.debtStatus === "หนี้เสีย";
                        const isInactivePeriod =
                          periodNo > instCount ||
                          (contractSuspended && pays.length === 0);

                        // Vertical stack: one cell per group sub-column,
                        // with N inner lines for N split payments.
                        return groupCols.map((gc, gcIdx) => {
                          return (
                            <div
                              key={`c-${vr.index}-${i}-${gc.key}`}
                              className="border-r tabular-nums"
                              style={{
                                width: gc.width,
                                textAlign:
                                  (gc as any).align === "right"
                                    ? "right"
                                    : "left",
                                // Grey background for inactive periods
                                background: isInactivePeriod ? "#f3f4f6" : undefined,
                              }}
                            >
                              {Array.from({ length: lineCount }, (_, li) => {
                                const pay = pays[li];
                                let v: any = "";
                                // Phase 9M: highlight close-contract payment
                                // rows with pink background + left accent
                                // on the first ("period") column of each
                                // group.
                                const isCloseCell = !!pay && pay.isCloseRow;
                                if (pay) {
                                  switch (gc.key) {
                                    case "period":
                                      // Always show the receipt's sequence per period.
                                      // First payment of period P → "P-1", second → "P-2", etc.
                                      v = `${periodNo}-${(pay.splitIndex ?? 0) + 1}`;
                                      break;
                                    case "paidAt":
                                      v = fmtDate(pay.paidAt);
                                      break;
                                    case "principal":
                                      v = fmtMoney(pay.principal);
                                      break;
                                    case "interest":
                                      v = fmtMoney(pay.interest);
                                      break;
                                    case "fee":
                                      v = fmtMoney(pay.fee);
                                      break;
                                    case "penalty":
                                      v = fmtMoney(pay.penalty || 0);
                                      break;
                                    case "unlockFee":
                                      v = fmtMoney(pay.unlockFee || 0);
                                      break;
                                    case "discount":
                                      v = fmtMoney(pay.discount || 0);
                                      break;
                                    case "overpaid":
                                      v = fmtMoney(pay.overpaid || 0);
                                      break;
                                    case "closeInstallmentAmount":
                                      v = pay.isCloseRow
                                        ? fmtMoney(pay.closeInstallmentAmount)
                                        : fmtMoney(0);
                                      break;
                                    case "badDebt":
                                      v = fmtMoney(pay.badDebt || 0);
                                      break;
                                    case "total":
                                      v = fmtMoney(pay.total);
                                      break;
                                  }
                                }
                                // Grey-italic zero when cell is empty/zero so every
                                // row has a value, but visually muted.
                                const isZeroish =
                                  pay && (v === fmtMoney(0) || v === "0" || v === "0.00");
                                const isEmptyCell = !pay;

                                // Phase 9N: inactive period overrides all
                                // other styling — grey text, no close highlight.
                                let textClass: string;
                                let cellBg: string | undefined;
                                let cellBorderLeft: string | undefined;
                                if (isInactivePeriod) {
                                  textClass = "text-gray-400 italic";
                                  cellBg = undefined; // parent div already grey
                                  cellBorderLeft = undefined;
                                } else if (isCloseCell) {
                                  // TXRTC close row: rose-50 bg + rose-700 text
                                  // 0.00 values use rose-300 italic (faded)
                                  const isZeroInClose = isZeroish;
                                  textClass = isZeroInClose
                                    ? "text-rose-300 italic"
                                    : "text-rose-700";
                                  cellBg = "#fff1f2"; // rose-50
                                  cellBorderLeft =
                                    gcIdx === 0
                                      ? "4px solid #fb7185" // rose-400
                                      : undefined;
                                } else {
                                  // Per-field styling rules:
                                  //   penalty  → red text
                                  //   overpaid → green bold
                                  //   badDebt  → red bold
                                  //   total    → bold
                                  //   zero/empty → grey italic
                                  if (pay && !isZeroish) {
                                    if (gc.key === "penalty" && (pay.penalty ?? 0) > 0) {
                                      textClass = "text-red-600";
                                    } else if (gc.key === "unlockFee" && (pay.unlockFee ?? 0) > 0) {
                                      // Phase 9AG: ค่าปลดล็อก → สีส้ม ตัวหนา
                                      textClass = "text-orange-600 font-bold";
                                    } else if (gc.key === "discount" && (pay.discount ?? 0) > 0) {
                                      // Phase 9AG: ส่วนลด → สีแดง ตัวเอียง
                                      textClass = "text-red-600 italic";
                                    } else if (gc.key === "overpaid" && (pay.overpaid ?? 0) > 0) {
                                      textClass = "text-emerald-600 font-bold";
                                    } else if (gc.key === "badDebt" && (pay.badDebt ?? 0) > 0) {
                                      // Phase 9AG: หนี้เสีย → สีแดง ตัวหนา
                                      textClass = "text-red-700 font-bold";
                                    } else if (gc.key === "total") {
                                      textClass = "font-bold";
                                    } else {
                                      textClass = "";
                                    }
                                  } else {
                                    textClass =
                                      isEmptyCell || isZeroish
                                        ? "text-gray-400 italic"
                                        : "";
                                  }
                                  cellBg = undefined;
                                  cellBorderLeft = undefined;
                                }

                                return (
                                  <div
                                    key={`c-${vr.index}-${i}-${gc.key}-${li}`}
                                    className={`px-2 truncate py-2 ${textClass}`}
                                    style={{
                                      height:
                                        li === 0 ? ROW_HEIGHT : SUB_ROW_HEIGHT,
                                      lineHeight:
                                        li === 0 ? `${ROW_HEIGHT - 16}px` : `${SUB_ROW_HEIGHT - 12}px`,
                                      background: cellBg,
                                      borderLeft: cellBorderLeft,
                                    }}
                                    title={
                                      isInactivePeriod
                                        ? (periodNo > instCount
                                            ? "ไม่มีงวดนี้ในสัญญา"
                                            : "ระงับ/หนี้เสีย")
                                        : (pay?.remark ?? pay?.receiptNo ?? undefined)
                                    }
                                  >
                                    {v}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        });
                      })}
                    </div>
                  );
                })}
              </div>
              {filteredRows.length === 0 && (
                <div className="text-center py-12 text-gray-500 text-sm">
                  ไม่พบข้อมูล
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}


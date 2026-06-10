import React from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BadgeDollarSign,
  Banknote,
  BarChart2,
  CalendarDays,
  Camera,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  ChevronsUpDown,
  CircleDollarSign,
  Coins,
  Download,
  Gavel,
  Info,
  LockOpen,
  Percent,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Smartphone,
  Tag,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

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
  "ยกเลิกสัญญา",
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

/** Format datetime string as DD/MM/YYYY HH:mm (Thai-friendly) */
function fmtDateTime(d: string | null | undefined) {
  if (!d) return "-";
  // Handle both "YYYY-MM-DD HH:mm:ss" and "YYYY-MM-DDTHH:mm:ss" formats
  const dt = new Date(d.replace(" ", "T"));
  if (isNaN(dt.getTime())) return d.slice(0, 16).replace("T", " ");
  const day = String(dt.getDate()).padStart(2, "0");
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const year = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hh}:${mm}`;
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
    case "ยกเลิกสัญญา":
      return "bg-red-100 text-red-700 border-red-300";
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
  /** Phase 9AH: principal+interest+fee only (no penalty/unlockFee). Used for principalOnly display. */
  netAmount?: number;
  /** True when this period has been fully paid (principal reduced to 0). Used for green text styling. */
  isPaid?: boolean;
  /** True when dueDate > cutoffDate (computed at snapshot time for WYSIWYS). */
  isFuturePeriod?: boolean;
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
  /** tooltip สำหรับ bad debt rows: "ยอดขายเครื่อง X บาท (DD/MM/YYYY)" */
  badDebtNote?: string | null;
  /** ผู้บันทึก (updated_by จาก API) */
  updatedBy?: string | null;
  /** วันที่บันทึก (updated_at จาก API) */
  updatedAt?: string | null;
  /**
   * Pattern B: pt.amount = 0 แต่ penalty_paid > 0
   * รายการทวงค่าปรับเพิ่มเติม — ไม่นับในยอดรวม, แสดงสีแถวต่างจากปกติ
   */
  isExtraPenalty?: boolean;
};

type TargetRow = {
  contractExternalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  productType: string | null;
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

/* -------------------------------------------------------------------- */
/* StatusMultiSelect component                                         */
/* -------------------------------------------------------------------- */
function StatusMultiSelect({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  // Close on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const toggle = (s: string) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(next);
  };
  const label =
    selected.size === 0
      ? "ทุกสถานะหนี้"
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} สถานะ`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px] justify-between"
      >
        <span className="truncate">{label}</span>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-[200px] bg-white border border-gray-200 rounded-md shadow-lg py-1 max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.size === 0 ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
              {selected.size === 0 && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </span>
            ทุกสถานะหนี้
          </button>
          <div className="border-t border-gray-100 my-1" />
          {DEBT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
            >
              <span className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 " + (selected.has(s) ? "bg-blue-500 border-blue-500" : "border-gray-300")}>
                {selected.has(s) && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
              </span>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Generic multi-select filter using Popover + Command pattern */
function MultiSelectFilter({
  label,
  selected,
  onChange,
  options,
  placeholder = "ทั้งหมด",
}: {
  label: string;
  selected: Set<string>;
  onChange: (v: Set<string>) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const toggle = (s: string) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(next);
  };
  const labelText =
    selected.size === 0
      ? placeholder
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} รายการ`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px] justify-between ${
            selected.size > 0
              ? "border-indigo-400 bg-indigo-50 text-indigo-800 font-medium"
              : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
          }`}
        >
          <span className="truncate">{labelText}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={`ค้นหา ${label}...`} className="h-8 text-sm" />
          <CommandList>
            <CommandEmpty>ไม่พบตัวเลือก</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                onSelect={() => { onChange(new Set()); setOpen(false); }}
              >
                <Check className={`mr-2 h-3.5 w-3.5 ${selected.size === 0 ? "opacity-100 text-indigo-600" : "opacity-0"}`} />
                <span className={selected.size === 0 ? "text-indigo-600 font-medium" : "text-gray-500"}>
                  {placeholder}
                </span>
              </CommandItem>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={(v) => {
                    const original = options.find((o) => o.toLowerCase() === v) ?? v;
                    toggle(original);
                  }}
                >
                  <Check className={`mr-2 h-3.5 w-3.5 ${selected.has(opt) ? "opacity-100 text-indigo-600" : "opacity-0"}`} />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}


export default function DebtReport() {
  const { can, isSuperAdmin, isLoading: isAuthLoading } = useAppAuth();
  const { section } = useSection();
  const sectionKey = (section ?? "") as any;
  const { setActions } = useNavActions();
  const canView = can("debt_report", "view");
  const canExport = can("debt_report", "export");

  const [tab, setTab] = useState<"target" | "collected">("target");


  // ── Snapshot lightbox state (ยอดเก็บหนี้ ค่างวด — freeze ตลอด) ─────────────────
  const [snapshotLightbox, setSnapshotLightbox] = useState<{ snapshotMonth: string; upToMonth: string } | null>(null);
  // ── Target Snapshot lightbox state (เป้าเก็บหนี้ — freeze ณ วันที่ 1) ─────────────────
  const [targetSnapshotLightbox, setTargetSnapshotLightbox] = useState<{ snapshotMonth: string } | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  // New filters: month-year approve date, month-year due date, product type
  const [approveDateFilter, setApproveDateFilter] = useState<Set<string>>(new Set());
  const [dueDateFilter, setDueDateFilter] = useState<Set<string>>(new Set());
  const [productTypeFilter, setProductTypeFilter] = useState<Set<string>>(new Set());
  // Phase 23: exact date filter (YYYY-MM-DD)
  // target tab = วันที่ที่ต้องชำระ (dueDate), collected tab = วันที่ที่ชำระ (paidAt)
  // When set, masks cells whose date != selected date (does NOT hide the row)
  const [dueDateExact, setDueDateExact] = useState<string | null>(null);
  // Phase 26: badge visibility toggle for collected tab
  // discount is always false (cannot be toggled on)
  const [badgeVisibility, setBadgeVisibility] = useState<Record<string, boolean>>({
    principal: true,
    interest: true,
    fee: true,
    penalty: true,
    unlockFee: true,
    overpaid: true,
    badDebt: true,
    discount: false, // always off — not collected money
    extraPenalty: true, // Pattern B: ค่าปรับเพิ่มเติม — ไม่นับในยอดรวม (badge แสดงเพื่อข้อมูลเท่านั้น)
  });
  const toggleBadge = (key: string) => {
    if (key === "discount") return; // cannot toggle discount
    if (key === "extraPenalty") return; // extraPenalty badge is display-only
    setBadgeVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  // Switch: true = เฉพาะเงินต้น (แสดง penalty/unlockFee = 0 ทุกงวด), false = รวมค่าปรับ+ค่าปลดล็อก
  const [principalOnly, setPrincipalOnly] = useState(true);
  // สวิต "ตั้งเป้า" (target tab only): เมื่อเปิด ซ่อนแถวที่ชำระครบ/ล่วงหน้า/ระงับ/สิ้นสุด/หนี้เสีย/ยังไม่ถึงดิว
  const [debtSetMode, setDebtSetMode] = useState(false);
  // cutoff mode สำหรับ debtSetMode: 'today' = ณ วันที่ปัจจุบัน, 'end_of_month' = ณ เดือนปัจจุบัน
  const [debtSetCutoffMode, setDebtSetCutoffMode] = useState<"today" | "end_of_month">("today");
  // Dialog เลือก cutoff mode ตอนกด toggle ตั้งเป้า
  const [showDebtSetDialog, setShowDebtSetDialog] = useState(false);
  // pending cutoff mode ที่เลือกใน Dialog (ก่อน confirm)
  const [pendingDebtSetCutoffMode, setPendingDebtSetCutoffMode] = useState<"today" | "end_of_month">("today");
  // ── Target Tab Snapshot View ─────────────────────────────────────────────────
  // viewMode: "live" = ข้อมูล live จาก cache, "snapshot" = ข้อมูล snapshot ที่เลือก
  const [targetViewMode, setTargetViewMode] = useState<"live" | "snapshot">("live");
  const [selectedSnapshotMonth, setSelectedSnapshotMonth] = useState<string | null>(null);
  const [showSnapshotLog, setShowSnapshotLog] = useState(false);
  // ── Daily Breakdown popup state ──────────────────────────────────────────────
  // เก็บ snapshotMonth ที่กดปุ่มดูรายวัน (null = ปิด popup)
  const [dailyBreakdownMonth, setDailyBreakdownMonth] = useState<string | null>(null);
  // ── Global default filter สถานะหนี้สำหรับ Snapshot mode ──────────────────────
  // ใช้ 6 สถานะ (ไม่รวม "เกิน >90") เป็น default เมื่อเปิด popup ยอดรายวัน
  const SNAPSHOT_DEFAULT_STATUSES = ["ปกติ", "เกิน 1-7", "เกิน 8-14", "เกิน 15-30", "เกิน 31-60", "เกิน 61-90"];
  // state สำหรับ multi-select filter สถานะหนี้ใน Daily Breakdown popup
  // default = SNAPSHOT_DEFAULT_STATUSES (6 สถานะ), user เปลี่ยนได้แต่ไม่บันทึก
  const [dailyBreakdownStatuses, setDailyBreakdownStatuses] = useState<string[]>(SNAPSHOT_DEFAULT_STATUSES);
  // state สำหรับ dropdown open/close
  const [dailyStatusDropdownOpen, setDailyStatusDropdownOpen] = useState(false);
  // รายการสถานะหนี้ทั้งหมดสำหรับ filter
  // สถานะที่แสดงใน filter — ไม่รวม ระงับ/สิ้นสุด/หนี้เสีย/ยกเลิก เพราะ SQL ตัดออกอยู่แล้ว
  const DEBT_STATUS_OPTIONS = [
    "ปกติ",
    "เกิน 1-7",
    "เกิน 8-14",
    "เกิน 15-30",
    "เกิน 31-60",
    "เกิน 61-90",
    "เกิน >90",
  ];
  // query getDailyBreakdown — ดึงเฉพาะเมื่อ popup เปิด
  const dailyBreakdownQuery = trpc.debt.getDailyBreakdown.useQuery(
    {
      section: sectionKey,
      snapshotMonth: dailyBreakdownMonth ?? "",
      // debtStatuses ถูกย้ายไป filter ที่ client-side แล้ว ไม่ต้องส่งมา server
    },
    { enabled: !!section && !!dailyBreakdownMonth, staleTime: 2 * 60 * 1000 },
  );
  // query getMonthlySnapshots — ดึง frozen targetByRange + dailyBreakdown จาก monthly_collection_snapshot
  // ใช้แทน getMonthlyDebtSummary และ getDailyBreakdown เมื่อ frozen data พร้อมแล้ว
  // enabled ทันที่ที่ tab=target เพื่อให้ frozen data พร้อมก่อนเปิด popup ยอดรายวัน
  const monthlySnapshotsQuery = trpc.debt.getMonthlySnapshots.useQuery(
    { section: sectionKey },
    { enabled: !!section && tab === "target", staleTime: 5 * 60 * 1000 },
  );
  // helper: ดึง frozen dailyBreakdown ของ snapshotMonth ที่ระบุ
  // daily_breakdown ใน DB เก็บเป็น object {"overdue": {target, targetByRange, collected, isOverdue}, "1": {...}, ...}
  // แปลงเป็น DailyBreakdownRow[] ที่ client ใช้ (array เรียง ASC ตามวันที่ โดยแถว overdue อยู่บนสุด)
  const getFrozenDailyBreakdown = (snapshotMonth: string) => {
    const rows = (monthlySnapshotsQuery.data ?? []) as any[];
    const row = rows.find((r: any) => r.collectionMonth === snapshotMonth);
    const breakdown = row?.dailyBreakdown ?? null;
    if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) return null;
    const [yr, mo] = snapshotMonth.split("-");
    const result: Array<{ date: string; targetAmount: number; targetByRange: Record<string, number>; collectedAmount: number; percentage: number; isOverdue?: boolean }> = [];
    // แถว overdue ก่อน (ถ้ามี)
    if (breakdown['overdue']) {
      const d = breakdown['overdue'] as { target: number; targetByRange: Record<string, number>; collected: number; isOverdue?: boolean };
      if ((d.target ?? 0) > 0) {
        result.push({
          date: 'overdue',
          targetAmount: d.target ?? 0,
          targetByRange: d.targetByRange ?? {},
          collectedAmount: 0,
          percentage: 0,
          isOverdue: true,
        });
      }
    }
    // แถวรายวัน (key เป็นตัวเลข 1-31)
    Object.keys(breakdown)
      .filter(k => k !== 'overdue')
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((dayNum) => {
        const d = breakdown[String(dayNum)] as { target: number; targetByRange: Record<string, number>; collected: number };
        const dateStr = `${yr}-${mo}-${String(dayNum).padStart(2, '0')}`;
        result.push({
          date: dateStr,
          targetAmount: d.target ?? 0,
          targetByRange: d.targetByRange ?? {},
          collectedAmount: d.collected ?? 0,
          percentage: d.target > 0 ? (d.collected / d.target) * 100 : 0,
        });
      });
    return result;
  };
  // helper: ดึง frozen targetByRange ของ snapshotMonth ที่ระบุ
  const getFrozenTargetByRange = (snapshotMonth: string) => {
    const rows = (monthlySnapshotsQuery.data ?? []) as any[];
    const row = rows.find((r: any) => r.collectionMonth === snapshotMonth);
    return row?.targetByRange ?? null;
  };
  // query getMonthlyDebtSummary สำหรับ dropdown "ตั้งเป้ารายเดือน" (ตาราง 4 คอลัมน์)
  // ดึงจาก monthly_target_detail_snapshot (freeze ณ วันที่ 1) + debt_collected_cache (ค่างวดเท่านั้น)
  // fallback เมื่อ frozen data ยังไม่มี (snapshot เก่าก่อน backfill)
  const monthlyDebtSummaryQuery = trpc.debt.getMonthlyDebtSummary.useQuery(
    { section: sectionKey },
    { enabled: !!section && tab === "target", staleTime: 2 * 60 * 1000 },
  );
  // query รายการ snapshot ที่มีอยู่ใน DB (สำหรับ Log Dropdown)
  const availableTargetSnapshotsQuery = trpc.debt.getAvailableSnapshotMonths.useQuery(
    { section: sectionKey },
    { enabled: !!section && tab === "target", staleTime: 30 * 1000 },
  );
  // query ข้อมูล snapshot สำหรับแสดงในตาราง (ไม่ใช่ Lightbox)
  // snapshotMode ดึงจาก metadata ของ snapshot ที่เลือก (availableTargetSnapshotsQuery.data)
  const selectedSnapshotMeta = React.useMemo(() => {
    if (!selectedSnapshotMonth || !availableTargetSnapshotsQuery.data) return null;
    return (availableTargetSnapshotsQuery.data as any[]).find(
      (m: any) => m.snapshotMonth === selectedSnapshotMonth,
    ) ?? null;
  }, [selectedSnapshotMonth, availableTargetSnapshotsQuery.data]);
  // ✅ Fix: ใช้ getTargetSnapshotGrouped แทน getTargetDetailSnapshot
  // getTargetDetailSnapshot มี limit=10000 rows ซึ่งไม่เพียงพอ (snapshot มี 58,656 rows = 4,928 สัญญา)
  // getTargetSnapshotGrouped ดึงทุก row ไม่มี limit แล้ว group ที่ server → ส่งกลับ contracts[]
  const targetSnapshotViewQuery = trpc.debt.getTargetSnapshotGrouped.useQuery(
    {
      section: sectionKey,
      snapshotMonth: selectedSnapshotMonth ?? "",
    },
    { enabled: !!section && targetViewMode === "snapshot" && !!selectedSnapshotMonth, staleTime: 5 * 60 * 1000 },
  );
  // ── Snapshot (Server-Side) ──────────────────────────────────────────────────
  // mutation สำหรับ Server-Side Snapshot — ให้ server ดึงข้อมูลจาก debt_target_cache โดยตรง
  // (แทน saveClientSnapshot ที่ส่ง rows จาก client ซึ่งอาจโหลดไม่ครบ)
  const createSnapshotMutation = trpc.debt.populateTargetDetailSnapshot.useMutation({
    onSuccess: (data) => {
      toast.success(`บันทึก Snapshot สำเร็จ — ${data.rowsInserted.toLocaleString("th-TH")} รายการ`);
      availableTargetSnapshotsQuery.refetch();
    },
    onError: (err) => {
      toast.error(`บันทึก Snapshot ไม่สำเร็จ: ${err.message}`);
    },
  });
  // helper: เลือก snapshot จาก Log
  const handleSelectSnapshot = React.useCallback((month: string) => {
    setSelectedSnapshotMonth(month);
    setTargetViewMode("snapshot");
    setShowSnapshotLog(false);
    // auto-set statusFilter เป็น SNAPSHOT_DEFAULT_STATUSES (6 สถานะ) เมื่อเข้า snapshot mode
    // เพื่อให้ badge เป้าเก็บหนี้ (targetSummary.total) และ filter สถานะหนี้ใน main table ตรงกัน
    setStatusFilter(new Set(SNAPSHOT_DEFAULT_STATUSES));
    // auto-restore filter state จาก snapshot metadata
    const meta = (availableTargetSnapshotsQuery.data as any[])?.find(
      (m: any) => m.snapshotMonth === month,
    );
    if (meta?.filterState) {
      try {
        const fs = JSON.parse(meta.filterState);
        if (typeof fs.search === "string") setSearch(fs.search);
        // ไม่ restore statusFilter จาก metadata เพราะใช้ SNAPSHOT_DEFAULT_STATUSES เสมอ
        if (Array.isArray(fs.approveDateFilter)) setApproveDateFilter(new Set(fs.approveDateFilter));
        if (Array.isArray(fs.dueDateFilter)) setDueDateFilter(new Set(fs.dueDateFilter));
        if (Array.isArray(fs.productTypeFilter)) setProductTypeFilter(new Set(fs.productTypeFilter));
        if (fs.dueDateExact !== undefined) setDueDateExact(fs.dueDateExact);
        if (typeof fs.debtSetMode === "boolean") setDebtSetMode(fs.debtSetMode);
        if (fs.debtSetCutoffMode === "today" || fs.debtSetCutoffMode === "end_of_month") setDebtSetCutoffMode(fs.debtSetCutoffMode);
        if (typeof fs.principalOnly === "boolean") setPrincipalOnly(fs.principalOnly);
      } catch {
        // ถ้า parse ไม่ได้ ไม่ต้องทำอะไร — ใช้ filter เดิม
      }
    } else {
      // filterState เป็น null → fallback ใช้ค่าจาก snapshot metadata โดยตรง
      // (snapshot ที่สร้างโดย Auto Snapshot วันที่ 1 จะมี filter_debt_only/filter_principal_only แต่ไม่มี filterState)
      if (typeof meta?.filterDebtOnly === "boolean") setDebtSetMode(meta.filterDebtOnly);
      if (typeof meta?.filterPrincipalOnly === "boolean") setPrincipalOnly(meta.filterPrincipalOnly);
      // restore debtSetCutoffMode จาก snapshotMode
      if (meta?.snapshotMode === "end_of_month") setDebtSetCutoffMode("end_of_month");
      else if (meta?.snapshotMode === "today") setDebtSetCutoffMode("today");
    }
  }, [availableTargetSnapshotsQuery.data, setSearch, setStatusFilter, setApproveDateFilter, setDueDateFilter, setProductTypeFilter, setDueDateExact, setDebtSetMode, setDebtSetCutoffMode, setPrincipalOnly, SNAPSHOT_DEFAULT_STATUSES]);
  // helper: กลับมา live
  const handleBackToLive = React.useCallback(() => {
    setTargetViewMode("live");
    setSelectedSnapshotMonth(null);
    setShowSnapshotLog(false);
  }, []);
  // ปิด Dropdown เมื่อคลิกนอกพื้นที่ หรือกด Escape
  React.useEffect(() => {
    if (!showSnapshotLog) return;
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setShowSnapshotLog(false);
      } else {
        // ตรวจว่าคลิกอยู่นอก .snapshot-log-dropdown
        const target = e.target as HTMLElement;
        if (!target.closest(".snapshot-log-dropdown")) setShowSnapshotLog(false);
      }
    };
    document.addEventListener("mousedown", handler as EventListener);
    document.addEventListener("keydown", handler as EventListener);
    return () => {
      document.removeEventListener("mousedown", handler as EventListener);
      document.removeEventListener("keydown", handler as EventListener);
    };
  }, [showSnapshotLog]);
  // ตัวกรอง "บันทึกโดย" (collected tab only)
  const [updatedByFilter, setUpdatedByFilter] = useState<string | null>(null);
  // Color legend modal
  const [showColorLegend, setShowColorLegend] = useState(false);
  // Pinned columns: set of LEFT_COLS keys that are sticky-left
  const [pinnedCols, setPinnedCols] = useState<Set<string>>(new Set());
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  // Phase 3 (vertical layout): expand/collapse state for collected tab rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleExpand = (contractNo: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(contractNo)) next.delete(contractNo);
      else next.add(contractNo);
      return next;
    });
  };
  const togglePin = (key: string) => {
    setPinnedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Phase 125: Global Cache — ข้อมูลจะถูกเก็บไว้ใน DebtCacheContext ตลอด session
  // ทำให้ไม่ต้อง fetch ใหม่เมื่อเปลี่ยนเมนูแล้วกลับมา
  const utils = trpc.useUtils();
  const debtCache = useDebtCache();
  const [streamLoading, setStreamLoading] = useState<{ target: boolean; collected: boolean }>({ target: false, collected: false });
  const [streamError, setStreamError] = useState<{ target: string | null; collected: string | null }>({ target: null, collected: null });
  const [streamProgress, setStreamProgress] = useState<{ target: number; collected: number }>({ target: 0, collected: 0 });
  const [streamTotal, setStreamTotal] = useState<{ target: number; collected: number }>({ target: 0, collected: 0 });
  // อ่านข้อมูลจาก Global Cache
  const cachedEntry = section ? debtCache.getCache(section as any) : { target: null, collected: null, loadedAt: 0 };
  const streamData = { target: cachedEntry.target, collected: cachedEntry.collected };

  /** Phase 122: fetch chunk พร้อม retry (max 3 ครั้ง, exponential backoff) */
  const fetchChunkWithRetry = useCallback(async (
    t: "target" | "collected",
    offset: number,
    limit: number,
    maxRetries = 5,
  ) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (t === "target") {
          return await utils.debt.getTargetChunk.fetch({ section: section as any, offset, limit });
        } else {
          return await utils.debt.getCollectedChunk.fetch({ section: section as any, offset, limit });
        }
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries - 1) {
          // exponential backoff: 2s, 4s, 8s, 16s (รอ cache warm)
          await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastErr;
  }, [utils, section]);

  const fetchStream = useCallback(async (t: "target" | "collected") => {
    if (!canView || !section) return;
    // รีเซ็ต state ใน cache สำหรับ type นี้
    debtCache.setLoadingState(section as any, t, { loading: true, progress: 0, total: 0, error: null });
    setStreamLoading((prev) => ({ ...prev, [t]: true }));
    setStreamError((prev) => ({ ...prev, [t]: null }));
    setStreamProgress((prev) => ({ ...prev, [t]: 0 }));
    setStreamTotal((prev) => ({ ...prev, [t]: 0 }));
    try {
      const CHUNK_SIZE = 500; // ลดจาก 2000 เป็น 500 (~2MB ต่อ request) เพื่อลด Cloudflare timeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = [];
      let hasPrincipalBreakdown = true;
      let offset = 0;
      let totalContracts = 0;
      // วน fetch จนครบ total
      while (true) {
        const result = await fetchChunkWithRetry(t, offset, CHUNK_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkRows = result.rows as any[];
        totalContracts = result.totalContracts;
        const hasMore = result.hasMore;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (t === "collected" && (result as any).hasPrincipalBreakdown === false) {
          hasPrincipalBreakdown = false;
        }
        rows.push(...chunkRows);
        offset += CHUNK_SIZE;
        setStreamTotal((prev) => ({ ...prev, [t]: totalContracts }));
        setStreamProgress((prev) => ({ ...prev, [t]: rows.length }));
        debtCache.setLoadingState(section as any, t, { progress: rows.length, total: totalContracts });
        if (!hasMore) break;
      }
      // บันทึกลง Global Cache
      if (t === "target") {
        debtCache.setTargetRows(section as any, rows as TargetRow[]);
      } else {
        debtCache.setCollectedRows(section as any, rows as CollectedRow[], hasPrincipalBreakdown);
      }
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (err as any)?.message ?? "เกิดข้อผิดพลาด";
      setStreamError((prev) => ({ ...prev, [t]: msg }));
      debtCache.setLoadingState(section as any, t, { error: msg });
    } finally {
      setStreamLoading((prev) => ({ ...prev, [t]: false }));
      debtCache.setLoadingState(section as any, t, { loading: false });
    }
  }, [canView, section, fetchChunkWithRetry]);

  // Auto-fetch + reset in ONE effect to avoid race condition:
  // Previously, two separate useEffects (auto-fetch & reset) both depended on `section`.
  // React runs them in order on mount, so reset ran AFTER fetch started → wiped streamLoading.
  // Fix: merge both into one effect so reset always happens before fetch in the same flush.
  useEffect(() => {
    // Always reset local UI state when section changes (or on mount)
    setStreamError({ target: null, collected: null });
    setStreamLoading({ target: false, collected: false });
    setStreamProgress({ target: 0, collected: 0 });
    setStreamTotal({ target: 0, collected: 0 });
    // Then trigger fetch if auth is ready
    if (isAuthLoading || !canView || !section) return;
    if (tab === "target" && !streamData.target) {
      fetchStream("target");
    } else if (tab === "collected" && !streamData.collected) {
      fetchStream("collected");
    }
  }, [tab, section, canView, isAuthLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // isLoading: Live mode ดู streamLoading, Snapshot mode ดู targetSnapshotViewQuery.isFetching
  const isLoading = tab === "target"
    ? (targetViewMode === "snapshot" ? targetSnapshotViewQuery.isFetching : streamLoading.target)
    : (tab === "collected" ? streamLoading.collected : false);
  const isError = tab === "target" ? !!streamError.target : (tab === "collected" ? !!streamError.collected : false);
  const queryError = tab === "target" ? streamError.target : (tab === "collected" ? streamError.collected : null);
  const refetch = useCallback(() => { fetchStream(tab); }, [fetchStream, tab]);

  // Track elapsed time for first-load progress indicator
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isLoading) {
      setElapsedSec(0);
      return;
    }
    const t0 = Date.now();
    setElapsedSec(0);
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [isLoading]);

  // แปลง TargetDetailSnapshotRow → TargetRow สำหรับแสดงในตาราง
  // *** แปลง contracts[] จาก getTargetSnapshotGrouped → TargetRow[] สำหรับแสดงในตาราง ***
  // ✅ Fix: ใช้ contracts[] ที่ server group แล้ว (ครบทุกสัญญา ไม่มี limit)
  const snapshotAsTargetRows: TargetRow[] = useMemo(() => {
    if (targetViewMode !== "snapshot" || !targetSnapshotViewQuery.data?.contracts) return [];

    // ─── cutoffDate ของ snapshot นี้ (ใช้คำนวณ isFuturePeriod ใน badge) ───
    const cutoffStr = targetSnapshotViewQuery.data.cutoffDate
      ? String(targetSnapshotViewQuery.data.cutoffDate).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    // cutoffMs: เก็บไว้เผื่อใช้ใน badge (isFuturePeriod check) ถ้าต้องการในอนาคต
    void Date.parse(`${cutoffStr}T23:59:59`); // ยังไม่ใช้ cutoffMs ในโค้ดนี้ (isFuturePeriod มาจาก server อยู่แล้ว)
    // ✅ Snapshot mode: ใช้ debtRange ที่ frozen ไว้ใน DB แทน re-compute จาก today
    // debtRange ถูก populate ตอนถ่าย snapshot → ตรงกับสถานะ ณ วันที่ถ่าย snapshot จริง

    // ─── แปลง TargetSnapshotContractRow → TargetRow ───
    // server ส่งมาเป็น contracts[] ที่ group แล้ว (1 contract = 1 row + installments[])
    const result: TargetRow[] = [];
    for (const c of targetSnapshotViewQuery.data.contracts) {
      // หา contractStatus จาก installment ล่าสุด (ใช้ terminal status check)
      const lastContractStatus = c.installments.length > 0
        ? (c.installments[c.installments.length - 1].contractStatus ?? null)
        : null;

      // แปลง installments → InstallmentCell[]
      const installments: InstallmentCell[] = c.installments.map((inst) => ({
        period: inst.period,
        dueDate: inst.dueDate,
        principal: inst.principal,
        interest: inst.interest,
        fee: inst.fee,
        penalty: inst.penalty,
        unlockFee: inst.unlockFee,
        amount: inst.totalAmount,
        paid: inst.paidAmount,
        baselineAmount: c.baselineAmount,
        overpaidApplied: 0,
        isClosed: inst.isClosed,
        isSuspended: inst.isSuspended,
        suspendLabel: inst.isSuspended ? (inst.contractStatus ?? null) : null,
        isArrears: inst.isArrears,
        isCurrentPeriod: inst.isCurrentPeriod,
        isFuturePeriod: inst.isFuturePeriod,
        isPaid: inst.isPaid,
        netAmount: inst.principal + inst.interest + inst.fee,
      }));

      // คำนวณ totalAmount, totalPaid, remaining
      let totalAmount = 0;
      let totalPaid = 0;
      for (const inst of c.installments) {
        totalAmount += inst.totalAmount;
        totalPaid += inst.paidAmount;
      }
      const remaining = Math.max(totalAmount - totalPaid, 0);

      // ✅ Snapshot mode: ใช้ debtRange ที่ frozen ไว้ใน DB (ไม่ re-compute จาก today)
      // หา debtRange จาก installment แรกที่มีค่า (ทุก installment ของสัญญาเดียวกันมี debtRange เหมือนกัน)
      const frozenDebtRange = c.installments.find(i => i.debtRange)?.debtRange ?? null;
      const debtStatus = frozenDebtRange ?? (lastContractStatus ?? "ปกติ");
      // daysOverdue: ไม่สามารถ derive จาก frozen snapshot ได้แม่นยำ → ใช้ 0 สำหรับ snapshot mode
      const daysOverdue = 0;

      result.push({
        contractExternalId: c.contractExternalId,
        contractNo: c.contractNo,
        approveDate: c.approveDate,
        customerName: c.customerName,
        phone: c.phone ?? null,
        productType: c.productType,
        installmentCount: c.installmentCount,
        installmentAmount: c.baselineAmount,
        totalAmount,
        totalPaid,
        remaining,
        debtStatus,
        daysOverdue,
        installments,
      });
    }
    return result;
  }, [targetViewMode, targetSnapshotViewQuery.data]);

  const activeRows: (TargetRow | CollectedRow)[] =
    (tab === "target"
      ? (targetViewMode === "snapshot" ? snapshotAsTargetRows : (streamData.target?.rows as TargetRow[]))
      : tab === "collected" ? (streamData.collected?.rows as CollectedRow[]) : []) ?? [];
  // hasPrincipalBreakdown: true = Boonphone (แสดง principal/interest/fee จริง)
  //                         false = Fastfone365 (แสดง "-" แทน 0.00)
  const hasPrincipalBreakdown = streamData.collected?.hasPrincipalBreakdown !== false;

  /**
   * collectedPaidPeriodMap — lookup map: contractExternalId → maxPaidPeriod
   * สร้างจาก streamData.collected?.rows เพื่อให้ target tab ดึงค่า N (งวดที่ผ่อนมาแล้ว)
   * โดยตรงจากยอดเก็บหนี้ แทนการคำนวณใหม่จาก installments ของ target row
   *
   * maxPaidPeriod = max(payment.period) ที่ไม่ใช่ isBadDebtRow
   * ใช้เมื่อ target tab ไม่พบ isCurrentPeriod (เช่น สัญญายกเลิก/ระงับ)
   */
  const collectedPaidPeriodMap = useMemo(() => {
    const m = new Map<string, number>();
    const collectedRows = streamData.collected?.rows as CollectedRow[] | undefined;
    if (!collectedRows) return m;
    for (const cr of collectedRows) {
      const rawMaxPaid = (cr.payments ?? []).reduce((max, p) => {
        if (p.isBadDebtRow) return max; // ข้ามรายการหนี้เสีย
        if (p.period != null && p.period > max) return p.period;
        return max;
      }, 0);
      // Cap: maxPaid ต้องไม่เกิน installmentCount (กรณีชำระเกินงวด เช่น 9/8 → 8/8)
      const maxPaid = cr.installmentCount != null
        ? Math.min(rawMaxPaid, cr.installmentCount)
        : rawMaxPaid;
      m.set(cr.contractExternalId, maxPaid);
    }
    return m;
  }, [streamData.collected]);

  /* ---- updatedBy options (collected tab only) ---- */
  const updatedByOptions = useMemo(() => {
    if (tab !== "collected") return [];
    const s = new Set<string>();
    for (const r of activeRows as CollectedRow[]) {
      for (const p of r.payments ?? []) {
        if (p.updatedBy) s.add(p.updatedBy);
      }
    }
    return Array.from(s).sort();
  }, [activeRows, tab]);

  /* ---- Dynamic filter options (derived from ALL active rows, not filtered) ---- */
  const approveDateOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of activeRows) {
      if (r.approveDate) s.add(r.approveDate.slice(0, 7));
    }
    return Array.from(s).sort().reverse();
  }, [activeRows]);

  const dueDateOptions = useMemo(() => {
    const s = new Set<string>();
    // Phase 28: collected tab uses paidAt month for filter options; target tab uses dueDate month
    if (tab === "collected") {
      for (const r of activeRows as CollectedRow[]) {
        for (const p of r.payments ?? []) {
          if (p.paidAt) s.add(p.paidAt.slice(0, 7));
        }
      }
    } else {
      for (const r of activeRows) {
        for (const inst of r.installments) {
          if (inst.dueDate) s.add(inst.dueDate.slice(0, 7));
        }
      }
    }
    return Array.from(s).sort().reverse();
  }, [activeRows, tab]);

  const productTypeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of activeRows) {
      if (r.productType) s.add(r.productType);
    }
    return Array.from(s).sort();
  }, [activeRows]);

  /* ---- Filter (client-side) ---- */
  // Priority: approveDateFilter > dueDateExact > dueDateFilter > statusFilter > productTypeFilter
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeRows.filter((r) => {
      // 1. เดือน-ปีที่อนุมัติ
      if (approveDateFilter.size > 0) {
        const ym = r.approveDate ? r.approveDate.slice(0, 7) : "";
        if (!approveDateFilter.has(ym)) return false;
      }
      // 2. วันที่ (exact date picker)
      //    - collected tab: ซ่อน row ที่ไม่มี payment ใดที่ paidAt ตรงวันที่เลือก
      //    - target tab: ซ่อน row ที่ไม่มี installment dueDate ตรงวันที่เลือก (cell masking handles the rest)
      if (dueDateExact) {
        const hasMatch =
          tab === "collected"
            ? (r as CollectedRow).payments?.some(
                (p) => p.paidAt && p.paidAt.slice(0, 10) === dueDateExact
              ) ?? false
            : r.installments.some(
                (inst) => inst.dueDate && inst.dueDate.slice(0, 10) === dueDateExact
              );
        if (!hasMatch) return false;
      }
      // 3. เดือน-ปีที่ต้องชำระ / เดือน-ปีที่ชำระ (month-year filter)
      //    target tab: Row passes if ANY installment's due_date month is in the filter.
      //    collected tab: Row passes if ANY payment's paidAt month is in the filter.
      //    Phase 28: collected tab filters by paidAt, not dueDate.
      if (dueDateFilter.size > 0) {
        const hasMatch =
          tab === "collected"
            ? (r as CollectedRow).payments?.some(
                (p) => p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7))
              ) ?? false
            : r.installments.some(
                (inst) => inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7))
              );
        if (!hasMatch) return false;
      }
      // 4. สถานะหนี้
      if (statusFilter.size > 0 && !statusFilter.has(r.debtStatus)) return false;
      // 5. ประเภทเครื่อง
      if (productTypeFilter.size > 0 && !productTypeFilter.has(r.productType ?? "")) return false;
      // 6. บันทึกโดย (collected tab only) — กรองระดับ row: แสดงเฉพาะ row ที่มี payment ของคนนั้น
      if (tab === "collected" && updatedByFilter) {
        const hasMatch = (r as CollectedRow).payments?.some((p) => p.updatedBy === updatedByFilter) ?? false;
        if (!hasMatch) return false;
      }
      // 7. ตั้งเป้า (target tab only) — ซ่อน row ที่ทุก installment เป็น paid/closed/suspended/future
      if (tab === "target" && debtSetMode) {
        // ใช้ debtSetCutoffMode ที่เลือกตอนกด toggle ตั้งเป้า
        // today = วันนี้, end_of_month = วันสุดท้ายของเดือน
        const _now = new Date();
        const cutoffStr = debtSetCutoffMode === "end_of_month"
          ? (() => { const d = new Date(_now.getFullYear(), _now.getMonth() + 1, 0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })()
          : _now.toISOString().slice(0, 10);
        // Row ผ่านถ้ามี installment อย่างน้อย 1 งวดที่ต้องเก็บ (ส้มหรือดำ)
        // = ไม่ใช่ closed, ไม่ใช่ suspended, ไม่ใช่ paid, ไม่ใช่ future (dueDate > cutoff)
        // และ contract status ไม่ใช่ ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย
        const specialStatus = r.debtStatus === "ระงับสัญญา" || r.debtStatus === "สิ้นสุดสัญญา" || r.debtStatus === "หนี้เสีย" || r.debtStatus === "ยกเลิกสัญญา"; // ยกเลิกสัญญา ยังคงอยู่ใน specialStatus เพื่อไม่แสดงใน debtSetMode (ตั้งเป้า)
        if (specialStatus) return false;
        const hasCollectableInst = r.installments.some((inst) => {
          if (inst.isClosed || inst.isSuspended) return false;
          if (inst.isPaid) return false;
          if (inst.dueDate && inst.dueDate > cutoffStr) return false;
          return true;
        });
        if (!hasCollectableInst) return false;
      }
      // 8. ค้นหา
      if (!q) return true;
      return (
        (r.contractNo ?? "").toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q)
      );
    });
  }, [activeRows, search, statusFilter, approveDateFilter, dueDateFilter, productTypeFilter, dueDateExact, tab, updatedByFilter, debtSetMode, debtSetCutoffMode, targetViewMode, selectedSnapshotMeta]);

  // helper: กด Snapshot → ให้ server ดึงข้อมูลจาก debt_target_cache โดยตรง (Server-Side Snapshot)
  // เปลี่ยนจาก saveClientSnapshot (ส่ง rows จาก client) → populateTargetDetailSnapshot (server ดึงเอง)
  // เพื่อให้ได้ข้อมูลครบทุกสัญญา ไม่ขึ้นกับ client cache ที่อาจโหลดไม่ครบ
  const handleCreateSnapshot = React.useCallback(() => {
    if (!section) return;
    const now = new Date();
    const snapshotMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    // cutoffMode: ใช้ debtSetCutoffMode ที่เลือกไว้ตอนกด toggle ตั้งเป้า
    const mode = debtSetCutoffMode;
    // serialize filter state เพื่อ auto-restore ตอนเปิดดู Snapshot
    const filterStateObj = {
      search,
      statusFilter: Array.from(statusFilter),
      approveDateFilter: Array.from(approveDateFilter),
      dueDateFilter: Array.from(dueDateFilter),
      productTypeFilter: Array.from(productTypeFilter),
      dueDateExact,
      debtSetMode,
      debtSetCutoffMode,
      principalOnly,
    };
    const filterStateJson = JSON.stringify(filterStateObj);
    // ส่งแค่ metadata ไปยัง server — server จะดึงข้อมูลจาก debt_target_cache โดยตรง
    // ไม่ต้องส่ง rows จาก client (ซึ่งอาจโหลดไม่ครบ)
    // targetAmount = badge ยอดหนี้รวมที่เห็นบนหน้าจอก่อน snapshot — server จะ upsert ลง monthly_collection_snapshot โดยตรง
    createSnapshotMutation.mutate({
      section: sectionKey,
      snapshotMonth,
      snapshotMode: mode,
      filterDebtOnly: debtSetMode,
      filterPrincipalOnly: principalOnly,
      filterState: filterStateJson,
      targetAmount: targetSummary?.total ?? undefined,
    });
  }, [section, sectionKey, debtSetCutoffMode, debtSetMode, principalOnly, createSnapshotMutation, search, statusFilter, approveDateFilter, dueDateFilter, productTypeFilter, dueDateExact]); // eslint-disable-line react-hooks/exhaustive-deps


  /* ---- Max periods for the repeating group block ---- */
  // Phase 125: ใช้ filteredRows ทั้งหมดแทน pagedRows (ไม่มี pagination แล้ว)
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

  /** Per row "line count" — for collected tab, returns total payment count (vertical layout).
   *  For target tab, returns max split-payments per period (matrix layout). */
  function rowLineCount(r: CollectedRow): number {
    if (tab !== "collected") return 1;
    // Phase 3: vertical layout — each payment is a separate sub-row
    // Only count payments that pass the active date filters
    let count = 0;
    for (const p of r.payments ?? []) {
      if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
      if (dueDateExact && p.paidAt?.slice(0, 10) !== dueDateExact) continue;
      count++;
    }
    return count;
  }

  /* ---- Summary totals (computed from filteredRows, respects all filters) ---- */
  const targetSummary = useMemo(() => {
    if (tab !== "target") return null;
    // ใช้ debtSetCutoffMode ที่เลือกตอนกด toggle ตั้งเป้า (Live mode)
    // Snapshot mode: ใช้ cutoffDate ของ snapshot
    const _now2 = new Date();
    const cutoffStr = targetViewMode === "snapshot" && (selectedSnapshotMeta as any)?.cutoffDate
      ? String((selectedSnapshotMeta as any).cutoffDate).slice(0, 10)
      : debtSetCutoffMode === "end_of_month"
        ? (() => { const d = new Date(_now2.getFullYear(), _now2.getMonth() + 1, 0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })()
        : _now2.toISOString().slice(0, 10);
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0, total = 0;
    for (const r of filteredRows) {
      // Phase 125 fix: penalty/unlockFee ใช้เฉพาะ currentPeriod ของแต่ละสัญญา (ค่าปรับถูก accumulate ไว้ที่งวดนั้นแล้ว)
      // เพื่อไม่ให้นับซ้ำจากทุกงวด
      const currentPeriodInst = r.installments.find((i) => i.isCurrentPeriod) ?? null;
      for (const inst of r.installments) {
        if (inst.isClosed || inst.isSuspended) continue;
        // Phase 125: debtSetMode — ไม่รวมงวดที่ชำระครบแล้ว (isPaid/เขียว) ใน badge
        if (debtSetMode && inst.isPaid) continue;
        // ไม่รวมงวดอนาคต (dueDate > cutoff) เสมอ ไม่ว่า debtSetMode จะเปิดหรือปิด
        // Snapshot mode: cutoff = cutoffDate ของ snapshot | Live mode: cutoff = วันนี้
        if (inst.dueDate && inst.dueDate > cutoffStr) continue;
        // Phase 23: dueDateFilter cell-mask — only sum periods whose dueDate month matches
        if (dueDateFilter.size > 0 && !(inst.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7)))) continue;
        // Phase 23: dueDateExact cell-mask — only sum periods whose dueDate matches exact date
        if (dueDateExact && inst.dueDate?.slice(0, 10) !== dueDateExact) continue;
        principal += inst.principal ?? 0;
        interest += inst.interest ?? 0;
        fee += inst.fee ?? 0;
        if (!principalOnly) {
          // penalty/unlockFee: นับเฉพาะงวด currentPeriod ของสัญญานี้ (ป้องกันนับซ้ำ)
          // ถ้าสัญญามี currentPeriod ให้นับเฉพาะงวดนั้น ถ้าไม่มีให้นับตามปกติ
          if (currentPeriodInst) {
            if (inst === currentPeriodInst) {
              penalty += inst.penalty ?? 0;
              unlockFee += inst.unlockFee ?? 0;
            }
            // งวดอื่นๆ ไม่นับ penalty/unlockFee (ถูก accumulate ไว้ที่ currentPeriod แล้ว)
          } else {
            // ไม่มี currentPeriod (เช่น ทุกงวดผ่านมาแล้วและยังไม่ปิด) — นับตามปกติ
            penalty += inst.penalty ?? 0;
            unlockFee += inst.unlockFee ?? 0;
          }
        }
      }
    }
    total = principal + interest + fee + penalty + unlockFee;
    return { principal, interest, fee, penalty, unlockFee, total };
  }, [filteredRows, tab, principalOnly, dueDateFilter, dueDateExact, debtSetMode, debtSetCutoffMode, targetViewMode, selectedSnapshotMeta]);

  const collectedSummary = useMemo(() => {
    if (tab !== "collected") return null;
    let principal = 0, interest = 0, fee = 0, penalty = 0, unlockFee = 0;
    let discount = 0, overpaid = 0, badDebt = 0;
    // ptTotal = sum(p.total) = sum(pt.amount) = ยอดที่ลูกค้าจ่ายจริง (หลังหักส่วนลดแล้ว)
    // ใช้เป็นฐานคำนวณ total badge เพื่อให้ตรงกับ Income Report เมื่อ toggle ทุกตัวเปิดหมด
    let ptTotal = 0;
    // Pattern B: extraPenalty = ยอด penalty ของรายการที่ pt.amount = 0 แต่ penalty_paid > 0
    // ไม่นับในยอดรวม เพราะ pt.amount = 0 จึงไม่มีใน Income
    let extraPenalty = 0;
    for (const r of filteredRows as CollectedRow[]) {
      for (const p of r.payments ?? []) {
        // Phase 23: dueDateExact cell-mask — only sum payments whose paidAt matches exact date
        if (dueDateExact && (p.paidAt?.slice(0, 10) ?? null) !== dueDateExact) continue;
        // Phase 28: dueDateFilter cell-mask — only sum payments whose paidAt month is in filter
        if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
        // บันทึกโดย: ซ่อน payment ที่ไม่ใช่ของคนที่เลือก
        if (updatedByFilter && p.updatedBy !== updatedByFilter) continue;
        // Pattern B: รายการค่าปรับเพิ่มเติม — total = 0 แต่ penalty > 0
        // เก็บยอด extraPenalty แยกต่างหาก ไม่นับใน penalty ปกติ
        if (p.isExtraPenalty) {
          extraPenalty += p.penalty ?? 0;
          continue; // ข้ามไป ไม่นับในยอดรวม
        }
        principal += p.principal ?? 0;
        interest += p.interest ?? 0;
        fee += p.fee ?? 0;
        penalty += p.penalty ?? 0;
        unlockFee += p.unlockFee ?? 0;
        discount += p.discount ?? 0;
        overpaid += p.overpaid ?? 0;
        badDebt += p.badDebt ?? 0;
        // p.total = pt.amount = ยอดที่ลูกค้าจ่ายจริง (หลังหักส่วนลด)
        // badDebtRow: p.total = 0 แต่ badDebt > 0 → นับ badDebt แทน
        ptTotal += (p.total ?? 0) + (p.badDebt ?? 0);
      }
    }
    // ยอดที่ชำระรวม (Phase 134):
    // ใช้ ptTotal = sum(p.total + p.badDebt) เป็นฐาน เพราะ:
    //   - sum(p.total) = sum(pt.amount) = sum(Income) เมื่อ toggle ทุกตัวเปิดหมด
    //   - badDebtRow มี p.total=0 แต่ badDebt=ยอดขายเครื่อง ต้องนับด้วย
    // เมื่อปิด toggle ใด → หักยอดของ field นั้นออกจาก ptTotal
    // เหตุผล: ปิด toggle = ไม่นับ field นั้น → ยอดรวมลดลงตาม field ที่ปิด
    // discount toggle ปิดเสมอ จึงไม่มีผลต่อ total
    // Pattern B (extraPenalty) ไม่นับใน total เพราะ pt.amount = 0 จึงไม่มีใน Income
    const bv = badgeVisibility;
    const total = ptTotal
      - (!bv.principal ? principal : 0)
      - (!bv.interest ? interest : 0)
      - (!bv.fee ? fee : 0)
      - (!bv.penalty ? penalty : 0)
      - (!bv.unlockFee ? unlockFee : 0)
      - (!bv.overpaid ? overpaid : 0)
      - (!bv.badDebt ? badDebt : 0);
    return { principal, interest, fee, penalty, unlockFee, discount, overpaid, badDebt, total, extraPenalty };
  }, [filteredRows, tab, dueDateExact, dueDateFilter, badgeVisibility, updatedByFilter]);

  /* ---- TopNav actions (sync + export) ---- */
  // Export handler (used inline in toolbar)
  const handleExport = React.useCallback(async () => {
    if (!section) return;
    // ── Snapshot mode: ใช้ endpoint แยกต่างหาก ──────────────────────────────
    if (tab === "target" && targetViewMode === "snapshot" && selectedSnapshotMonth) {
      const snapshotParams = new URLSearchParams({ section, snapshotMonth: selectedSnapshotMonth });
      if (search) snapshotParams.set("search", search);
      if (productTypeFilter.size > 0) snapshotParams.set("productType", Array.from(productTypeFilter).join(","));
      if (debtSetMode) snapshotParams.set("debtOnly", "1");
      const toastIdSnap = toast.loading("กำลังเตรียมไฟล์ Excel (Snapshot)…");
      try {
        const resp = await fetch(`/api/export/target-snapshot-detail?${snapshotParams.toString()}`, {
          credentials: "include",
        });
        if (!resp.ok) {
          const { message } = await resp.json().catch(() => ({ message: "Export failed" }));
          toast.error(message, { id: toastIdSnap });
          return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `target_snapshot_${selectedSnapshotMonth}_${section}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success("ดาวน์โหลดสำเร็จ", { id: toastIdSnap });
      } catch (err) {
        toast.error((err as Error).message ?? "Export failed", { id: toastIdSnap });
      }
      return;
    }
    // ── Live mode (default) ──────────────────────────────────────────────────
    const endpoint = tab === "target" ? "/api/export/debt-target" : "/api/export/debt-collected";
    const params = new URLSearchParams({ section });
    if (search) params.set("search", search);
    if (statusFilter.size > 0) params.set("status", Array.from(statusFilter).join(","));
    // Phase 29: pass date/month filters to export endpoint
    if (dueDateExact) params.set("dueDateExact", dueDateExact);
    if (dueDateFilter.size > 0) params.set("dueDateFilter", Array.from(dueDateFilter).join(","));
    if (approveDateFilter.size > 0) params.set("approveDate", Array.from(approveDateFilter).join(","));
    if (productTypeFilter.size > 0) params.set("productType", Array.from(productTypeFilter).join(","));
    // Pass UI control states so export matches exactly what user sees
    if (tab === "target") {
      if (principalOnly) params.set("principalOnly", "1");
      if (debtSetMode) params.set("debtSetMode", "1");
    }
    if (tab === "collected") {
      // Send which badges are OFF (hidden) so server can zero out those fields
      const hiddenBadges = Object.entries(badgeVisibility)
        .filter(([, on]) => !on)
        .map(([key]) => key);
      if (hiddenBadges.length > 0) params.set("hiddenBadges", hiddenBadges.join(","));
      if (updatedByFilter) params.set("updatedBy", updatedByFilter);
    }
    const toastId = toast.loading("กำลังเตรียมไฟล์ Excel…");
    try {
      const resp = await fetch(`${endpoint}?${params.toString()}`, {
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
   }, [section, tab, search, statusFilter, dueDateExact, dueDateFilter, approveDateFilter, productTypeFilter, principalOnly, debtSetMode, badgeVisibility, updatedByFilter, targetViewMode, selectedSnapshotMonth]);

  // Phase 88: Super Admin can force-clear server-side debt cache
  const [isInvalidating, setIsInvalidating] = useState(false);
  const handleInvalidateCache = React.useCallback(async () => {
    if (!isSuperAdmin) return;
    setIsInvalidating(true);
    try {
      const resp = await fetch("/api/debt/cache/invalidate", {
        method: "POST",
        credentials: "include",
      });
      if (!resp.ok) {
        const { error } = await resp.json().catch(() => ({ error: "Unknown error" }));
        toast.error(`ล้าง cache ไม่สำเร็จ: ${error}`);
        return;
      }
      toast.success("ล้าง server cache สำเร็จ — กำลังโหลดข้อมูลใหม่...");
      // Re-fetch both tabs after cache invalidation
      await fetchStream("target");
      await fetchStream("collected");
    } catch (err) {
      toast.error(`เกิดข้อผิดพลาด: ${(err as Error).message}`);
    } finally {
      setIsInvalidating(false);
    }
  }, [isSuperAdmin, fetchStream]);

  useEffect(() => {
    setActions(
      <SyncStatusBar />,
    );
    return () => setActions(null);
  }, [setActions, isSuperAdmin, handleInvalidateCache, isInvalidating]);

  /* ---- Virtual scroll ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 40;
  const SUB_ROW_HEIGHT = 32;
  // Phase 3: collected tab uses vertical layout
  // estimateSize = ROW_HEIGHT (summary row) + N * SUB_ROW_HEIGHT (detail rows, only when expanded)
  // Phase 125: ใช้ filteredRows ทั้งหมดแทน pagedRows
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      if (tab !== "collected") return ROW_HEIGHT;
      const r = filteredRows[i] as CollectedRow;
      const contractKey = r.contractNo ?? "";
      const isExp = expandedRows.has(contractKey);
      const lines = rowLineCount(r);
      // Summary row always visible; detail rows only when expanded
      return ROW_HEIGHT + (isExp ? lines * SUB_ROW_HEIGHT : 0);
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
  // For collected tab, add productType column.
  const LEFT_COLS = tab === "collected"
    ? [
        { key: "approveDate", label: "วันที่อนุมัติ", width: 110 },
        { key: "contractNo", label: "เลขที่สัญญา", width: 195 },
        { key: "customerName", label: "ชื่อ-นามสกุล", width: 260 },
        { key: "phone", label: "เบอร์โทร", width: 110 },
        { key: "productType", label: "ประเภทเครื่อง", width: 110 },
        { key: "totalAmount", label: "ยอดผ่อนรวม", width: 110, align: "right" },
        { key: "installmentCount", label: "งวดผ่อน", width: 70, align: "right" },
        { key: "installmentAmount", label: "ผ่อนงวดละ", width: 100, align: "right" },
        { key: "debtStatus", label: "สถานะหนี้", width: 110 },
        { key: "daysOverdue", label: "เกินกำหนด", width: 90, align: "right" },
      ] as const
    : [
        { key: "approveDate", label: "วันที่อนุมัติ", width: 110 },
        { key: "contractNo", label: "เลขที่สัญญา", width: 195 },
        { key: "customerName", label: "ชื่อ-นามสกุล", width: 260 },
        { key: "phone", label: "เบอร์โทร", width: 110 },
        { key: "totalAmount", label: "ยอดผ่อนรวม", width: 110, align: "right" },
        { key: "installmentCount", label: "งวดผ่อน", width: 70, align: "right" },
        { key: "installmentAmount", label: "ผ่อนงวดละ", width: 100, align: "right" },
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
          // Phase 94: ซ่อน penalty/unlockFee เมื่อ principalOnly=true
          ...(!principalOnly ? [
            { key: "penalty", label: "ค่าปรับ", width: 80, align: "right" },
            { key: "unlockFee", label: "ค่าปลดล็อก", width: 90, align: "right" },
          ] : []),
          { key: "amount", label: "ตั้งเป้า", width: 115, align: "right" },
        ]
      : [
          // collected tab: ซ่อน closeInstallmentAmount (ซ้ำซ้อนกับ principal+interest+fee)
          { key: "period", label: "รายการ", width: 55 },
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
          { key: "updatedBy", label: "บันทึกโดย", width: 120 },
          { key: "updatedAt", label: "บันทึกเมื่อ", width: 130 },
          { key: "remark", label: "หมายเหตุ", width: 180 },
        ];

  const GROUP_WIDTH = groupCols.reduce((s, c) => s + c.width, 0);
  const LEFT_WIDTH = LEFT_COLS.reduce((s, c) => s + c.width, 0);
  // Compute sticky left offset for a given column key
  const getStickyLeft = (key: string): number => {
    let offset = 0;
    for (const lc of LEFT_COLS) {
      if (lc.key === key) break;
      if (pinnedCols.has(lc.key)) offset += lc.width;
    }
    return offset;
  };

  return (
    <AppShell>
      <div className="w-full px-3 md:px-5 py-4">
        {/* Tabs (moved to left, replacing title) + Export Excel on right */}
        <div className="flex items-center justify-between gap-2 mb-3">
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
          <div className="flex items-center gap-2">
            {/* ปุ่ม Log Snapshot (target tab only) — เปลี่ยนเป็น "ตั้งเป้ารายเดือน" */}
            {tab === "target" && (
              <div className="flex items-center gap-1.5 relative">
                {/* ปุ่ม Log Snapshot (เปลี่ยนชื่อเป็น "ตั้งเป้ารายเดือน") */}
                <div className="relative snapshot-log-dropdown">
                  <Button
                    variant="outline"
                    className={`border-amber-300 text-amber-700 hover:bg-amber-50 hover:border-amber-400 text-xs px-3 h-9 ${
                      targetViewMode === "snapshot" ? "bg-amber-100 border-amber-500 text-amber-800" : ""
                    }`}
                    onClick={() => setShowSnapshotLog((v) => !v)}
                    title="ดูรายการ Snapshot เป้าเก็บหนี้ที่บันทึกไว้"
                  >
                    <Target className="w-3.5 h-3.5 mr-1.5" />
                    ตั้งเป้ารายเดือน
                    {targetViewMode === "snapshot" && selectedSnapshotMonth && (
                      <span className="ml-1.5 bg-amber-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                        {selectedSnapshotMonth}
                      </span>
                    )}
                  </Button>
                  {/* Dropdown ตาราง 4 คอลัมน์: เดือน-ปี / เป้าเก็บหนี้ / ยอดเก็บหนี้ / % เก็บหนี้ */}
                  {showSnapshotLog && (
                    <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-amber-200 rounded-xl shadow-2xl py-0 overflow-hidden" style={{ minWidth: 520 }}>
                      {/* Header: ข้อมูลปัจจุบัน (Live) */}
                      <button
                        type="button"
                        className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 hover:bg-gray-50 border-b border-gray-100 ${
                          targetViewMode === "live" ? "bg-emerald-50 text-emerald-700 font-medium" : "text-gray-700"
                        }`}
                        onClick={handleBackToLive}
                      >
                        <RefreshCw className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>ข้อมูลปัจจุบัน (Live)</span>
                        {targetViewMode === "live" && <Check className="w-3.5 h-3.5 ml-auto" />}
                      </button>
                      {/* ตาราง 4 คอลัมน์ */}
                      {monthlyDebtSummaryQuery.isLoading ? (
                        <div className="px-4 py-4 text-xs text-gray-400 text-center">กำลังโหลด...</div>
                      ) : (monthlyDebtSummaryQuery.data ?? []).length === 0 ? (
                        <div className="px-4 py-4 text-xs text-gray-400 text-center">ยังไม่มีข้อมูลรายเดือน</div>
                      ) : (
                        <div className="overflow-x-auto">
                          {/* Table Header */}
                          <div className="grid gap-0 bg-amber-50 border-b border-amber-200 text-[11px] font-semibold text-amber-800" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr auto' }}>
                            <div className="px-3 py-2">เดือน-ปี</div>
                            <div className="px-3 py-2 text-right">ตั้งเป้า</div>
                            <div className="px-3 py-2 text-right">ยอดเก็บหนี้</div>
                            <div className="px-3 py-2 text-right">% เก็บหนี้</div>
                            <div className="px-2 py-2 text-center w-9"></div>
                          </div>
                          {/* Table Rows */}
                          {(monthlyDebtSummaryQuery.data as any[]).map((row: any) => {
                            // เป้าเก็บหนี้: ใช้ frozen targetByRange จาก monthly_collection_snapshot ถ้ามี ไม่งั้น fallback ไป row.targetByRange
                            const monthStr = String(row.snapshotMonth ?? "");
                            const frozenRange = getFrozenTargetByRange(monthStr);
                            const targetByRange: Record<string, number> = frozenRange
                              ? frozenRange
                              : (typeof row.targetByRange === 'object' && row.targetByRange) ? row.targetByRange : {};
                            // SUM เฉพาะ 6 สถานะ default (ไม่รวม "เกิน >90")
                            const targetAmt = SNAPSHOT_DEFAULT_STATUSES.reduce((s, rng) => s + (targetByRange[rng] ?? 0), 0) || (row.targetAmount ?? 0);
                            const collectedAmt = Math.max(row.collectedAmount ?? 0, 0);
                            const pct = targetAmt > 0 ? (collectedAmt / targetAmt) * 100 : 0;
                            const pctColor = pct >= 100 ? "text-emerald-600 font-bold" : pct >= 80 ? "text-yellow-600 font-semibold" : "text-red-600 font-semibold";
                            // แปลง YYYY-MM → มิ.ย. 2026 (ใช้ snapshotMonth จาก getMonthlyDebtSummary)
                            const [yr, mo] = monthStr.split("-").map(Number);
                            const THAI_MONTHS_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
                            const monthLabel = mo >= 1 && mo <= 12 ? `${THAI_MONTHS_SHORT[mo - 1]} ${yr}` : monthStr;
                            return (
                              <div
                                key={monthStr}
                                className="grid gap-0 border-b border-gray-50 hover:bg-amber-50 text-sm transition-colors group"
                                style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr auto' }}
                              >
                                {/* คลิกทั้ง row เพื่อเลือก Snapshot */}
                                <div
                                  className="px-3 py-2.5 font-medium text-gray-800 text-[13px] cursor-pointer select-none"
                                  onClick={() => { handleSelectSnapshot(monthStr); setShowSnapshotLog(false); }}
                                  title={`คลิกเพื่อดู Snapshot เดือน ${monthLabel}`}
                                >{monthLabel}</div>
                                <div
                                  className="px-3 py-2.5 text-right text-gray-700 tabular-nums text-[13px] cursor-pointer select-none"
                                  onClick={() => { handleSelectSnapshot(monthStr); setShowSnapshotLog(false); }}
                                >
                                  {targetAmt > 0 ? targetAmt.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : <span className="text-gray-300">—</span>}
                                </div>
                                <div
                                  className="px-3 py-2.5 text-right text-gray-700 tabular-nums text-[13px] cursor-pointer select-none"
                                  onClick={() => { handleSelectSnapshot(monthStr); setShowSnapshotLog(false); }}
                                >
                                  {collectedAmt > 0 ? collectedAmt.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : <span className="text-gray-300">—</span>}
                                </div>
                                <div
                                  className={`px-3 py-2.5 text-right tabular-nums text-[13px] ${pctColor} cursor-pointer select-none`}
                                  onClick={() => { handleSelectSnapshot(monthStr); setShowSnapshotLog(false); }}
                                >
                                  {targetAmt > 0 ? `${pct.toFixed(1)}%` : <span className="text-gray-300">—</span>}
                                </div>
                                {/* ปุ่มดูรายวัน */}
                                <div className="px-1 py-1.5 flex items-center justify-center w-9">
                                  <button
                                    type="button"
                                    className="p-1.5 rounded-md text-amber-600 hover:bg-amber-200 hover:text-amber-800 transition-colors"
                                    title={`ดูยอดรายวัน ${monthLabel}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      // reset filter เป็น global default (6 สถานะ) ทุกครั้งที่เปิด popup
                                      setDailyBreakdownStatuses(SNAPSHOT_DEFAULT_STATUSES);
                                      setDailyBreakdownMonth(monthStr);
                                    }}
                                  >
                                    <BarChart2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* ปุ่ม i อธิบายสีตัวเลข */}
            <Button
              variant="outline"
              size="icon"
              className="w-9 h-9 rounded-full border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              onClick={() => setShowColorLegend(true)}
              title="คำอธิบายสีและสัญลักษณ์"
            >
              <Info className="w-4 h-4" />
            </Button>
            {canExport && (
              <div className="flex flex-col items-end gap-0.5">
                <Button
                  className="bg-green-600 hover:bg-green-700 text-white"
                  onClick={handleExport}
                >
                  <Download className="w-4 h-4 mr-1.5" />
                  Export Excel
                </Button>
                <span className="text-xs text-muted-foreground">
                  {filteredRows.length.toLocaleString("th-TH")} รายการ (กรองแล้ว)
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Toolbar: Search > ApproveDate > Date > DueDate > Status > ProductType > PrincipalOnly > ตั้งเป้า (target) | บันทึกโดย (collected) */}
        {<div className="flex flex-col gap-2 mb-2">
          <div className="flex flex-col md:flex-row md:items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="ค้นหา: เลขที่สัญญา / ชื่อลูกค้า / เบอร์โทร"
                className="pl-9 bg-white"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* เดือน-ปีที่อนุมัติ (ย้ายมาก่อน วว/ดด/ปปปป) */}
              <MultiSelectFilter
                label="เดือน-ปีที่อนุมัติ"
                selected={approveDateFilter}
                onChange={setApproveDateFilter}
                options={approveDateOptions}
                placeholder="ทุกเดือน-ปีที่อนุมัติ"
              />
              {/* วันที่ (date picker) — target=วันที่ต้องชำระ, collected=วันที่ชำระ */}
              <div className="flex items-center gap-1.5">
                <div className="relative flex items-center">
                  <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                  <input
                    type="date"
                    value={dueDateExact ?? ""}
                    onChange={(e) => setDueDateExact(e.target.value || null)}
                    className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]"
                    title={tab === "target" ? "วันที่ต้องชำระ" : "วันที่ชำระ"}
                    placeholder={tab === "target" ? "วันที่ต้องชำระ" : "วันที่ชำระ"}
                  />
                </div>
                {dueDateExact && (
                  <button
                    type="button"
                    onClick={() => setDueDateExact(null)}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors"
                    title="ล้างฟิลเตอร์วันที่"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {/* Phase 28: label changes based on tab — target=ต้องชำระ, collected=ชำระ */}
              <MultiSelectFilter
                label={tab === "collected" ? "เดือน-ปีที่ชำระ" : "เดือน-ปีที่ต้องชำระ"}
                selected={dueDateFilter}
                onChange={setDueDateFilter}
                options={dueDateOptions}
                placeholder={tab === "collected" ? "ทุกเดือน-ปีที่ชำระ" : "ทุกเดือน-ปีที่ต้องชำระ"}
              />
              {/* สถานะหนี้ */}
              <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
              {/* ประเภทเครื่อง */}
              <MultiSelectFilter
                label="ประเภทเครื่อง"
                selected={productTypeFilter}
                onChange={setProductTypeFilter}
                options={productTypeOptions}
                placeholder="ทุกประเภทเครื่อง"
              />
              {/* เฉพาะเงินต้น (target tab only) */}
              {tab === "target" && (
                <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5">
                  <Switch id="principal-only" checked={principalOnly} onCheckedChange={setPrincipalOnly} />
                  <label htmlFor="principal-only" className="text-xs text-gray-600 cursor-pointer select-none whitespace-nowrap">
                    เฉพาะเงินต้น
                  </label>
                </div>
              )}
              {/* ตั้งเป้า (target tab only) — เมื่อเปิด ขึ้น Dialog เลือก cutoff mode */}
              {tab === "target" && (
                <div
                  className={`flex items-center gap-2 border rounded-md px-3 py-1.5 cursor-pointer select-none transition-colors ${
                    debtSetMode
                      ? "bg-orange-50 border-orange-300"
                      : "bg-white border-gray-200"
                  }`}
                  onClick={() => {
                    if (debtSetMode) {
                      // ปิด toggle โดยตรง
                      setDebtSetMode(false);
                    } else {
                      // เปิด Dialog เลือก cutoff mode
                      setPendingDebtSetCutoffMode(debtSetCutoffMode);
                      setShowDebtSetDialog(true);
                    }
                  }}
                  title="เปิด: แสดงเฉพาะยอดค้างชำระและยอดที่ยังไม่ได้ชำระถึงงวดปัจจุบัน (ส้ม+ดำ)"
                >
                  <Switch
                    id="debt-set-mode"
                    checked={debtSetMode}
                    onCheckedChange={(v) => {
                      if (v) {
                        // เปิด Dialog เลือก cutoff mode
                        setPendingDebtSetCutoffMode(debtSetCutoffMode);
                        setShowDebtSetDialog(true);
                      } else {
                        setDebtSetMode(false);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <label htmlFor="debt-set-mode" className={`text-xs cursor-pointer whitespace-nowrap ${
                    debtSetMode ? "text-orange-700 font-medium" : "text-gray-600"
                  }`}>
                    ตั้งเป้า
                    {debtSetMode && (
                      <span className={`ml-1 text-[10px] px-1 py-0.5 rounded ${
                        debtSetCutoffMode === "end_of_month"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-violet-100 text-violet-700"
                      }`}>
                        {debtSetCutoffMode === "end_of_month" ? (() => {
                          const _TM = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
                          const _d = new Date();
                          return _TM[_d.getMonth()] + String(_d.getFullYear()).slice(2);
                        })() : "วันนี้"}
                      </span>
                    )}
                  </label>
                </div>
              )}
              {/* บันทึกโดย (collected tab only) */}
              {tab === "collected" && updatedByOptions.length > 0 && (
                <div className="relative">
                  <select
                    value={updatedByFilter ?? ""}
                    onChange={(e) => setUpdatedByFilter(e.target.value || null)}
                    className="h-9 pl-3 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none"
                    title="กรองตามผู้บันทึกรายการ"
                  >
                    <option value="">บันทึกโดย: ทั้งหมด</option>
                    {updatedByOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  {updatedByFilter && (
                    <button
                      type="button"
                      onClick={() => setUpdatedByFilter(null)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"
                      title="ล้างตัวกรองบันทึกโดย"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
              {(statusFilter.size > 0 || approveDateFilter.size > 0 || dueDateFilter.size > 0 || productTypeFilter.size > 0 || dueDateExact || updatedByFilter || debtSetMode) && (
                <button
                  type="button"
                  onClick={() => { setStatusFilter(new Set()); setApproveDateFilter(new Set()); setDueDateFilter(new Set()); setProductTypeFilter(new Set()); setDueDateExact(null); setUpdatedByFilter(null); setDebtSetMode(false); }}
                  className="text-xs text-gray-400 hover:text-red-500 underline"
                >
                  ล้างฟิลเตอร์
                </button>
              )}
            </div>
          </div>
        </div>}

        {/* Snapshot Mode Banner */}
        {tab === "target" && targetViewMode === "snapshot" && selectedSnapshotMonth && (
          <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-violet-50 border border-violet-200 rounded-lg text-sm text-violet-800">
            <Camera className="w-4 h-4 flex-shrink-0 text-violet-600" />
            <span>กำลังดูข้อมูล <strong>Snapshot {selectedSnapshotMonth}</strong> — ไม่ใช่ข้อมูล Live</span>
            {targetSnapshotViewQuery.isFetching && <RefreshCw className="w-3.5 h-3.5 animate-spin ml-1 text-violet-500" />}
            <button
              type="button"
              className="ml-auto text-xs text-violet-600 hover:text-violet-800 underline"
              onClick={handleBackToLive}
            >
              กลับ Live
            </button>
          </div>
        )}

        {/* Summary line + Summary Badges */}
        {<div className="flex flex-wrap items-start justify-between gap-2 mb-2">
          <div className="text-xs text-gray-500 self-center">
            ทั้งหมด {activeRows.length.toLocaleString("th-TH")} สัญญา · กรอง{" "}
            {filteredRows.length.toLocaleString("th-TH")} รายการ ·{" "}
            {tab === "target" ? "ข้อมูลเป้าเก็บหนี้" : "ข้อมูลยอดเก็บหนี้"} ของงวดที่{" "}
            1–{maxPeriods || "-"}
          </div>
          {/* Summary Badges */}
          {tab === "target" && targetSummary && (
            <div className="flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                <Banknote className="w-3 h-3" />
                เงินต้น: {fmtMoney(targetSummary.principal)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200">
                <Percent className="w-3 h-3" />
                ดอกเบี้ย: {fmtMoney(targetSummary.interest)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-cyan-50 text-cyan-700 border border-cyan-200">
                <CircleDollarSign className="w-3 h-3" />
                ค่าดำเนินการ: {fmtMoney(targetSummary.fee)}
              </span>
              {!principalOnly && (
                <>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700 border border-red-200">
                    <Gavel className="w-3 h-3" />
                    ค่าปรับ: {fmtMoney(targetSummary.penalty)}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-50 text-orange-700 border border-orange-200">
                    <LockOpen className="w-3 h-3" />
                    ค่าปลดล็อก: {fmtMoney(targetSummary.unlockFee)}
                  </span>
                </>
              )}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                <Target className="w-3 h-3" />
                เป้าเก็บหนี้: {fmtMoney(targetSummary.total)}
              </span>
            </div>
          )}
          {tab === "collected" && collectedSummary && (
            <div className="flex flex-wrap gap-1.5">
              {/* Helper: renders a badge with eye toggle. discount badge has canToggle=false */}
              {([
                hasPrincipalBreakdown && { key: "principal", label: "เงินต้น", value: collectedSummary.principal, icon: <Banknote className="w-3 h-3" />, colors: "bg-blue-50 text-blue-700 border-blue-200", canToggle: true },
                hasPrincipalBreakdown && { key: "interest", label: "ดอกเบี้ย", value: collectedSummary.interest, icon: <Percent className="w-3 h-3" />, colors: "bg-purple-50 text-purple-700 border-purple-200", canToggle: true },
                hasPrincipalBreakdown && { key: "fee", label: "ค่าดำเนินการ", value: collectedSummary.fee, icon: <CircleDollarSign className="w-3 h-3" />, colors: "bg-cyan-50 text-cyan-700 border-cyan-200", canToggle: true },
                { key: "penalty", label: "ค่าปรับ", value: collectedSummary.penalty, icon: <Gavel className="w-3 h-3" />, colors: "bg-red-50 text-red-700 border-red-200", canToggle: true },
                { key: "unlockFee", label: "ค่าปลดล็อก", value: collectedSummary.unlockFee, icon: <LockOpen className="w-3 h-3" />, colors: "bg-orange-50 text-orange-700 border-orange-200", canToggle: true },
                { key: "discount", label: "ส่วนลด", value: collectedSummary.discount, icon: <Tag className="w-3 h-3" />, colors: "bg-teal-50 text-teal-700 border-teal-200", canToggle: false },
                { key: "overpaid", label: "ชำระเกิน", value: collectedSummary.overpaid, icon: <TrendingUp className="w-3 h-3" />, colors: "bg-emerald-50 text-emerald-700 border-emerald-200", canToggle: true },
                { key: "badDebt", label: "หนี้เสีย", value: collectedSummary.badDebt, icon: <TrendingDown className="w-3 h-3" />, colors: "bg-red-50 text-red-700 border-red-200", canToggle: true },
                collectedSummary.extraPenalty > 0 && { key: "extraPenalty", label: "ค่าปรับเพิ่มเติม", value: collectedSummary.extraPenalty, icon: <Gavel className="w-3 h-3" />, colors: "bg-amber-50 text-amber-700 border-amber-200", canToggle: false },
              ] as const).filter(Boolean).map((b) => {
                if (!b) return null;
                const isOn = badgeVisibility[b.key] ?? false;
                const dimmed = !isOn;
                return (
                  <span
                    key={b.key}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${b.colors} ${dimmed ? "opacity-40" : ""}`}
                  >
                    {b.icon}
                    {b.label}: {fmtMoney(b.value)}
                    <button
                      type="button"
                      onClick={() => toggleBadge(b.key)}
                      disabled={!b.canToggle}
                      className={`ml-0.5 rounded-full p-0.5 transition-opacity ${b.canToggle ? "hover:opacity-70 cursor-pointer" : "cursor-not-allowed opacity-30"}`}
                      title={!b.canToggle ? (b.key === "extraPenalty" ? "ค่าปรับเพิ่มเติม (pt.amount=0) ไม่นับในยอดรวม" : "ส่วนลดไม่นำมาคำนวณยอดรวม") : isOn ? "คลิกเพื่อไม่นำมารวมในยอดรวม" : "คลิกเพื่อนำมารวมในยอดรวม"}
                      aria-label={isOn ? `ปิด ${b.label}` : `เปิด ${b.label}`}
                    >
                      {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                  </span>
                );
              })}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                <Wallet className="w-3 h-3" />
                ยอดที่ชำระรวม: {fmtMoney(collectedSummary.total)}
              </span>
            </div>
          )}
        </div>}


        {/* Table */}
        {(isError ? (
          /* Phase 32: แสดง error state พร้อมปุ่ม retry */
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="text-center">
              <p className="text-sm font-semibold text-red-600 mb-1">โหลดข้อมูลไม่สำเร็จ</p>
              <p className="text-xs text-gray-500 mb-3">
                {typeof queryError === "string" && queryError.includes("aborted")
                  ? "การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองใหม่"
                  : (typeof queryError === "string" ? queryError : "เกิดข้อผิดพลาด กรุณาลองใหม่")}
              </p>
              <button
                onClick={() => refetch()}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors"
              >
                ลองใหม่
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Spinner />
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700">
                {elapsedSec < 5
                  ? "กำลังโหลดข้อมูล..."
                  : elapsedSec < 20
                  ? `กำลังโหลดข้อมูล... (${elapsedSec} วินาที)`
                  : `กำลังประมวลผลข้อมูลจำนวนมาก... (${elapsedSec} วินาที)`}
              </p>
              {/* Phase 42: แสดง hint + progress bar ตั้งแต่วินาทีแรก */}
              <p className="text-xs text-gray-500 mt-1">
                {elapsedSec < 5
                  ? "กำลังเชื่อมต่อ..."
                  : elapsedSec < 20
                  ? "ครั้งถัดไปจะเร็วขึ้นมาก (ข้อมูลถูก cache ไว้)"
                  : "ข้อมูลมีปริมาณมาก กรุณารอสักครู่..."}
              </p>
              {/* Phase 114: แสดง contracts ที่ได้รับระหว่างโหลด */}
              {(tab === "target" ? streamProgress.target : streamProgress.collected) > 0 && (
                <p className="text-xs text-blue-600 mt-1">
                  โหลดแล้ว {(tab === "target" ? streamProgress.target : streamProgress.collected).toLocaleString()} /
                  {" "}{(tab === "target" ? streamTotal.target : streamTotal.collected).toLocaleString()} สัญญา
                </p>
              )}
              <div className="mt-3 w-64 bg-gray-200 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    // Phase 114: Progress bar — ใช้ contracts received / total
                    width: (() => {
                      const received = tab === "target" ? streamProgress.target : streamProgress.collected;
                      const total = tab === "target" ? streamTotal.target : streamTotal.collected;
                      if (total > 0) {
                        return `${Math.min(98, Math.max(5, (received / total) * 100))}%`;
                      }
                      // ยังไม่รู้ total — ใช้ elapsed time
                      return elapsedSec < 5
                        ? `${Math.max(3, (elapsedSec / 5) * 20)}%`
                        : elapsedSec < 20
                        ? `${Math.min(70, 20 + ((elapsedSec - 5) / 15) * 50)}%`
                        : `${Math.min(95, 70 + ((elapsedSec - 20) / 40) * 25)}%`;
                    })(),
                    background: tab === "target" ? "#b45309" : "#047857",
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="border rounded-lg bg-white overflow-auto"
            style={{ maxHeight: "calc(100vh - 280px)" }}
          >
            <div style={{ width: tab === "collected" ? LEFT_WIDTH + GROUP_WIDTH : LEFT_WIDTH + GROUP_WIDTH * maxPeriods }}>
              {/* Header row */}
              <div className="sticky top-0 z-20 bg-white">
                {/* Tier 1: group header over installment columns */}
                <div className="flex border-b bg-slate-100 text-[12px] font-semibold text-slate-700">
                  <div
                    className="bg-slate-100 border-r"
                    style={{ width: LEFT_WIDTH, height: 28 }}
                  />
                  {tab === "collected" ? (
                    // Phase 3: collected tab = single group header (vertical layout)
                    <div
                      className="border-r text-center flex items-center justify-center text-white"
                      style={{ width: GROUP_WIDTH, height: 28, background: "#047857" }}
                    >
                      รายการชำระเงิน
                    </div>
                  ) : (
                    Array.from({ length: maxPeriods }, (_, i) => (
                      <div
                        key={`gh-${i}`}
                        className="border-r text-center flex items-center justify-center text-white"
                        style={{ width: GROUP_WIDTH, height: 28, background: "#b45309" }}
                      >
                        ตั้งเป้างวดที่่ {i + 1}
                      </div>
                    ))
                  )}
                </div>
                {/* Tier 2: left columns + sub-columns of each group */}
                <div className="flex border-b bg-slate-50 text-[12px] font-semibold text-slate-700">
                  {LEFT_COLS.map((c) => {
                    const isPinned = pinnedCols.has(c.key);
                    return (
                      <div
                        key={c.key}
                        className="px-2 py-1.5 border-r whitespace-nowrap"
                        style={{
                          width: c.width,
                          textAlign: (c as any).align === "right" ? "right" : "left",
                          position: isPinned ? "sticky" : undefined,
                          left: isPinned ? (() => {
                            // compute left offset = sum of widths of all pinned cols before this one
                            let offset = 0;
                            for (const lc of LEFT_COLS) {
                              if (lc.key === c.key) break;
                              if (pinnedCols.has(lc.key)) offset += lc.width;
                            }
                            return offset;
                          })() : undefined,
                          zIndex: isPinned ? 30 : undefined,
                          background: isPinned ? "#dbeafe" : undefined,
                        }}
                      >
                        <div className="flex items-center gap-1 justify-between">
                          <span>{c.label}</span>
                          <button
                            onClick={() => togglePin(c.key)}
                            title={isPinned ? "ยกเลิก sticky" : "ตรึงคอลัมน์นี้"}
                            className={"flex-shrink-0 rounded p-0.5 " + (isPinned ? "text-blue-600 hover:text-blue-800" : "text-gray-300 hover:text-gray-600")}
                          >
                            {isPinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {tab === "collected" ? (
                    // Phase 3: collected tab = single group header columns
                    groupCols.map((gc) => (
                      <div
                        key={`h-c-${gc.key}`}
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: gc.width,
                          textAlign: (gc as any).align === "right" ? "right" : "left",
                          background: "#ecfdf5", // emerald-50
                          color: "#064e3b", // emerald-900
                        }}
                      >
                        {gc.label}
                      </div>
                    ))
                  ) : (
                    Array.from({ length: maxPeriods }, (_, i) =>
                      groupCols.map((gc) => {
                        const subBg = i % 2 === 0 ? "#fffbeb" : "#fef3c7"; // amber-50 / amber-100
                        return (
                          <div
                            key={`h-${i}-${gc.key}`}
                            className="px-2 py-2 border-r whitespace-nowrap"
                            style={{
                              width: gc.width,
                              textAlign: (gc as any).align === "right" ? "right" : "left",
                              background: subBg,
                              color: "#78350f", // amber-900
                            }}
                          >
                            {gc.label}
                          </div>
                        );
                      }),
                    )
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
                  // Phase 3: Build filtered payments list for collected tab (vertical layout)
                  // Phase 28: filter payments by paidAt month (dueDateFilter) and exact date (dueDateExact)
                  const filteredPayments: PaymentCell[] = [];
                  if (tab === "collected") {
                    for (const p of (r as CollectedRow).payments ?? []) {
                      // Phase 28: skip payments whose paidAt month is not in dueDateFilter
                      if (dueDateFilter.size > 0 && !(p.paidAt && dueDateFilter.has(p.paidAt.slice(0, 7)))) continue;
                      // Phase 30: skip payments whose paidAt date does not match dueDateExact
                      if (dueDateExact && p.paidAt?.slice(0, 10) !== dueDateExact) continue;
                      // บันทึกโดย: ซ่อน payment ที่ไม่ใช่ของคนที่เลือก
                      if (updatedByFilter && p.updatedBy !== updatedByFilter) continue;
                      filteredPayments.push(p);
                    }
                  }
                  // Phase 3: Compute summary for collected tab
                  const isExpanded = tab === "collected" && expandedRows.has(r.contractNo ?? "");
                  // Summary row: sum of all filtered payments
                  const summaryPrincipal = filteredPayments.reduce((s, p) => s + (p.principal ?? 0), 0);
                  const summaryInterest = filteredPayments.reduce((s, p) => s + (p.interest ?? 0), 0);
                  const summaryFee = filteredPayments.reduce((s, p) => s + (p.fee ?? 0), 0);
                  const summaryPenalty = filteredPayments.reduce((s, p) => s + (p.penalty ?? 0), 0);
                  const summaryUnlockFee = filteredPayments.reduce((s, p) => s + (p.unlockFee ?? 0), 0);
                  const summaryDiscount = filteredPayments.reduce((s, p) => s + (p.discount ?? 0), 0);
                  const summaryOverpaid = filteredPayments.reduce((s, p) => s + (p.overpaid ?? 0), 0);
                  const summaryBadDebt = filteredPayments.reduce((s, p) => s + (p.badDebt ?? 0), 0);
                  // Phase 89: summaryTotal must include badDebt because badDebtRow has total=0 but badDebt=contractBadDebtAmount
                  const summaryTotal = filteredPayments.reduce((s, p) => s + (p.total ?? 0), 0) + summaryBadDebt;
                  // Latest period = max period with paidAt
                  const latestPay = filteredPayments.filter(p => p.paidAt).sort((a, b) => {
                    if ((a.paidAt ?? "") > (b.paidAt ?? "")) return -1;
                    if ((a.paidAt ?? "") < (b.paidAt ?? "")) return 1;
                    return (b.period ?? 0) - (a.period ?? 0);
                  })[0] ?? null;
                  const summaryPeriod = latestPay?.period ?? null;
                  const summaryPaidAt = latestPay?.paidAt ?? null;
                  // Phase 3: vertical layout height
                  const collectedRowH = tab === "collected"
                    ? ROW_HEIGHT + (isExpanded ? filteredPayments.length * SUB_ROW_HEIGHT : 0)
                    : rowH;
                  return (
                    <div
                      key={vr.key}
                      className={`flex border-b text-[12px] transition-colors cursor-default relative ${
                        hoveredRow === vr.index
                          ? "shadow-[inset_4px_0_0_0_#2563eb,inset_0_-1px_0_0_#93c5fd,0_-1px_0_0_#93c5fd]"
                          : ""
                      }`}
                      style={{ height: tab === "collected" ? collectedRowH : rowH }}
                      onMouseEnter={() => setHoveredRow(vr.index)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      {/* Left fixed columns — no `truncate`: show full text,
                          especially for long contract numbers. */}
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[0].width,
                          position: pinnedCols.has("approveDate") ? "sticky" : undefined,
                          left: pinnedCols.has("approveDate") ? getStickyLeft("approveDate") : undefined,
                          zIndex: pinnedCols.has("approveDate") ? 10 : undefined,
                          background: pinnedCols.has("approveDate") ? "#eff6ff" : undefined,
                        }}
                      >
                        {fmtDate(r.approveDate)}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[1].width,
                          position: pinnedCols.has("contractNo") ? "sticky" : undefined,
                          left: pinnedCols.has("contractNo") ? getStickyLeft("contractNo") : undefined,
                          zIndex: pinnedCols.has("contractNo") ? 10 : undefined,
                          background: pinnedCols.has("contractNo") ? "#eff6ff" : undefined,
                        }}
                        title={r.contractNo ?? undefined}
                      >
                        {r.contractNo ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[2].width,
                          position: pinnedCols.has("customerName") ? "sticky" : undefined,
                          left: pinnedCols.has("customerName") ? getStickyLeft("customerName") : undefined,
                          zIndex: pinnedCols.has("customerName") ? 10 : undefined,
                          background: pinnedCols.has("customerName") ? "#eff6ff" : undefined,
                        }}
                        title={r.customerName ?? undefined}
                      >
                        {r.customerName ?? "-"}
                      </div>
                      <div
                        className="px-2 py-2 border-r whitespace-nowrap"
                        style={{
                          width: LEFT_COLS[3].width,
                          position: pinnedCols.has("phone") ? "sticky" : undefined,
                          left: pinnedCols.has("phone") ? getStickyLeft("phone") : undefined,
                          zIndex: pinnedCols.has("phone") ? 10 : undefined,
                          background: pinnedCols.has("phone") ? "#eff6ff" : undefined,
                        }}
                      >
                        {r.phone ?? "-"}
                      </div>
                      {/* productType column — only in collected tab (LEFT_COLS[4] = productType when collected) */}
                      {tab === "collected" && (
                        <div
                          className="px-2 py-2 border-r whitespace-nowrap"
                          style={{
                            width: 110,
                            position: pinnedCols.has("productType") ? "sticky" : undefined,
                            left: pinnedCols.has("productType") ? getStickyLeft("productType") : undefined,
                            zIndex: pinnedCols.has("productType") ? 10 : undefined,
                            background: pinnedCols.has("productType") ? "#eff6ff" : undefined,
                          }}
                        >
                          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                            <Smartphone className="w-3 h-3" />
                            {r.productType ?? "-"}
                          </span>
                        </div>
                      )}
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: tab === "collected" ? LEFT_COLS[5].width : LEFT_COLS[4].width,
                          position: pinnedCols.has("totalAmount") ? "sticky" : undefined,
                          left: pinnedCols.has("totalAmount") ? getStickyLeft("totalAmount") : undefined,
                          zIndex: pinnedCols.has("totalAmount") ? 10 : undefined,
                          background: pinnedCols.has("totalAmount") ? "#eff6ff" : undefined,
                        }}
                      >
                        {/* ยอดผ่อนรวม = N × X (งวดผ่อน × ผ่อนงวดละ) */}
                        {r.installmentCount != null && r.installmentAmount != null
                          ? fmtMoney(r.installmentCount * r.installmentAmount)
                          : fmtMoney(r.totalAmount)}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "installmentCount")?.width ?? 70,
                          position: pinnedCols.has("installmentCount") ? "sticky" : undefined,
                          left: pinnedCols.has("installmentCount") ? getStickyLeft("installmentCount") : undefined,
                          zIndex: pinnedCols.has("installmentCount") ? 10 : undefined,
                          background: pinnedCols.has("installmentCount") ? "#eff6ff" : undefined,
                        }}
                      >
                        {(() => {
                          if (tab === "collected") {
                            // ยอดเก็บหนี้: แสดง "ผ่อนถึงงวดที่ X/N"
                            // X = งวดสูงสุดที่มีการชำระเข้ามาแล้ว (max payment.period)
                            // X = 0 เมื่อไม่มีการชำระเลย
                            // Cap: X ต้องไม่เกิน installmentCount (กรณีชำระเกินงวด เช่น 9/8 → 8/8)
                            const collectedR = r as CollectedRow;
                            // นับเฉพาะ payment ที่ไม่ใช่ isBadDebtRow (หนี้เสีย/ขายเครื่อง)
                            const rawMaxPaidPeriod = collectedR.payments?.reduce((max, p) => {
                              if (p.isBadDebtRow) return max; // ข้ามรายการหนี้เสีย
                              if (p.period != null && p.period > max) return p.period;
                              return max;
                            }, 0) ?? 0;
                            const maxPaidPeriod = r.installmentCount != null
                              ? Math.min(rawMaxPaidPeriod, r.installmentCount)
                              : rawMaxPaidPeriod;
                            if (r.installmentCount != null) {
                              return `${maxPaidPeriod}/${r.installmentCount}`;
                            }
                            return r.installmentCount ?? "-";
                          } else {
                            // เป้าเก็บหนี้: ใช้ค่า N/M จากยอดเก็บหนี้โดยตรง (collectedPaidPeriodMap)
                            // ไม่คำนวณเองจาก installments เพราะยอดเก็บหนี้มีค่าที่ถูกต้องอยู่แล้ว
                            // Cap: N ≤ installmentCount (สัญญาที่ชำระเกินงวด เช่น 9/8 → 8/8)
                            // N+1 rule ถูกยกเลิก — server จัดการ suspendedFromPeriod ≥ 2 แล้ว (งวดที่ 1 ตั้งเป้าเสมอ)
                            const rawN = collectedPaidPeriodMap.get(r.contractExternalId);
                            if (rawN != null && r.installmentCount != null) {
                              const cappedN = Math.min(rawN, r.installmentCount);
                              return `${cappedN}/${r.installmentCount}`;
                            }
                            // fallback เมื่อ collected data ยังไม่โหลด
                            if (r.installmentCount != null) {
                              return `-/${r.installmentCount}`;
                            }
                            return "-";
                          }
                        })()}
                      </div>
                      <div
                        className="px-2 py-2 border-r text-right tabular-nums"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "installmentAmount")?.width ?? 100,
                          position: pinnedCols.has("installmentAmount") ? "sticky" : undefined,
                          left: pinnedCols.has("installmentAmount") ? getStickyLeft("installmentAmount") : undefined,
                          zIndex: pinnedCols.has("installmentAmount") ? 10 : undefined,
                          background: pinnedCols.has("installmentAmount") ? "#eff6ff" : undefined,
                        }}
                      >
                        {fmtMoney(r.installmentAmount)}
                      </div>
                      <div
                        className="px-2 py-1.5 border-r"
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "debtStatus")?.width ?? 110,
                          position: pinnedCols.has("debtStatus") ? "sticky" : undefined,
                          left: pinnedCols.has("debtStatus") ? getStickyLeft("debtStatus") : undefined,
                          zIndex: pinnedCols.has("debtStatus") ? 10 : undefined,
                          background: pinnedCols.has("debtStatus") ? "#eff6ff" : undefined,
                        }}
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
                        style={{
                          width: (LEFT_COLS as unknown as {key:string;width:number}[]).find((c) => c.key === "daysOverdue")?.width ?? 90,
                          position: pinnedCols.has("daysOverdue") ? "sticky" : undefined,
                          left: pinnedCols.has("daysOverdue") ? getStickyLeft("daysOverdue") : undefined,
                          zIndex: pinnedCols.has("daysOverdue") ? 10 : undefined,
                          background: pinnedCols.has("daysOverdue") ? "#eff6ff" : undefined,
                        }}
                      >
                        {r.daysOverdue > 0 ? r.daysOverdue : 0}
                      </div>
                      {/* Repeating groups: target tab = matrix, collected tab = vertical layout */}
                      {tab === "collected" ? (
                        // Phase 3: Vertical layout for collected tab
                        // Summary row (always visible) + Detail rows (visible when expanded)
                        // Right section: flex-col so summary row + detail rows stack vertically
                        <div className="flex flex-col flex-1">
                          {/* Summary row */}
                          <div className="flex" style={{ height: ROW_HEIGHT }}>
                            {groupCols.map((gc) => {
                              let v: React.ReactNode = "";
                              const hasPayments = filteredPayments.length > 0;
                              switch (gc.key) {
                                case "period":
                                  // Show expand/collapse toggle + payment count
                                  v = (
                                    <button
                                      type="button"
                                      onClick={() => toggleExpand(r.contractNo ?? "")}
                                      className="flex items-center gap-1 text-emerald-700 hover:text-emerald-900 font-semibold"
                                      title={isExpanded ? "ซ่อนรายการ" : "แสดงรายการ"}
                                    >
                                      <ChevronRight
                                        className={`w-3.5 h-3.5 transition-transform ${
                                          isExpanded ? "rotate-90" : ""
                                        }`}
                                      />
                                      {hasPayments ? filteredPayments.length : "-"}
                                    </button>
                                  );
                                  break;
                                case "paidAt":
                                  v = summaryPaidAt ? fmtDate(summaryPaidAt) : "-";
                                  break;
                                case "principal":
                                  v = hasPrincipalBreakdown && summaryPrincipal > 0 ? fmtMoney(summaryPrincipal) : "-";
                                  break;
                                case "interest":
                                  v = hasPrincipalBreakdown && summaryInterest > 0 ? fmtMoney(summaryInterest) : "-";
                                  break;
                                case "fee":
                                  v = hasPrincipalBreakdown && summaryFee > 0 ? fmtMoney(summaryFee) : "-";
                                  break;
                                case "penalty":
                                  v = summaryPenalty > 0 ? fmtMoney(summaryPenalty) : "-";
                                  break;
                                case "unlockFee":
                                  v = summaryUnlockFee > 0 ? fmtMoney(summaryUnlockFee) : "-";
                                  break;
                                case "discount":
                                  v = summaryDiscount > 0 ? fmtMoney(summaryDiscount) : "-";
                                  break;
                                case "overpaid":
                                  v = summaryOverpaid > 0 ? fmtMoney(summaryOverpaid) : "-";
                                  break;
                                case "closeInstallmentAmount":
                                  v = "-";
                                  break;
                                case "badDebt":
                                  v = summaryBadDebt > 0 ? fmtMoney(summaryBadDebt) : "-";
                                  break;
                                case "total":
                                  v = summaryTotal > 0 ? fmtMoney(summaryTotal) : "-";
                                  break;
                                case "updatedBy":
                                case "updatedAt":
                                case "remark":
                                  v = "-";
                                  break;
                              }
                              const isTotal = gc.key === "total";
                              return (
                                <div
                                  key={`cs-${vr.index}-${gc.key}`}
                                  className={`px-2 border-r flex items-center tabular-nums ${
                                    isTotal ? "font-bold text-emerald-800" : "text-slate-700"
                                  }`}
                                  style={{
                                    width: gc.width,
                                    height: ROW_HEIGHT,
                                    textAlign: (gc as any).align === "right" ? "right" : "left",
                                    justifyContent: (gc as any).align === "right" ? "flex-end" : "flex-start",
                                    background: "#f0fdf4", // green-50
                                  }}
                                >
                                  {v}
                                </div>
                              );
                            })}
                          </div>
                          {/* Detail rows (expanded) */}
                          {isExpanded && filteredPayments.map((pay, li) => (
                            <div
                              key={`cd-${vr.index}-${li}`}
                              className="flex border-t border-dashed border-emerald-100"
                              style={{ height: SUB_ROW_HEIGHT }}
                            >
                              {groupCols.map((gc, gcIdx) => {
                                let v: React.ReactNode = "";
                                const isCloseCell = !!pay.isCloseRow;
                                const isCarryRow = pay.receiptNo === "(carry)";
                                switch (gc.key) {
                                  case "period":
                                    v = pay.period != null
                                      ? `${pay.period}-${(pay.splitIndex ?? 0) + 1}`
                                      : "-";
                                    break;
                                  case "paidAt":
                                    v = fmtDate(pay.paidAt);
                                    break;
                                  case "principal":
                                    v = hasPrincipalBreakdown ? fmtMoney(pay.principal) : "-";
                                    break;
                                  case "interest":
                                    v = hasPrincipalBreakdown ? fmtMoney(pay.interest) : "-";
                                    break;
                                  case "fee":
                                    v = hasPrincipalBreakdown ? fmtMoney(pay.fee) : "-";
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
                                    v = pay.isCloseRow ? fmtMoney(pay.closeInstallmentAmount) : fmtMoney(0);
                                    break;
                                  case "badDebt":
                                    v = fmtMoney(pay.badDebt || 0);
                                    break;
                                  case "total":
                                    v = fmtMoney(pay.total);
                                    break;
                                  case "updatedBy":
                                    v = pay.updatedBy ?? "-";
                                    break;
                                  case "updatedAt":
                                    v = pay.updatedAt ? fmtDateTime(pay.updatedAt) : "-";
                                    break;
                                  case "remark":
                                    v = pay.remark ?? "-";
                                    break;
                                }
                                const isZeroish = v === fmtMoney(0) || v === "0" || v === "0.00";
                                let textClass = "";
                                let cellBg: string | undefined;
                                let cellBorderLeft: string | undefined;
                                if (isCarryRow) {
                                  textClass = "text-emerald-700 italic";
                                  cellBg = "#ecfdf5";
                                  cellBorderLeft = gcIdx === 0 ? "4px solid #34d399" : undefined;
                                } else if (pay.isExtraPenalty) {
                                  // Pattern B: รายการค่าปรับเพิ่มเติม (pt.amount=0 แต่มี penalty)
                                  textClass = isZeroish ? "text-amber-300 italic" : "text-amber-700";
                                  cellBg = "#fffbeb";
                                  cellBorderLeft = gcIdx === 0 ? "4px solid #f59e0b" : undefined;
                                } else if (isCloseCell) {
                                  textClass = isZeroish ? "text-rose-300 italic" : "text-rose-700";
                                  cellBg = "#fff1f2";
                                  cellBorderLeft = gcIdx === 0 ? "4px solid #fb7185" : undefined;
                                } else if (!isZeroish) {
                                  if (gc.key === "penalty" && (pay.penalty ?? 0) > 0) textClass = "text-red-600";
                                  else if (gc.key === "unlockFee" && (pay.unlockFee ?? 0) > 0) textClass = "text-blue-500";
                                  else if (gc.key === "discount" && (pay.discount ?? 0) > 0) textClass = "text-teal-600";
                                  else if (gc.key === "overpaid" && (pay.overpaid ?? 0) > 0) textClass = "text-emerald-600 font-bold";
                                  else if (gc.key === "badDebt" && (pay.badDebt ?? 0) > 0) textClass = "text-red-700 font-bold";
                                  else if (gc.key === "total") textClass = "font-bold";
                                } else {
                                  textClass = "text-gray-400 italic";
                                }
                                return (
                                  <div
                                    key={`cd-${vr.index}-${li}-${gc.key}`}
                                    className={`px-2 truncate tabular-nums ${textClass}`}
                                    style={{
                                      width: gc.width,
                                      height: SUB_ROW_HEIGHT,
                                      lineHeight: `${SUB_ROW_HEIGHT - 8}px`,
                                      textAlign: (gc as any).align === "right" ? "right" : "left",
                                      background: cellBg,
                                      borderLeft: cellBorderLeft,
                                    }}
                                    title={
                                      gc.key === "badDebt" && pay.isBadDebtRow && pay.badDebtNote
                                        ? pay.badDebtNote
                                        : (pay.remark ?? pay.receiptNo ?? undefined)
                                    }
                                  >
                                    {v}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      ) : Array.from({ length: maxPeriods }, (_, i) => {
                        const periodNo = i + 1;
                        if (tab === "target") {
                          const inst = r.installments[i];
                          const closed = !!inst?.isClosed;
                          // ใช้ isSuspended จาก server โดยตรง เหมือนระงับสัญญา
                          // server คำนวณ suspendedFromPeriod = lastNormalPeriod + 1 ถูกต้องสำหรับทุกสถานะ
                          let suspended = !!inst?.isSuspended;
                          const suspendLabel = inst?.suspendLabel ?? "ยกเลิกสัญญา";
                          // Grey-out applies to both closed AND suspended cells.
                          const dimmed = closed || suspended;
                          // Phase 93: pre-compute isFuturePeriod+isPaid before cell value block
                          // Snapshot mode: ใช้ cutoffDate ของ snapshot | Live mode: ใช้ debtSetCutoffMode
                          const _nowPre = new Date();
                          const _cutoffStrPre = targetViewMode === "snapshot" && (selectedSnapshotMeta as any)?.cutoffDate
                            ? String((selectedSnapshotMeta as any).cutoffDate).slice(0, 10)
                            : debtSetCutoffMode === "end_of_month"
                              ? (() => { const d = new Date(_nowPre.getFullYear(), _nowPre.getMonth() + 1, 0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })()
                              : _nowPre.toISOString().slice(0, 10);
                          const _isFuturePeriodPre = !dimmed && !!inst?.dueDate && inst.dueDate > _cutoffStrPre;
                          const _isPaidPre = !dimmed && !!inst?.isPaid;
                          // Phase 23: cell-level masking for dueDateFilter and dueDateExact
                          // If a filter is active and this period's dueDate doesn't match,
                          // render the cell as "-" (masked) instead of actual values.
                          const dueDateMonthMasked =
                            dueDateFilter.size > 0 &&
                            !(inst?.dueDate && dueDateFilter.has(inst.dueDate.slice(0, 7)));
                          const dueDateExactMasked =
                            !!dueDateExact &&
                            inst?.dueDate?.slice(0, 10) !== dueDateExact;
                          // ตั้งเป้า masking: ซ่อน installment ที่เป็น dimmed/isPaid/isFuturePeriod/advance
                          const debtSetMasked = debtSetMode && tab === "target" && (
                            dimmed || // isClosed / isSuspended
                            _isPaidPre || // ชำระครบแล้ว (เขียว)
                            _isFuturePeriodPre // ยังไม่ถึงดิว (เทา/ฟ้า-อนาคต)
                          );
                          const isCellMasked = dueDateMonthMasked || dueDateExactMasked || debtSetMasked;
                          return groupCols.map((gc) => {
                            let v: any = "";
                            let annotation: string | null = null;
                            let annotationClass = "";
                            // Phase 23: if cell is masked by date filter, show "-" for all columns
                            // except "period" (always show period number for orientation)
                            if (isCellMasked && gc.key !== "period") {
                              const maskedStyle: Record<string, string | number> = {
                                width: gc.width,
                                textAlign: (gc as any).align === "right" ? "right" : "left",
                                color: "#d1d5db", // gray-300
                              };
                              return (
                                <div
                                  key={`c-${vr.index}-${i}-${gc.key}`}
                                  className="px-2 py-2 border-r whitespace-nowrap"
                                  style={maskedStyle}
                                >
                                  -
                                </div>
                              );
                            }
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
                                  // Phase 9AJ: always build displayAmount from components
                                  // to ensure penalty/unlockFee from arrears pass are included.
                                  // inst.amount may not reflect accumulated penalty (API value).
                                  const netAmt = inst.netAmount ?? (inst.principal + inst.interest + inst.fee);
                                  const penaltyAmt = principalOnly ? 0 : (inst.penalty ?? 0);
                                  const unlockAmt = principalOnly ? 0 : (inst.unlockFee ?? 0);
                                  const displayAmount = netAmt + penaltyAmt + unlockAmt;
                                  v = fmtMoney(displayAmount);
                                  // Phase 27 fix: ตรวจสอบ overpaidApplied > 0 เพียงอย่างเดียว
                                  // เงื่อนไขเดิม (baselineAmount > amount) ไม่ทำงานเมื่อ penalty ถูกบวกเข้า amount
                                  // ทำให้ amount = baseline แม้จะมีการหักยอดเกินแล้ว
                                  if (inst.overpaidApplied > 0.009) {
                                    annotation = `(-หักชำระเกิน: ${fmtMoney(inst.overpaidApplied)})`;
                                    annotationClass = "text-emerald-600 font-semibold";
                                  }
                                }
                              }
                            }
                            // Phase 93: งวดที่ชำระล่วงหน้าครบแล้ว (isFuturePeriod + isPaid) → แสดง 0.00 ทุกคอลัมน์
                            // เพราะถูกหักออกจากการตั้งเป้าแล้ว (ไม่ใช่ dimmed เพราะยังต้องแสดงวันที่)
                            if (_isFuturePeriodPre && _isPaidPre && gc.key !== "period" && gc.key !== "dueDate") {
                              v = "0.00";
                              annotation = null;
                            }
                            const isArrears = !dimmed && !!inst?.isArrears;
                            // Phase 53/66: ซ่อน BG สีฟ้าสำหรับสัญญาสถานะ ระงับสัญญา / สิ้นสุดสัญญา / ขายเครื่อง / หนี้เสีย
                            // หมายเหตุ: หนี้เสีย ต้องไม่มี BG สีฟ้าที่งวดปัจจุบัน (รูปที่ 2)
                            const isSpecialContractStatus = r.debtStatus === 'ระงับสัญญา' || r.debtStatus === 'สิ้นสุดสัญญา' || r.debtStatus === 'ขายเครื่อง' || r.debtStatus === 'หนี้เสีย';
                            const isCurrentPeriod = !dimmed && !isSpecialContractStatus && !!inst?.isCurrentPeriod;
                            // Phase 9AI: future period = dueDate > today (not closed/suspended)
                            const todayStr = new Date().toISOString().slice(0, 10);
                            // Snapshot mode: ใช้ cutoffDate ของ snapshot | Live mode: ใช้ debtSetCutoffMode
                            const _nowCell = new Date();
                            const _cutoffStrCell = targetViewMode === "snapshot" && (selectedSnapshotMeta as any)?.cutoffDate
                              ? String((selectedSnapshotMeta as any).cutoffDate).slice(0, 10)
                              : debtSetCutoffMode === "end_of_month"
                                ? (() => { const d = new Date(_nowCell.getFullYear(), _nowCell.getMonth() + 1, 0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })()
                                : _nowCell.toISOString().slice(0, 10);
                            const isFuturePeriod = !dimmed && !isArrears && !isCurrentPeriod &&
                              !!inst?.dueDate && inst.dueDate > _cutoffStrCell;
                            // Phase 85: isPaid = ชำระครบแล้ว (ใช้ backend isPaid flag)
                            const isPaid = !dimmed && !!inst?.isPaid;
                            // Phase 85: isPartialPaid = จ่ายบางส่วน (paid > 0 แต่ยังไม่ครบ)
                            const paidAmt = inst?.paid ?? 0;
                            const amtForCheck = inst?.amount ?? 0;
                            const isPartialPaid = !dimmed && !isPaid && paidAmt > 0.009 && amtForCheck > 0.009 && paidAmt < amtForCheck - 0.5;
                            const baseStyle: Record<string, string | number> = {
                              width: gc.width,
                              textAlign:
                                (gc as any).align === "right"
                                  ? "right"
                                  : "left",
                            };
                            // Phase 92: Color priority (top = highest priority)
                            // 1. dimmed (isClosed / isSuspended) → เทา + ตัวเอียง
                            // 2. isSpecialContractStatus + isPartialPaid → ส้มเสมอ (ไม่สนใจ dueDate)
                            // 3. isCurrentPeriod + isPartialPaid → BG ฟ้า (sky-50) + ส้ม (เสมอ แม้ isArrears=true)
                            // 4. isCurrentPeriod + isPaid → BG ฟ้า (sky-50) + เขียว
                            // 5. isCurrentPeriod + isArrears (ค้างชำระ ยังไม่จ่าย) → BG ฟ้า (sky-50) + ส้ม
                            // 6. isArrears (ไม่ใช่ isCurrentPeriod) → ส้มเท่านั้น (ไม่มี BG)
                            // 7. isFuturePeriod + isPaid → ฟ้าตัวตรง
                            // 8. isFuturePeriod + isPartialPaid → ฟ้าตัวเอียง (สัญญาปกติเท่านั้น)
                            // 9. isFuturePeriod (paid=0) → เทา
                            // 10. isPaid (งวดก่อนหน้า ชำระครบ) → เขียว
                            // 11. isPartialPaid (งวดก่อนหน้า บางส่วน) → ส้ม
                            // 12. isCurrentPeriod (paid=0) → sky-50 bg + ดำ
                            // 13. งวดก่อนหน้า (paid=0, overdue) → ส้ม
                            if (dimmed) {
                              baseStyle.background = "#f3f4f6"; // gray-100
                              baseStyle.color = "#9ca3af"; // gray-400
                              baseStyle.fontStyle = "italic";
                            } else if (isSpecialContractStatus && isPartialPaid) {
                              // Phase 92: งวดสุดท้ายที่ชำระไม่ครบใน special status → ส้มเสมอ
                              // (ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย / ขายเครื่อง)
                              // ไม่สนใจว่า dueDate ผ่านไปแล้วหรือยัง
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isCurrentPeriod && isPartialPaid) {
                              // งวดปัจจุบัน + ชำระบางส่วน: BG ฟ้า + ส้ม (เสมอ แม้ isArrears=true)
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isCurrentPeriod && isPaid) {
                              // งวดปัจจุบัน + ชำระครบ: BG ฟ้า + เขียว
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#15803d"; // green-700
                            } else if (isCurrentPeriod && isArrears) {
                              // งวดปัจจุบัน + ค้างชำระ (ยังไม่จ่าย): BG ฟ้า + ส้ม (รูปที่ 1)
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isArrears) {
                              // Arrears carry (ไม่ใช่ currentPeriod): สีส้ม orange เท่านั้น (ไม่มี BG, ไม่หนา)
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isFuturePeriod && isPaid) {
                              // งวดอนาคตที่ชำระครบแล้ว: ฟ้าตัวตรง
                              baseStyle.color = "#0369a1"; // sky-700
                            } else if (isFuturePeriod && isPartialPaid) {
                              // งวดอนาคตที่จ่ายบางส่วน: ฟ้าตัวเอียง
                              baseStyle.color = "#0369a1"; // sky-700
                              baseStyle.fontStyle = "italic";
                            } else if (isFuturePeriod) {
                              // งวดอนาคตที่ยังไม่จ่าย: เทา
                              baseStyle.color = "#9ca3af"; // gray-400
                            } else if (isPaid) {
                              // งวดก่อนหน้าที่ชำระครบแล้ว: เขียว
                              baseStyle.color = "#15803d"; // green-700
                            } else if (isPartialPaid) {
                              // งวดก่อนหน้าที่จ่ายบางส่วน: ส้ม
                              baseStyle.color = "#c2410c"; // orange-700
                            } else if (isCurrentPeriod) {
                              // งวดปัจจุบัน ยังไม่จ่าย: sky-50 bg + ดำ
                              baseStyle.background = "#f0f9ff"; // sky-50
                              baseStyle.color = "#111827"; // gray-900 (ดำ)
                            } else {
                              // งวดก่อนหน้า ยังไม่จ่าย (overdue): ส้ม (ถือว่าค้างชำระ)
                              baseStyle.color = "#c2410c"; // orange-700
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

        ))}
        {/* Phase 125: Pagination removed — ใช้ Virtual Scroll กับ filteredRows ทั้งหมด */}
      </div>

      {/* ── DebtSet Cutoff Mode Dialog — ขึ้นตอนกด Toggle ตั้งเป้า ────────────────────────────── */}
      <Dialog open={showDebtSetDialog} onOpenChange={setShowDebtSetDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="w-4 h-4 text-orange-600" />
              ตั้งเป้า — เลือกช่วงข้อมูล
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm text-gray-600">เลือกช่วงข้อมูลที่ต้องการแสดง:</p>
            <div className="space-y-2">
              <button
                type="button"
                className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                  pendingDebtSetCutoffMode === "today"
                    ? "border-violet-500 bg-violet-50"
                    : "border-gray-200 hover:border-violet-300 hover:bg-violet-50/50"
                }`}
                onClick={() => setPendingDebtSetCutoffMode("today")}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    pendingDebtSetCutoffMode === "today" ? "border-violet-500 bg-violet-500" : "border-gray-400"
                  }`}>
                    {pendingDebtSetCutoffMode === "today" && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-800">ณ วันที่ปัจจุบัน</div>
                    <div className="text-xs text-gray-500">นับงวดถึงวันนี้เท่านั้น (งวดที่ยังไม่ถึง due ถูกตัดออก)</div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                  pendingDebtSetCutoffMode === "end_of_month"
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-200 hover:border-blue-300 hover:bg-blue-50/50"
                }`}
                onClick={() => setPendingDebtSetCutoffMode("end_of_month")}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    pendingDebtSetCutoffMode === "end_of_month" ? "border-blue-500 bg-blue-500" : "border-gray-400"
                  }`}>
                    {pendingDebtSetCutoffMode === "end_of_month" && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-800">ณ เดือนปัจจุบัน</div>
                    <div className="text-xs text-gray-500">นับงวดทั้งเดือน รวมที่ยังไม่ถึง due</div>
                  </div>
                </div>
              </button>
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowDebtSetDialog(false)}
              >
                ยกเลิก
              </Button>
              <Button
                className={`flex-1 text-white ${
                  pendingDebtSetCutoffMode === "end_of_month"
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-orange-500 hover:bg-orange-600"
                }`}
                onClick={() => {
                  setDebtSetCutoffMode(pendingDebtSetCutoffMode);
                  setDebtSetMode(true);
                  setShowDebtSetDialog(false);
                }}
              >
                <Target className="w-3.5 h-3.5 mr-1.5" />
                ตั้งเป้า
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Color Legend Dialog */}
      <Dialog open={showColorLegend} onOpenChange={setShowColorLegend}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Info className="w-4 h-4 text-blue-500" />
              {tab === "target" ? "คำอธิบายสีตัวเลข — เป้าเก็บหนี้" : "คำอธิบายสีตัวเลข — ยอดเก็บหนี้"}
            </DialogTitle>
          </DialogHeader>

          {tab === "target" ? (
            <div className="space-y-4 text-sm">
              <p className="text-gray-500 text-xs">สีของตัวเลขแต่ละงวดบอกสถานะการชำระเงินของงวดนั้นๆ</p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="text-left p-2 border border-gray-200 font-semibold">สี</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ความหมาย</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ตัวอย่าง</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-green-600 inline-block"></span>
                        <span className="text-green-700 font-semibold">เขียว</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ชำระครบแล้ว</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ลูกค้าจ่ายเงินครบถ้วนแล้ว</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-orange-500 inline-block"></span>
                        <span className="text-orange-700 font-semibold">ส้ม</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ค้างชำระ / เกินกำหนด</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ผ่านวันครบกำหนดแล้วแต่ยังไม่ได้ชำระ</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-900 inline-block"></span>
                        <span className="text-gray-900 font-semibold">ดำ</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ถึงกำหนดชำระวันนี้</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดปัจจุบันที่ยังไม่ได้ชำระ (ตรงกำหนดวันนี้)</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-sky-500 inline-block"></span>
                        <span className="text-sky-700 font-semibold">ฟ้า</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ชำระล่วงหน้า</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ยังไม่ถึงกำหนดแต่ชำระเงินมาแล้ว</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-400 inline-block"></span>
                        <span className="text-gray-500 font-semibold">เทา</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยังไม่ถึงกำหนดชำระ</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดในอนาคตที่ยังไม่ถึงวันกำหนดชำระ</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-300 inline-block border border-gray-400"></span>
                        <span className="text-gray-400 font-semibold italic">เทาอ่อน (ตัวเอียง)</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ปิดค่างวด / ระงับสัญญา</td>
                    <td className="p-2 border border-gray-200 text-gray-500">งวดที่ถูกปิดค่างวดหรืออยู่ในสัญญาที่ระงับ/สิ้นสุด</td>
                  </tr>
                </tbody>
              </table>

              <div className="mt-3">
                <p className="text-xs font-semibold text-gray-600 mb-2">พื้นหลังแถว (Row Background)</p>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left p-2 border border-gray-200 font-semibold">สีพื้นหลัง</th>
                      <th className="text-left p-2 border border-gray-200 font-semibold">ความหมาย</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-2 border border-gray-200">
                        <span className="inline-block w-16 h-5 rounded" style={{background: '#f0f9ff', border: '1px solid #bae6fd'}}></span>
                        <span className="ml-2 text-sky-700">ฟ้าอ่อน</span>
                      </td>
                      <td className="p-2 border border-gray-200">งวดปัจจุบันที่ต้องชำระ (เดือนนี้)</td>
                    </tr>
                    <tr className="bg-gray-50">
                      <td className="p-2 border border-gray-200">
                        <span className="inline-block w-16 h-5 rounded" style={{background: '#fef3c7', border: '1px solid #fcd34d'}}></span>
                        <span className="ml-2 text-amber-700">เหลืองอ่อน</span>
                      </td>
                      <td className="p-2 border border-gray-200">มีค่าปรับ/ค่าปลดล็อกค้างชำระสะสมจากงวดก่อนหน้า</td>
                    </tr>
                    <tr>
                      <td className="p-2 border border-gray-200">
                        <span className="inline-block w-16 h-5 rounded" style={{background: '#f3f4f6', border: '1px solid #d1d5db'}}></span>
                        <span className="ml-2 text-gray-500">เทาอ่อน</span>
                      </td>
                      <td className="p-2 border border-gray-200">งวดที่ปิดค่างวดแล้ว / สัญญาระงับ</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <p className="text-gray-500 text-xs">สีของตัวเลขแต่ละรายการชำระเงินบอกสถานะของรายการนั้นๆ</p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="text-left p-2 border border-gray-200 font-semibold">สี</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ความหมาย</th>
                    <th className="text-left p-2 border border-gray-200 font-semibold">ตัวอย่าง</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-gray-900 inline-block"></span>
                        <span className="text-gray-900 font-semibold">ดำ</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดชำระปกติ</td>
                    <td className="p-2 border border-gray-200 text-gray-500">รายการชำระเงินทั่วไป</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-red-500 inline-block"></span>
                        <span className="text-red-600 font-semibold">แดง</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดหนี้เสีย</td>
                    <td className="p-2 border border-gray-200 text-gray-500">รายการที่ถูกตัดสินเป็นหนี้เสีย</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-orange-500 inline-block"></span>
                        <span className="text-orange-600 font-semibold">ส้ม</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดค่าปรับ / ค่าปลดล็อก</td>
                    <td className="p-2 border border-gray-200 text-gray-500">รายการชำระที่มีค่าปรับหรือค่าปลดล็อก</td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-blue-500 inline-block"></span>
                        <span className="text-blue-600 font-semibold">น้ำเงิน</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดชำระล่วงหน้า / ยอดเกิน</td>
                    <td className="p-2 border border-gray-200 text-gray-500">ชำระเกินยอดที่ต้องชำระในงวดนั้น</td>
                  </tr>
                  <tr>
                    <td className="p-2 border border-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-green-500 inline-block"></span>
                        <span className="text-green-600 font-semibold">เขียว</span>
                      </span>
                    </td>
                    <td className="p-2 border border-gray-200">ยอดส่วนลด</td>
                    <td className="p-2 border border-gray-200 text-gray-500">ยอดที่ได้รับส่วนลดจากราคาทุน</td>
                  </tr>
                </tbody>
              </table>

              <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-xs font-semibold text-blue-700 mb-1">หมายเหตุ</p>
                <ul className="text-xs text-blue-600 space-y-1 list-disc list-inside">
                  <li>รายการหนึ่งสัญญาอาจมีหลายสีในครั้งเดียวกัน เช่น ชำระปกติ + ค่าปรับ</li>
                  <li>ตัวเลขสีแดงคือยอดหนี้เสียที่ถูกตัดสินและไม่ต้องชำระแล้ว</li>
                </ul>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* ── Daily Breakdown Popup ────────────────────────────────────────────── */}
      {/* แสดงยอดเป้าเก็บหนี้และยอดเก็บหนี้จริง แยกตามวันที่ 1-สิ้นเดือน */}
      <Dialog open={!!dailyBreakdownMonth} onOpenChange={(open) => { if (!open) { setDailyBreakdownMonth(null); setDailyBreakdownStatuses([]); setDailyStatusDropdownOpen(false); } }}>
        <DialogContent className="max-w-lg w-full p-0 overflow-hidden rounded-2xl">
          <DialogHeader className="px-5 pt-4 pb-3 bg-amber-50 border-b border-amber-200">
            {/* แถวเดียว: title ซ้าย | filter สถานะหนี้ | Excel | X ขวาสุด */}
            <div className="flex items-center gap-2 pr-8">
              <DialogTitle className="text-sm font-bold text-amber-900 flex items-center gap-1.5 shrink-0">
                <BarChart2 className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="whitespace-nowrap">
                  {
                    (() => {
                      if (!dailyBreakdownMonth) return "ยอดรายวัน";
                      const [yr, mo] = dailyBreakdownMonth.split("-").map(Number);
                      const TM = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
                      const label = (mo >= 1 && mo <= 12) ? (TM[mo - 1] + " " + yr) : dailyBreakdownMonth;
                      return `ยอดรายวัน — ${label}`;
                    })()
                  }
                </span>
              </DialogTitle>
              {/* filter สถานะหนี้ — อยู่กลางระหว่าง title และ Excel */}
              <div className="relative flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => setDailyStatusDropdownOpen(prev => !prev)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-50 transition-colors w-full"
                >
                  <span className="flex-1 text-left truncate">
                    {dailyBreakdownStatuses.length === 0
                      ? "ทุกสถานะ"
                      : dailyBreakdownStatuses.length === 1
                      ? dailyBreakdownStatuses[0]
                      : `${dailyBreakdownStatuses.length} สถานะ`
                    }
                  </span>
                  <svg className={`w-3 h-3 text-amber-600 shrink-0 transition-transform ${dailyStatusDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                {dailyStatusDropdownOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-amber-200 rounded-xl shadow-lg py-1 min-w-[160px] max-h-80 overflow-y-auto">
                    <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-amber-50 cursor-pointer text-xs text-amber-900 font-semibold">
                      <input type="checkbox" checked={dailyBreakdownStatuses.length === 0} onChange={() => setDailyBreakdownStatuses([])} className="accent-amber-500" />
                      ทุกสถานะหนี้
                    </label>
                    <div className="border-t border-amber-100 my-0.5" />
                    {DEBT_STATUS_OPTIONS.map(status => (
                      <label key={status} className="flex items-center gap-2 px-3 py-1.5 hover:bg-amber-50 cursor-pointer text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={dailyBreakdownStatuses.includes(status)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setDailyBreakdownStatuses(prev => [...prev, status]);
                            } else {
                              setDailyBreakdownStatuses(prev => prev.filter(s => s !== status));
                            }
                          }}
                          className="accent-amber-500"
                        />
                        {status}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {/* ปุ่ม Export Excel — อยู่ซ้ายของปุ่ม X */}
              {dailyBreakdownQuery.data && (dailyBreakdownQuery.data as Array<unknown>).length > 0 && (
                <button
                  type="button"
                  title="Export Excel"
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors"
                  onClick={() => {
                    // คำนวณ displayTarget client-side เหมือนกับ render ตาราง
                    type DailyRowExport = { date: string; targetAmount: number; targetByRange: Record<string, number>; collectedAmount: number; isOverdue?: boolean };
                    const rawRows = (dailyBreakdownQuery.data ?? []) as DailyRowExport[];
                    const isFilteringExport = dailyBreakdownStatuses.length > 0;
                    const rows = rawRows.map(r => {
                      const displayTarget = isFilteringExport
                        ? dailyBreakdownStatuses.reduce((s, rng) => s + (r.targetByRange[rng] ?? 0), 0)
                        : r.targetAmount;
                      const pct = (!r.isOverdue && displayTarget > 0) ? (r.collectedAmount / displayTarget) * 100 : 0;
                      return { ...r, displayTarget, displayPct: pct };
                    });
                    const TM2 = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
                    const [yr2, mo2] = (dailyBreakdownMonth ?? "").split("-").map(Number);
                    const monthLabel = (mo2 >= 1 && mo2 <= 12) ? (TM2[mo2 - 1] + " " + yr2) : (dailyBreakdownMonth ?? "");
                    const totalTarget    = rows.reduce((s, r) => s + r.displayTarget, 0);
                    const totalCollected = rows.filter(r => !r.isOverdue).reduce((s, r) => s + r.collectedAmount, 0);
                    const totalPct       = totalTarget > 0 ? (totalCollected / totalTarget) * 100 : 0;
                    // สร้าง worksheet data
                    const wsData: (string | number)[][] = [
                      [`ยอดรายวัน — ${monthLabel}`],
                      ["วันที่", "ตั้งเป้า", "ยอดเก็บหนี้", "% เก็บหนี้"],
                      ...rows.map(r => {
                        const dayLabel = r.isOverdue ? "ยกมา" : (r.date ? parseInt(r.date.split("-")[2] ?? "0", 10) : 0);
                        return [
                          dayLabel,
                          r.displayTarget > 0 ? r.displayTarget : 0,
                          r.isOverdue ? "" : (r.collectedAmount > 0 ? r.collectedAmount : 0),
                          r.isOverdue ? "" : (r.displayTarget > 0 ? parseFloat(r.displayPct.toFixed(2)) : 0),
                        ];
                      }),
                      ["รวม", totalTarget, totalCollected, totalTarget > 0 ? parseFloat(totalPct.toFixed(2)) : 0],
                    ];
                    const wb = XLSX.utils.book_new();
                    const ws = XLSX.utils.aoa_to_sheet(wsData);
                    // กำหนด column widths
                    ws["!cols"] = [{ wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
                    XLSX.utils.book_append_sheet(wb, ws, monthLabel);
                    XLSX.writeFile(wb, `daily_breakdown_${dailyBreakdownMonth ?? ""}.xlsx`);
                  }}
                >
                  <Download className="w-3 h-3" />
                  Excel
                </button>
              )}
            </div>
          </DialogHeader>
          <div className="overflow-y-auto relative" style={{ maxHeight: 'calc(80vh - 120px)' }}>
            {(() => {
              // ตรวจสอบ frozen dailyBreakdown จาก monthly_collection_snapshot
              const frozenDaily = dailyBreakdownMonth ? getFrozenDailyBreakdown(dailyBreakdownMonth) : null;
              // ถ้ามี frozen data → ใช้ทันที (isLoading = false)
              const isLoadingDaily = frozenDaily ? false : dailyBreakdownQuery.isLoading;
              const isErrorDaily = frozenDaily ? false : dailyBreakdownQuery.isError;
              return isLoadingDaily ? (
              <div className="flex items-center justify-center py-10 gap-2 text-amber-600">
                <Spinner className="w-5 h-5" />
                <span className="text-sm">กำลังโหลด...</span>
              </div>
            ) : isErrorDaily ? (
              <div className="px-5 py-6 text-center text-sm text-red-500">โหลดข้อมูลไม่สำเร็จ</div>
            ) : (
              (() => {
                // Type ใหม่ที่มี targetByRange สำหรับ client-side filter
                type DailyRow = { date: string; targetAmount: number; targetByRange: Record<string, number>; collectedAmount: number; percentage: number; isOverdue?: boolean };
                // ใช้ frozen data ถ้ามี ไม่งั้น fallback ไป real-time query
                const rawRows = (frozenDaily ?? dailyBreakdownQuery.data ?? []) as DailyRow[];

                // Client-side filter: คำนวณ displayTargetAmount ตาม dailyBreakdownStatuses
                // ถ้าไม่ได้ filter (ทุกสถานะ) → ใช้ targetAmount จาก server (ซึ่งตรงกับ mcs target แล้ว)
                const isFilteringStatuses = dailyBreakdownStatuses.length > 0;
                const rows = rawRows.map(r => {
                  let displayTarget: number;
                  if (isFilteringStatuses) {
                    // SUM เฉพาะ range ที่เลือก
                    displayTarget = dailyBreakdownStatuses.reduce((s, rng) => s + (r.targetByRange[rng] ?? 0), 0);
                  } else {
                    // ทุกสถานะ → ใช้ targetAmount จาก server (ตรงกับ mcs target)
                    displayTarget = r.targetAmount;
                  }
                  // แถว overdue ไม่มี collected/pct
                  const pct = (!r.isOverdue && displayTarget > 0) ? (r.collectedAmount / displayTarget) * 100 : 0;
                  return { ...r, displayTarget, displayPct: pct };
                });

                // คำนวณยอดรวม — % รวมต้องเทียบกับยอดรวมทั้งหมด (รวม overdue)
                const totalTarget    = rows.reduce((s, r) => s + r.displayTarget, 0);
                const totalCollected = rows.filter(r => !r.isOverdue).reduce((s, r) => s + r.collectedAmount, 0);
                const totalPct       = totalTarget > 0 ? (totalCollected / totalTarget) * 100 : 0;
                const totalPctColor  = totalPct >= 100 ? "text-emerald-600 font-bold" : totalPct >= 80 ? "text-yellow-600 font-semibold" : "text-red-600 font-semibold";
                return (
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-amber-100 text-amber-900 text-[12px] font-semibold">
                        <th className="px-3 py-2 text-left border-b border-amber-200 w-16">วันที่</th>
                        <th className="px-3 py-2 text-right border-b border-amber-200">ตั้งเป้า</th>
                        <th className="px-3 py-2 text-right border-b border-amber-200">ยอดเก็บหนี้</th>
                        <th className="px-3 py-2 text-right border-b border-amber-200">% เก็บหนี้</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, idx) => {
                        const isOvd = Boolean(row.isOverdue);
                        const pctColor = row.displayPct >= 100
                          ? "text-emerald-600 font-bold"
                          : row.displayPct >= 80
                          ? "text-yellow-600 font-semibold"
                          : row.displayTarget > 0
                          ? "text-red-500"
                          : "text-gray-300";
                        // แถว overdue แสดง label "ยกมา" แทนวันที่
                        const dayLabel = isOvd
                          ? <span className="text-[11px] text-gray-500 font-normal">ยกมา</span>
                          : (row.date ? parseInt(row.date.split("-")[2] ?? "0", 10) : idx);
                        return (
                          <tr
                            key={row.date}
                            className={`border-b border-gray-100 ${
                              isOvd
                                ? "bg-gray-100"
                                : idx % 2 === 0 ? "bg-white" : "bg-gray-50"
                            } hover:bg-amber-50 transition-colors`}
                          >
                            <td className="px-3 py-2 text-gray-700 tabular-nums font-medium text-[13px]">{dayLabel}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-700 text-[13px]">
                              {row.displayTarget > 0
                                ? row.displayTarget.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                : <span className="text-gray-300">—</span>}
                            </td>
                            {/* แถว overdue: ช่องยอดเก็บและ % ใช้ bg ทึบ ไม่มีข้อความ */}
                            {isOvd ? (
                              <>
                                <td className="px-3 py-2 bg-gray-300" />
                                <td className="px-3 py-2 bg-gray-300" />
                              </>
                            ) : (
                              <>
                                <td className="px-3 py-2 text-right tabular-nums text-gray-700 text-[13px]">
                                  {row.collectedAmount > 0
                                    ? row.collectedAmount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`px-3 py-2 text-right tabular-nums text-[13px] ${pctColor}`}>
                                  {row.displayTarget > 0 ? `${row.displayPct.toFixed(1)}%` : <span className="text-gray-300">—</span>}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                    {/* แถวรวม — sticky ค้างไว้ที่ด้านล่างตลอด */}
                    <tfoot className="sticky bottom-0 z-10">
                      <tr className="bg-amber-100 border-t-2 border-amber-300 font-bold text-[13px]">
                        <td className="px-3 py-2.5 text-amber-900">รวม</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-amber-900">
                          {totalTarget > 0
                            ? totalTarget.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-amber-900">
                          {totalCollected > 0
                            ? totalCollected.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${totalPctColor}`}>
                          {totalTarget > 0 ? `${totalPct.toFixed(1)}%` : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                );
              })()
            );
          })()}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}


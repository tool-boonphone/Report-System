/**
 * Income.tsx — หน้ารายรับ (บัญชี > รายรับ)
 *
 * Tab 3 แถบ:
 *  1. สรุปรายปี   — ตารางสรุปยอดแยกตามปี
 *  2. สรุปรายเดือน — ตารางสรุปยอดแยกตามเดือน-ปี
 *  3. รายการทั้งหมด — รายการรับชำระทั้งหมด (หน้าเดิม)
 *
 * Switch mode (รายการทั้งหมด):
 *  - รายการตามการบันทึก (default): แสดงทุก payment row ตามที่ดึงมา ไม่ group
 *  - รายการตามสลิป: group รายการที่ชำระวันเดียวกัน + คนเดียวกัน + ประเภทเดียวกัน
 *    เป็น 1 row (เฉพาะ ปิดยอด และ ขายเครื่อง)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIncomeCache } from "@/contexts/IncomeCacheContext";
import type { SectionKey } from "@shared/const";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import {
  CalendarDays, ChevronDown, ChevronUp, ChevronsUpDown,
  Download, Eye, EyeOff, Search, User, X,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Pagination, PaginationContent, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";

// ─── Types ────────────────────────────────────────────────────────────────────
type IncomeType = "ค่างวด" | "ขายเครื่อง" | "ปิดยอด";
type DateField = "paidAt" | "updatedAt";
type SortKey = "no" | "paidAt" | "incomeType" | "contractNo" | "amount" | "updatedBy" | "updatedAt";
type SortDir = "asc" | "desc";
type ActiveTab = "yearly" | "monthly" | "all";
/** mode สำหรับแถบรายการทั้งหมด */
type ListMode = "detail" | "slip";

const ALL_INCOME_TYPES: IncomeType[] = ["ค่างวด", "ปิดยอด", "ขายเครื่อง"];
/** ประเภทที่ต้อง group เมื่อ mode = slip */
const GROUPABLE_TYPES: Set<IncomeType> = new Set<IncomeType>(["ปิดยอด", "ขายเครื่อง"]);

const TYPE_COLORS: Record<IncomeType, { bg: string; text: string; dot: string }> = {
  "ค่างวด":    { bg: "bg-blue-50",   text: "text-blue-700",   dot: "bg-blue-500" },
  "ขายเครื่อง": { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500" },
  "ปิดยอด":    { bg: "bg-purple-50", text: "text-purple-700", dot: "bg-purple-500" },
};
const BADGE_COLORS: Record<IncomeType, string> = {
  "ค่างวด":    "bg-blue-600",
  "ขายเครื่อง": "bg-orange-500",
  "ปิดยอด":    "bg-purple-600",
};

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
  const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const mIdx = parseInt(m, 10) - 1;
  const thYear = parseInt(y, 10) + 543;
  return `${monthNames[mIdx] ?? m} ${thYear}`;
}

const MONTH_NAMES = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

// ─── Type สำหรับ row ที่ดึงมาจาก API ──────────────────────────────────────────
type IncomeRow = {
  paidAt: string | null;
  /** incomeType = classified (ค่างวด / ปิดยอด / ขายเครื่อง) ใช้ใน slip mode */
  incomeType: string;
  /** originalIncomeType = ตาม API จริง (ค่างวด / ปิดยอด เท่านั้น) ใช้ใน detail mode */
  originalIncomeType?: string;
  /** receiptNo = รหัสรายการ เช่น TXRT1225-PTE010-19331-01-1 หรือ TXRTC1225-PTE010-19331-01 */
  receiptNo?: string | null;
  /** contractStatus = สถานะสัญญา เช่น 'ปกติ', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ระงับสัญญา' */
  contractStatus?: string | null;
  contractNo: string;
  customerName?: string | null;
  amount: number;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

/**
 * groupRowsBySlip — mode รายการตามบิล (slip mode)
 *
 * หลักการ:
 * - ค่างวด: ไม่ group แสดงทุก row ตรงๆ
 * - ปิดยอด: group รายการล่าสุดของสัญญาสิ้นสุดสัญญา
 *   โดยไล่จากล่าสุดต่อเนื่อง (consecutive) ที่ paidAt วันเดียวกัน
 *   + updatedBy คนเดียวกัน + updatedAt วันเดียวกัน
 *   หยุดทันทีที่อย่างใดอย่างหนึ่งไม่ตรง
 * - ขายเครื่อง: เงื่อนไขเดียวกับปิดยอด แต่สำหรับสัญญาหนี้เสีย
 *
 * ยอดรวมทั้ง 2 mode เท่ากัน (group แค่รวม amount ไม่ได้ตัดรายการออก)
 */
function groupRowsBySlip(rows: IncomeRow[]): IncomeRow[] {
  /**
   * แยกรายการตาม contractStatus
   *
   * ปิดยอด = contractStatus 'สิ้นสุดสัญญา' + receiptNo ขึ้นต้น TXRTC
   *   → group ตาม batch key: paidAt + updatedBy + updatedAt + receiptNo
   *
   * ขายเครื่อง = contractStatus 'หนี้เสีย' (ไม่สนใจ receiptNo)
   *   → แสดงเฉพาะ รายการสุดท้าย (ล่าสุด) ของแต่ละสัญญา เป็น 1 row
   *   → รายการเก่ากว่า — ใส่ตรงๆ เป็น ค่างวด
   *
   * ค่างวด = อื่นๆ ทั้งหมด (ไม่ group)
   */
  const installmentRows: IncomeRow[] = []; // ค่างวด — ไม่ group
  const closingRows: IncomeRow[] = [];     // ปิดยอด — group ตาม consecutive batch

  // สัญญาหนี้เสีย: จัดกลุ่มตามสัญญา เอาเฉพาะรายการสุดท้าย
  const badDebtContractMap = new Map<string, IncomeRow[]>();

  for (const row of rows) {
    if (row.contractStatus === "หนี้เสีย") {
      // สัญญาหนี้เสีย: เก็บทุก row ไว้ก่อน เพื่อหา row สุดท้าย
      if (!badDebtContractMap.has(row.contractNo)) badDebtContractMap.set(row.contractNo, []);
      badDebtContractMap.get(row.contractNo)!.push(row);
    } else if (
      (row.contractStatus === "สิ้นสุดสัญญา" || row.contractStatus === "สำเร็จ") &&
      (row.receiptNo ?? "").startsWith("TXRTC")
    ) {
      closingRows.push(row);
    } else {
      installmentRows.push(row);
    }
  }

  // สร้าง deviceRows: เอาเฉพาะ row สุดท้าย (id สูงสุด) ของแต่ละสัญญา
  // รายการเก่ากว่า — ใส่เป็น installmentRows (ค่างวด)
  const deviceRows: IncomeRow[] = [];
  for (const [, contractRows] of Array.from(badDebtContractMap)) {
    // เรียง id DESC เอา row สุดท้าย
    const sortedBad = [...contractRows].sort((a, b) => ((b as any).id ?? 0) - ((a as any).id ?? 0));
    const lastRow = sortedBad[0]; // row สุดท้าย
    deviceRows.push({ ...lastRow, incomeType: "ขายเครื่อง" });
    // รายการเก่ากว่า — ใส่เป็น installmentRows
    for (const row of sortedBad.slice(1)) {
      installmentRows.push({ ...row, incomeType: "ค่างวด" });
    }
  }

  /**
   * groupByBatch — group rows ตาม consecutive batch สุดท้ายของแต่ละสัญญา
   *
   * batch key = paidAt date + updatedBy + updatedAt date + receiptNo
   * เรียง id DESC, ไล่ต่อเนื่อง (consecutive) หยุดทันทีที่ไม่ตรง
   */
  function groupByBatch(typeRows: IncomeRow[], targetType: IncomeType): IncomeRow[] {
    const contractMap = new Map<string, IncomeRow[]>();
    for (const row of typeRows) {
      const key = row.contractNo;
      if (!contractMap.has(key)) contractMap.set(key, []);
      contractMap.get(key)!.push(row);
    }

    const grouped: IncomeRow[] = [];

    for (const [, contractRows] of Array.from(contractMap)) {
      // เรียงตาม id DESC (ล่าสุดก่อน)
      const sorted = [...contractRows].sort((a, b) => ((b as any).id ?? 0) - ((a as any).id ?? 0));

      // batch key จาก row แรก (ล่าสุด)
      const firstRow = sorted[0];
      const batchPaidAt = firstRow.paidAt ? firstRow.paidAt.slice(0, 10) : "";
      const batchUpdatedBy = firstRow.updatedBy ?? "";
      const batchUpdatedAtDate = firstRow.updatedAt ? firstRow.updatedAt.slice(0, 10) : "";
      const batchReceiptNo = firstRow.receiptNo ?? "";

      let batchAmount = 0;
      const batchRows: IncomeRow[] = [];
      const remainingRows: IncomeRow[] = [];
      let batchEnded = false;

      for (const row of sorted) {
        if (batchEnded) { remainingRows.push(row); continue; }

        const rowPaidAt = row.paidAt ? row.paidAt.slice(0, 10) : "";
        const rowUpdatedBy = row.updatedBy ?? "";
        const rowUpdatedAtDate = row.updatedAt ? row.updatedAt.slice(0, 10) : "";
        const rowReceiptNo = row.receiptNo ?? "";

        if (
          rowPaidAt === batchPaidAt &&
          rowUpdatedBy === batchUpdatedBy &&
          rowUpdatedAtDate === batchUpdatedAtDate &&
          rowReceiptNo === batchReceiptNo
        ) {
          batchAmount += row.amount ?? 0;
          batchRows.push(row);
        } else {
          batchEnded = true;
          remainingRows.push(row);
        }
      }

      if (batchRows.length > 0) {
        grouped.push({ ...firstRow, incomeType: targetType, amount: batchAmount });
      }
      for (const row of remainingRows) {
        grouped.push({ ...row, incomeType: targetType });
      }
    }

    return grouped;
  }

  const groupedClosing = groupByBatch(closingRows, "ปิดยอด");

  // ผสมทุกประเภทแล้ว return โดยไม่ sort ในนี้
  // (sort จะถูกทำใน displayRows ตาม sortKey + sortDir ที่ผู้ใช้เลือก)
  return [...installmentRows, ...groupedClosing, ...deviceRows];
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Income() {
  const { section } = useSection();
  const { can } = useAppAuth();
  const { setActions } = useNavActions();

  const canView = can("income", "view");
  const canExport = can("income", "export");

  // ── Active Tab ──
  const [activeTab, setActiveTab] = useState<ActiveTab>("yearly");

  // ── List mode switch ──
  const [listMode, setListMode] = useState<ListMode>("detail");

  // ── Filter state (all tab) ──
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateField, setDateField] = useState<DateField>("paidAt");
  const [activeTypes, setActiveTypes] = useState<Set<IncomeType>>(new Set(ALL_INCOME_TYPES));
  const [updatedBy, setUpdatedBy] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey>("paidAt");
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

  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, dateField, activeTypes, updatedBy, pageSize]);

  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  // ── tRPC queries ──
  const utils = trpc.useUtils();
  void utils; // ยังคงไว้สำหรับ export query

  // ── Income Cache (global pre-warm) ──
  const incomeCache = useIncomeCache();
  const cache = section ? incomeCache.getCache(section as SectionKey) : null;

  // Prefetch เมื่อ section พร้อม
  useEffect(() => {
    if (section && canView) {
      incomeCache.prefetch(section as SectionKey);
    }
  }, [section, canView, incomeCache]);

  // ── compat: rows / isLoading / error ──
  // Cache เก็บ raw rows ทั้งหมด (ไม่มี filter) — filter ที่ client ด้วย useMemo ด้านล่าง
  const rawCacheRows = (cache?.rows ?? []) as IncomeRow[];
  const isLoading = !cache || (cache.isLoading && rawCacheRows.length === 0);
  const isPartialLoading = !!(cache?.isLoading && rawCacheRows.length > 0);
  const loadedCount = cache?.loadedCount ?? 0;
  const totalFromApi = cache?.totalCount ?? 0;
  const error = cache?.error ? { message: cache.error } : null;

  // ── Client-side filter ตาม search, dateFrom, dateTo, dateField, updatedBy ──
  const rows = useMemo<IncomeRow[]>(() => {
    if (!rawCacheRows.length) return [];
    return rawCacheRows.filter((row) => {
      // filter search: receiptNo หรือ contractNo
      if (search) {
        const q = search.toLowerCase();
        const matchReceipt = (row.receiptNo ?? "").toLowerCase().includes(q);
        const matchContract = (row.contractNo ?? "").toLowerCase().includes(q);
        if (!matchReceipt && !matchContract) return false;
      }
      // filter updatedBy
      if (updatedBy && (row.updatedBy ?? "") !== updatedBy) return false;
      // filter dateFrom / dateTo
      if (dateFrom || dateTo) {
        const dateVal = dateField === "paidAt" ? row.paidAt : row.updatedAt;
        const rowDate = dateVal ? (dateVal as string).slice(0, 10) : "";
        if (dateFrom && rowDate < dateFrom) return false;
        if (dateTo && rowDate > dateTo) return false;
      }
      return true;
    });
  }, [rawCacheRows, search, updatedBy, dateFrom, dateTo, dateField]);

  const { data: updatedByList } = trpc.accounting.listIncomeUpdatedBy.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateField,
      // ไม่ส่ง incomeTypes เพื่อให้ตัวเลือกผู้ทำรายการครบเสมอ ไม่หายเมื่อปิด badge
    },
    { enabled: !!section && canView },
  );

  // exportData ใช้ rows จาก cache แทน (cache เก็บ raw rows ทั้งหมดแล้ว)

  // ── Yearly summary ──
  const yearlyYearsParam = useMemo(
    () => (yearlyYear ? [parseInt(yearlyYear, 10)] : undefined),
    [yearlyYear],
  );
  const { data: yearlyData, isLoading: yearlyLoading } = trpc.accounting.getIncomeSummaryByPeriod.useQuery(
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
  const { data: monthlyData, isLoading: monthlyLoading } = trpc.accounting.getIncomeSummaryByPeriod.useQuery(
    { section: section ?? "Boonphone", groupBy: "month", years: monthlyYearsParam, months: monthlyMonthsParam },
    { enabled: !!section && canView && activeTab === "monthly" },
  );

  const { data: summaryData } = trpc.accounting.getIncomeSummary.useQuery(
    {
      section: section ?? "Boonphone",
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateField,
      updatedBy: updatedBy || undefined,
    },
    { enabled: !!section && canView && activeTab === "all" },
  );

  /**
   * badgeSums — ยอดสรุปตาม mode
   * detail mode: ค่างวด = ค่างวด + ขายเครื่อง (เพราะ originalIncomeType ของขายเครื่อง = ค่างวด)
   * slip mode: ค่างวด / ปิดยอด / ขายเครื่อง แยกกัน
   */
  const badgeSums = useMemo<Record<IncomeType, number>>(() => {
    const rawInstallment = summaryData?.["ค่างวด"] ?? 0;
    const rawDevice = summaryData?.["ขายเครื่อง"] ?? 0;
    const rawClosing = summaryData?.["ปิดยอด"] ?? 0;
    if (listMode === "detail") {
      // detail mode: ขายเครื่อง รวมเข้าค่างวด (เพราะ originalIncomeType = ค่างวด)
      return {
        "ค่างวด": rawInstallment + rawDevice,
        "ปิดยอด": rawClosing,
        "ขายเครื่อง": 0, // ไม่แสดงใน detail mode
      };
    }
    // slip mode: แยกตาม classified type
    return {
      "ค่างวด": rawInstallment,
      "ขายเครื่อง": rawDevice,
      "ปิดยอด": rawClosing,
    };
  }, [summaryData, listMode]);

  const totalVisible = useMemo(() => {
    // detail mode: ไม่นับ ขายเครื่อง (= 0 อยู่แล้ว)
    const visibleTypes = listMode === "detail"
      ? ALL_INCOME_TYPES.filter((t) => t !== "ขายเครื่อง")
      : ALL_INCOME_TYPES;
    return visibleTypes.filter((t) => activeTypes.has(t)).reduce((s, t) => s + (badgeSums[t] ?? 0), 0);
  }, [badgeSums, activeTypes, listMode]);

  // ── Sort rows ──
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

  /**
   * displayRows — rows ที่จะแสดงในตาราง
   * mode = detail: filter ตาม originalIncomeType + activeTypes
   *   (เพราะ API filter ใช้ income_type (classified) ซึ่งอาจ mismatch กับ originalIncomeType)
   * mode = slip: group ปิดยอด/ขายเครื่อง ที่ชำระวันเดียวกัน + คนเดียวกัน แสดง incomeType (classified)
   */
  const displayRows = useMemo(() => {
    if (listMode === "detail") {
      // ใน detail mode ต้อง filter ที่ client ด้วย originalIncomeType
      // เพราะ API filter ใช้ income_type (classified) ซึ่งอาจ mismatch กับ originalIncomeType
      // เช่น: incomeType=ปิดยอด แต่ originalIncomeType=ค่างวด (เพราะ receipt_no ไม่ขึ้นต้นด้วย TXRTC)
      // filter ตาม activeTypes เสมอ (ไม่ early return) เพื่อให้ count ถูกต้อง
      return sortedRows.filter((row) => {
        const orig = (row.originalIncomeType as string) ?? "ค่างวด";
        const displayType: IncomeType = orig === "ปิดยอด" ? "ปิดยอด" : "ค่างวด";
        // detail mode ไม่มี ขายเครื่อง — ถ้า activeTypes ไม่มี ขายเครื่อง ให้ filter ด้วย displayType
        return activeTypes.has(displayType);
      });
    }
    // slip mode: group ก่อน แล้ว filter ตาม activeTypes แล้ว sort
    const grouped = groupRowsBySlip(rows); // group จาก rows ดิบ (ไม่ผ่าน sortedRows)
    // filter ตาม activeTypes (classified incomeType)
    const filteredGrouped = grouped.filter((r) => activeTypes.has(r.incomeType as IncomeType));
    const slipSorted = [...filteredGrouped];
    if (sortKey !== "no") {
      slipSorted.sort((a, b) => {
        let av: string | number = 0;
        let bv: string | number = 0;
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
    } else {
      // sortKey === "no": sort ตาม paidAt ASC (default)
      slipSorted.sort((a, b) => {
        const av = a.paidAt ?? "";
        const bv = b.paidAt ?? "";
        if (av < bv) return -1;
        if (av > bv) return 1;
        return 0;
      });
    }
    return slipSorted;
  }, [rows, sortedRows, listMode, activeTypes, sortKey, sortDir]);

  /**
   * getDisplayType — ดึง type ที่จะแสดงใน badge ตาม mode
   * detail mode: ใช้ originalIncomeType (ค่างวด / ปิดยอด เท่านั้น)
   * slip mode: ใช้ incomeType (classified: ค่างวด / ปิดยอด / ขายเครื่อง)
   */
  const getDisplayType = (row: IncomeRow): IncomeType => {
    if (listMode === "detail") {
      const orig = row.originalIncomeType as IncomeType | undefined;
      return (orig === "ปิดยอด" ? "ปิดยอด" : "ค่างวด") as IncomeType;
    }
    return (row.incomeType as IncomeType) ?? "ค่างวด";
  };


  // ทั้ง 2 mode: client-side pagination (displayRows.length เป็น source of truth)
  const totalCount = displayRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // pagedRows: slice displayRows ตาม page (ทั้ง detail และ slip mode)
  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return displayRows.slice(start, start + pageSize);
  }, [displayRows, page, pageSize]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };
  const SortIcon = ({ col }: { col: SortKey }) => {
    if (col !== sortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  const toggleType = (t: IncomeType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) { if (next.size > 1) next.delete(t); }
      else next.add(t);
      return next;
    });
  };

  const clearAll = () => {
    setSearchInput(""); setSearch("");
    setDateFrom(""); setDateTo("");
    setDateField("paidAt");
    setActiveTypes(new Set(ALL_INCOME_TYPES));
    setUpdatedBy("");
    setPage(1);
  };

  const filterCount = [
    search, dateFrom, dateTo, updatedBy,
    activeTypes.size < ALL_INCOME_TYPES.length ? "type" : "",
  ].filter(Boolean).length;

  // ── Export Excel (ตาม mode ที่เลือก) ──
  const handleExport = useCallback(async () => {
    const toastId = toast.loading("กำลัง Export...");
    try {
      // ใช้ rows จาก cache (ที่ filter แล้วตาม search/date/updatedBy)
      if (!rows.length) { toast.error("ไม่มีข้อมูล", { id: toastId }); return; }

      // apply mode
      let exportRows: IncomeRow[] = rows;
      if (listMode === "slip") {
        exportRows = groupRowsBySlip(exportRows);
      }

      const wsData = [
        ["No.", "วันที่ชำระ", "ประเภท", "รหัสรายการ", "เลขที่สัญญา", "ชื่อลูกค้า", "ยอดเงิน", "ทำรายการโดย", "ทำรายการเมื่อ"],
        ...exportRows.map((r, i) => {
          // ใช้ getDisplayType เพื่อแสดงประเภทตาม mode
          const displayType = listMode === "detail"
            ? (r.originalIncomeType === "ปิดยอด" ? "ปิดยอด" : "ค่างวด")
            : r.incomeType;
          return [
            i + 1, fmtDate(r.paidAt), displayType, r.receiptNo ?? "", r.contractNo,
            r.customerName ?? "", r.amount, r.updatedBy ?? "", fmtDateTime(r.updatedAt),
          ];
        }),
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws["!cols"] = [{ wch: 6 }, { wch: 14 }, { wch: 28 }, { wch: 14 }, { wch: 24 }, { wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 20 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "รายรับ");
      const modeSuffix = listMode === "slip" ? "_ตามสลิป" : "_ตามการบันทึก";
      XLSX.writeFile(wb, `รายรับ_${section}${modeSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Export สำเร็จ", { id: toastId });
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed", { id: toastId });
    }
  }, [rows, section, listMode]);

  const handleExportYearly = () => {
    const rows2 = yearlyData ?? [];
    if (!rows2.length) { toast.error("ไม่มีข้อมูล"); return; }
    const wsData = [
      ["ปี", "ค่างวด", "ปิดยอด", "ขายเครื่อง", "รวม"],
      ...rows2.map((r) => [r.period, r["ค่างวด"], r["ปิดยอด"], r["ขายเครื่อง"], r.total]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "สรุปรายปี");
    XLSX.writeFile(wb, `รายรับ_สรุปรายปี_${section}.xlsx`);
  };

  const handleExportMonthly = () => {
    const rows2 = monthlyData ?? [];
    if (!rows2.length) { toast.error("ไม่มีข้อมูล"); return; }
    const wsData = [
      ["เดือน-ปี", "ค่างวด", "ปิดยอด", "ขายเครื่อง", "รวม"],
      ...rows2.map((r) => [fmtMonthYear(r.period), r["ค่างวด"], r["ปิดยอด"], r["ขายเครื่อง"], r.total]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "สรุปรายเดือน");
    XLSX.writeFile(wb, `รายรับ_สรุปรายเดือน_${section}.xlsx`);
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

  // ── Tab style ──
  const tabCls = (t: ActiveTab) => [
    "px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
    activeTab === t
      ? "border-blue-600 text-blue-600"
      : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
  ].join(" ");

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

        {/* ── Header: ชื่อเมนู + Tab bar + Export ── */}
        <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 pt-3 border-b border-gray-200 bg-white">
          <div className="flex items-end gap-4">
            <h1 className="text-lg font-semibold text-gray-800 shrink-0 pb-2">รายรับ</h1>
            <div className="flex items-end gap-0 flex-1 overflow-x-auto">
              <button className={tabCls("yearly")} onClick={() => setActiveTab("yearly")}>สรุปรายปี</button>
              <button className={tabCls("monthly")} onClick={() => setActiveTab("monthly")}>สรุปรายเดือน</button>
              <button className={tabCls("all")} onClick={() => setActiveTab("all")}>รายการทั้งหมด</button>
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
                className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
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
                  <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-blue-500" /></div>
                ) : !yearlyData || yearlyData.length === 0 ? (
                  <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-blue-700 text-white text-xs">
                        {[
                          { label: "ปี", cls: "w-20 text-left" },
                          { label: "ค่างวด", cls: "text-right" },
                          { label: "ปิดยอด", cls: "text-right" },
                          { label: "ขายเครื่อง", cls: "text-right" },
                          { label: "รวม", cls: "text-right font-bold" },
                        ].map(({ label, cls }) => (
                          <th key={label} className={`px-4 py-2.5 font-medium whitespace-nowrap ${cls}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyData.map((row, idx) => (
                        <tr key={row.period} className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${idx % 2 === 1 ? "bg-gray-50" : ""}`}>
                          <td className="px-4 py-2.5 font-semibold text-gray-800">{parseInt(row.period, 10) + 543}</td>
                          <td className="px-4 py-2.5 text-right text-blue-700">{fmtMoney(row["ค่างวด"])}</td>
                          <td className="px-4 py-2.5 text-right text-purple-700">{fmtMoney(row["ปิดยอด"])}</td>
                          <td className="px-4 py-2.5 text-right text-orange-600">{fmtMoney(row["ขายเครื่อง"])}</td>
                          <td className="px-4 py-2.5 text-right font-bold text-gray-900">{fmtMoney(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold text-sm">
                        <td className="px-4 py-2.5 text-gray-700">รวมทั้งหมด</td>
                        <td className="px-4 py-2.5 text-right text-blue-700">{fmtMoney(yearlyData.reduce((s, r) => s + r["ค่างวด"], 0))}</td>
                        <td className="px-4 py-2.5 text-right text-purple-700">{fmtMoney(yearlyData.reduce((s, r) => s + r["ปิดยอด"], 0))}</td>
                        <td className="px-4 py-2.5 text-right text-orange-600">{fmtMoney(yearlyData.reduce((s, r) => s + r["ขายเครื่อง"], 0))}</td>
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
                className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
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
                        isOn ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200 hover:border-blue-400 hover:text-blue-600",
                      ].join(" ")}>
                      {name}
                    </button>
                  );
                })}
                {monthlyMonths.size > 0 && (
                  <button type="button" onClick={() => setMonthlyMonths(new Set())}
                    className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 self-center">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2">
                {monthlyLoading ? (
                  <div className="flex items-center justify-center py-20"><Spinner className="w-6 h-6 text-blue-500" /></div>
                ) : !monthlyData || monthlyData.length === 0 ? (
                  <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-blue-700 text-white text-xs">
                        {[
                          { label: "เดือน-ปี", cls: "w-28 text-left" },
                          { label: "ค่างวด", cls: "text-right" },
                          { label: "ปิดยอด", cls: "text-right" },
                          { label: "ขายเครื่อง", cls: "text-right" },
                          { label: "รวม", cls: "text-right font-bold" },
                        ].map(({ label, cls }) => (
                          <th key={label} className={`px-4 py-2.5 font-medium whitespace-nowrap ${cls}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyData.map((row, idx) => (
                        <tr key={row.period} className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${idx % 2 === 1 ? "bg-gray-50" : ""}`}>
                          <td className="px-4 py-2.5 font-semibold text-gray-800 whitespace-nowrap">{fmtMonthYear(row.period)}</td>
                          <td className="px-4 py-2.5 text-right text-blue-700">{fmtMoney(row["ค่างวด"])}</td>
                          <td className="px-4 py-2.5 text-right text-purple-700">{fmtMoney(row["ปิดยอด"])}</td>
                          <td className="px-4 py-2.5 text-right text-orange-600">{fmtMoney(row["ขายเครื่อง"])}</td>
                          <td className="px-4 py-2.5 text-right font-bold text-gray-900">{fmtMoney(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold text-sm">
                        <td className="px-4 py-2.5 text-gray-700">รวมทั้งหมด</td>
                        <td className="px-4 py-2.5 text-right text-blue-700">{fmtMoney(monthlyData.reduce((s, r) => s + r["ค่างวด"], 0))}</td>
                        <td className="px-4 py-2.5 text-right text-purple-700">{fmtMoney(monthlyData.reduce((s, r) => s + r["ปิดยอด"], 0))}</td>
                        <td className="px-4 py-2.5 text-right text-orange-600">{fmtMoney(monthlyData.reduce((s, r) => s + r["ขายเครื่อง"], 0))}</td>
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
                  placeholder="ค้นหารหัสรายการ / เลขที่สัญญา"
                  className="h-9 pl-8 pr-8 rounded-md border border-gray-200 bg-white text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[200px]" />
                {searchInput && (
                  <button type="button" onClick={() => setSearchInput("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5 text-gray-400" />
                <select value={dateField} onChange={(e) => setDateField(e.target.value as DateField)}
                  className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="paidAt">วันที่ชำระ</option>
                  <option value="updatedAt">วันที่ทำรายการ</option>
                </select>
              </div>
              <div className="flex items-center gap-1">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[140px]" />
                <span className="text-gray-400 text-xs">–</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                  className="h-9 px-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[140px]" />
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
                    className="h-9 pl-8 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[180px] appearance-none">
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

            {/* Badges + Switch mode */}
            <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2 bg-gray-50 border-b border-gray-100">
              {/* ── Switch: รายการตามการบันทึก | รายการตามสลิป ── */}
              <div className="flex items-center rounded-full border border-gray-200 bg-white p-0.5 shadow-sm shrink-0">
                <button
                  type="button"
                  onClick={() => { setListMode("detail"); setPage(1); }}
                  className={[
                    "px-3 py-1 rounded-full text-xs font-medium transition-all whitespace-nowrap",
                    listMode === "detail"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-gray-500 hover:text-gray-700",
                  ].join(" ")}
                >
                  รายการตามการบันทึก
                </button>
                <button
                  type="button"
                  onClick={() => { setListMode("slip"); setPage(1); }}
                  className={[
                    "px-3 py-1 rounded-full text-xs font-medium transition-all whitespace-nowrap",
                    listMode === "slip"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-gray-500 hover:text-gray-700",
                  ].join(" ")}
                >
                  รายการตามสลิป
                </button>
              </div>

              {/* จำนวนรายการ — ใช้ displayRows.length เสมอ (filtered count) */}
              <span className="text-sm text-gray-500">
                {`${displayRows.length.toLocaleString()} รายการ`}
              </span>

              <div className="flex-1" />
              <div className="flex flex-wrap items-center gap-2">
                {ALL_INCOME_TYPES
                  // ใน mode รายการตามการบันทึก ซ่อน badge ขายเครื่อง (ไม่มีใน API)
                  .filter((t) => listMode === "slip" || t !== "ขายเครื่อง")
                  .map((t) => {
                  const isOn = activeTypes.has(t);
                  return (
                    <button key={t} type="button" onClick={() => toggleType(t)}
                      className={["flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all",
                        isOn ? `${BADGE_COLORS[t]} text-white` : "bg-gray-200 text-gray-400"].join(" ")}>
                      {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      <span>{t}</span>
                      <span className={isOn ? "opacity-90" : "opacity-60"}>{fmtMoney(badgeSums[t])}</span>
                    </button>
                  );
                })}
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-800 text-white">
                  <span>รวม</span><span>{fmtMoney(totalVisible)}</span>
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-2">
                {isLoading ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Spinner className="w-6 h-6 text-blue-500" />
                    {totalFromApi > 0 && (
                      <div className="w-64 text-center">
                        <div className="text-xs text-gray-500 mb-1">
                          โหลด {loadedCount.toLocaleString()} / {totalFromApi.toLocaleString()} รายการ
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-1.5">
                          <div
                            className="bg-blue-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${Math.round((loadedCount / totalFromApi) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ) : error ? (
                  <div className="flex items-center justify-center py-20 text-red-500 text-sm">เกิดข้อผิดพลาด: {error.message}</div>
                ) : displayRows.length === 0 ? (
                  <div className="flex items-center justify-center py-20 text-gray-400 text-sm">ไม่พบข้อมูล</div>
                ) : (
                  <>
                    {isPartialLoading && (
                      <div className="flex items-center gap-2 py-1 px-2 mb-2 bg-blue-50 rounded text-xs text-blue-600">
                        <Spinner className="w-3.5 h-3.5" />
                        กำลังโหลดข้อมูลเพิ่มเติม... {loadedCount.toLocaleString()} / {totalFromApi.toLocaleString()} รายการ
                        <div className="flex-1 bg-gray-200 rounded-full h-1">
                          <div className="bg-blue-500 h-1 rounded-full transition-all" style={{ width: `${Math.round((loadedCount / totalFromApi) * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-blue-700 text-white text-xs sticky top-0 z-10">
                        {/* No. */}
                        <th className="px-3 py-2.5 font-medium whitespace-nowrap select-none text-right w-10">No.</th>
                        {/* วันที่ชำระ (sortable) */}
                        <th onClick={() => handleSort("paidAt")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-left w-28">
                          <div className="flex items-center gap-1">วันที่ชำระ<SortIcon col="paidAt" /></div>
                        </th>
                        {/* ประเภท (sortable) — ย้ายมาก่อนรหัสรายการ */}
                        <th onClick={() => handleSort("incomeType")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-left w-28">
                          <div className="flex items-center gap-1">ประเภท<SortIcon col="incomeType" /></div>
                        </th>
                        {/* รหัสรายการ (not sortable) */}
                        <th className="px-3 py-2.5 font-medium whitespace-nowrap select-none text-left w-44">รหัสรายการ</th>
                        {/* เลขที่สัญญา (sortable) */}
                        <th onClick={() => handleSort("contractNo")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-left w-36">
                          <div className="flex items-center gap-1">เลขที่สัญญา<SortIcon col="contractNo" /></div>
                        </th>
                        {/* ยอดเงิน (sortable) */}
                        <th onClick={() => handleSort("amount")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-right w-28">
                          <div className="flex items-center justify-end gap-1">ยอดเงิน<SortIcon col="amount" /></div>
                        </th>
                        {/* ทำรายการโดย (sortable) */}
                        <th onClick={() => handleSort("updatedBy")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-left w-32">
                          <div className="flex items-center gap-1">ทำรายการโดย<SortIcon col="updatedBy" /></div>
                        </th>
                        {/* ทำรายการเมื่อ (sortable) */}
                        <th onClick={() => handleSort("updatedAt")} className="px-3 py-2.5 font-medium whitespace-nowrap select-none cursor-pointer hover:bg-blue-600 text-left w-36">
                          <div className="flex items-center gap-1">ทำรายการเมื่อ<SortIcon col="updatedAt" /></div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRows.map((row, idx) => {
                        const displayType = getDisplayType(row);
                        const typeColor = TYPE_COLORS[displayType] ?? { bg: "bg-gray-50", text: "text-gray-700", dot: "bg-gray-400" };
                        // rowNo: ทั้ง 2 mode ใช้ global index ตาม page
                        const rowNo = (page - 1) * pageSize + idx + 1;
                        return (
                          <tr key={`${row.contractNo}-${idx}`} className="border-b border-gray-100 hover:bg-blue-50 transition-colors">
                            <td className="px-3 py-2 text-right text-gray-400 text-xs">{rowNo}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtDate(row.paidAt)}</td>
                            {/* ประเภท — ย้ายมาก่อนรหัสรายการ */}
                            <td className="px-3 py-2">
                              <span className={["inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", typeColor.bg, typeColor.text].join(" ")}>
                                <span className={["w-1.5 h-1.5 rounded-full", typeColor.dot].join(" ")} />
                                {displayType}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-gray-500 whitespace-nowrap">{row.receiptNo ?? "-"}</td>
                            <td className="px-3 py-2 font-mono text-xs text-gray-700">
                              {row.contractNo}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-gray-800">{fmtMoney(row.amount)}</td>
                            <td className="px-3 py-2 text-gray-600 text-xs">{row.updatedBy ?? "-"}</td>
                            <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtDateTime(row.updatedAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </>
                )}
              </div>
            </div>

            {/* Pagination */}
            {totalCount > 0 && (
              <div className="border-t border-gray-200 bg-white">
                <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 py-3 flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 text-sm text-gray-500 mr-auto">
                    <span>แสดง</span>
                    <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                      className="h-8 px-2 rounded border border-gray-200 text-sm">
                      {[50, 100, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <span>รายการ / หน้า &nbsp;|&nbsp; รวม {totalCount.toLocaleString()} รายการ</span>
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

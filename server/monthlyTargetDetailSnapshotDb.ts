/**
 * monthlyTargetDetailSnapshotDb.ts
 *
 * Populate และ Query ข้อมูล monthly_target_detail_snapshot
 * — snapshot รายสัญญา ณ เวลาที่ผู้ใช้กด "Snapshot" (freeze ตลอด)
 *
 * Logic การ populate (v3 — Freeze ทุก row เหมือน Live):
 *  - ดึงจาก debt_target_cache ทุก row ไม่กรองอะไรออกเลย (เหมือน Live query)
 *  - เก็บ cutoffDate เป็น metadata เพื่อให้ client ใช้คำนวณ isFuturePeriod ใน badge/filter
 *  - เก็บ filter metadata: filterDebtOnly, filterPrincipalOnly (ไม่กรองตอน populate)
 *  - filter ทั้งหมด (debtSetMode, principalOnly, search) ทำที่ client
 *  - ถ้า snapshot_month + snapshot_mode นั้นมีข้อมูลอยู่แล้ว → ไม่ทำอะไร (freeze)
 *  - populate อัตโนมัติทุกวันที่ 1 ของเดือน 06:00 น. (ควบคุมโดย runner.ts)
 *    หรือ on-demand เมื่อผู้ใช้กดปุ่ม Snapshot
 */
import { sql } from "drizzle-orm";
import { getDb, pgRows } from "./db";
import type { SectionKey } from "../shared/const";

function n(v: unknown): number {
  const num = parseFloat(String(v ?? "0"));
  return isNaN(num) ? 0 : num;
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface TargetDetailSnapshotRow {
  id: number;
  section: string;
  snapshotMonth: string;
  contractExternalId: string;
  contractNo: string | null;
  customerName: string | null;
  partnerCode: string | null;
  partnerName: string | null;
  approveDate: string | null;
  productType: string | null;
  device: string | null;
  model: string | null;
  financeAmount: number;
  installmentCount: number | null;
  baselineAmount: number;
  period: number | null;
  dueDate: string | null;
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  unlockFee: number;
  totalAmount: number;
  paidAmount: number;
  contractStatus: string | null;
  debtRange: string | null;
  isPaid: boolean;
  isArrears: boolean;
  isBadDebt: boolean;
  isClosed: boolean;
  isSuspended: boolean;
  isCurrentPeriod: boolean;
  isFuturePeriod: boolean;
  phone: string | null;
  populatedAt: string;
}

export interface TargetDetailSnapshotResult {
  rows: TargetDetailSnapshotRow[];
  total: number;
  snapshotMonth: string;
  populatedAt: string | null;
  // metadata ของ snapshot นี้
  snapshotMode: string | null;      // 'today' | 'end_of_month'
  cutoffDate: string | null;        // YYYY-MM-DD
  filterDebtOnly: boolean;          // toggle ตั้งหนี้ที่เปิดตอน snapshot
  filterPrincipalOnly: boolean;     // toggle เฉพาะเงินต้นที่เปิดตอน snapshot
  // สรุปยอดรวมทั้งหมด (ไม่ขึ้นกับ pagination)
  sumPrincipal: number;
  sumInterest: number;
  sumFee: number;
  sumPenalty: number;
  sumUnlockFee: number;
  sumTotalAmount: number;
  sumPaidAmount: number;
  sumNetAmount: number; // sumTotalAmount - sumPaidAmount (ยอดหนี้คงเหลือรวม)
}

/** Metadata ของ snapshot month หนึ่งๆ — ใช้ใน Log dropdown */
export interface SnapshotMonthMeta {
  snapshotMonth: string;       // YYYY-MM
  snapshotMode: string;        // 'today' | 'end_of_month'
  cutoffDate: string | null;   // YYYY-MM-DD
  filterDebtOnly: boolean;
  filterPrincipalOnly: boolean;
  populatedAt: string | null;
  rowCount: number;
  // filter_state: JSON string ของ filter ที่ใช้ตอน Snapshot — ใช้ auto-restore ตอนเปิดดู Snapshot
  filterState: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * คำนวณ cutoff date จาก snapshotMode + snapshotMonth
 * - 'today'        → วันนี้ (Asia/Bangkok)
 * - 'end_of_month' → วันสุดท้ายของ snapshotMonth
 */
function resolveCutoffDate(mode: string, snapshotMonth: string): string {
  if (mode === "end_of_month") {
    // สิ้นเดือน: YYYY-MM-DD ของวันสุดท้ายในเดือน
    const [year, month] = snapshotMonth.split("-").map(Number);
    const lastDay = new Date(year, month, 0); // วันที่ 0 ของเดือนถัดไป = วันสุดท้ายของเดือนนี้
    const mm = String(lastDay.getMonth() + 1).padStart(2, "0");
    const dd = String(lastDay.getDate()).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  // 'today' — ใช้วันนี้ (Asia/Bangkok)
  const bangkokNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return bangkokNow; // en-CA = YYYY-MM-DD
}

// ─── Populate ─────────────────────────────────────────────────────────────────
/**
 * Populate monthly_target_detail_snapshot สำหรับ section + snapshotMonth ที่กำหนด
 *
 * @param section       - section key (Boonphone | Fastfone365)
 * @param snapshotMonth - YYYY-MM, default = เดือนปัจจุบัน (Asia/Bangkok)
 * @param snapshotMode  - 'today' | 'end_of_month' (default = 'today')
 * @param filterDebtOnly       - บันทึกว่า toggle ตั้งหนี้เปิดอยู่ไหม (metadata เท่านั้น ไม่กรองตอน populate)
 * @param filterPrincipalOnly  - บันทึกว่า toggle เฉพาะเงินต้นเปิดอยู่ไหม (metadata เท่านั้น)
 * @returns จำนวน rows ที่ insert
 */
export async function populateTargetDetailSnapshot(
  section: SectionKey,
  snapshotMonth?: string,
  snapshotMode: "today" | "end_of_month" = "today",
  filterDebtOnly = false,
  filterPrincipalOnly = true,
): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;

  // คำนวณ snapshotMonth ถ้าไม่ระบุ
  if (!snapshotMonth) {
    const bangkokNow = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
    snapshotMonth = bangkokNow.slice(0, 7);
  }

  // คำนวณ cutoff date จาก mode
  const cutoffDate = resolveCutoffDate(snapshotMode, snapshotMonth);

  // ตรวจสอบว่ามีข้อมูลเดือนนี้แล้วหรือไม่ (freeze strategy)
  // ถ้ามีแล้ว → ลบออกก่อน แล้ว INSERT ใหม่ (snapshot เดือนหนึ่งมีแค่ 1 ชุดข้อมูล ไม่แยกตาม mode)
  const existingCountResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const existingCountRows = pgRows(existingCountResult);
  const existingCnt = n(existingCountRows[0]?.cnt ?? 0);
  if (existingCnt > 0) {
    // ลบ snapshot เก่าของเดือนนี้ออกก่อน INSERT ใหม่ (overwrite)
    console.log(`[targetDetailSnapshot] ${section}: ${snapshotMonth} has ${existingCnt} existing rows — deleting and re-inserting with mode=${snapshotMode}`);
    await db.execute(sql.raw(`
      DELETE FROM monthly_target_detail_snapshot
      WHERE section = '${section}'
        AND snapshot_month = '${snapshotMonth}'
    `));
  }

  // Insert ใหม่จาก debt_target_cache
  // *** สำคัญ: บันทึกทุก row ทั้งหมด ไม่กรองอะไรออกเลย ***
  // เหมือน Live query ที่ไม่กรอง is_closed/is_suspended/is_bad_debt ที่ server
  // เพราะ filter ทั้งหมดทำที่ client (filteredRows useMemo)
  // cutoffDate เก็บไว้เป็น metadata เพื่อให้ client ใช้คำนวณ isFuturePeriod ใน badge/filter
  // filterDebtOnly และ filterPrincipalOnly เป็นแค่ metadata — ไม่กรองตอน populate
  const insertResult = await db.execute(sql.raw(`
    INSERT INTO monthly_target_detail_snapshot (
      section,
      snapshot_month,
      contract_external_id,
      contract_no,
      customer_name,
      partner_code,
      partner_name,
      approve_date,
      product_type,
      device,
      model,
      finance_amount,
      installment_count,
      baseline_amount,
      period,
      due_date,
      principal,
      interest,
      fee,
      penalty,
      unlock_fee,
      total_amount,
      paid_amount,
      contract_status,
      debt_range,
      is_paid,
      is_arrears,
      is_bad_debt,
      is_closed,
      is_suspended,
      is_current_period,
      is_future_period,
      snapshot_mode,
      cutoff_date,
      filter_debt_only,
      filter_principal_only,
      phone,
      populated_at
    )
    SELECT
      dtc.section,
      '${snapshotMonth}' AS snapshot_month,
      dtc.contract_external_id,
      dtc.contract_no,
      dtc.customer_name,
      dtc.partner_code,
      dtc.partner_name,
      dtc.approve_date,
      dtc.product_type,
      dtc.device,
      dtc.model,
      COALESCE(dtc.finance_amount::numeric, 0),
      dtc.installment_count,
      COALESCE(dtc.baseline_amount::numeric, 0),
      dtc.period,
      dtc.due_date,
      COALESCE(dtc.principal::numeric, 0),
      COALESCE(dtc.interest::numeric, 0),
      COALESCE(dtc.fee::numeric, 0),
      COALESCE(dtc.penalty::numeric, 0),
      COALESCE(dtc.unlock_fee::numeric, 0),
      COALESCE(dtc.total_amount::numeric, 0),
      COALESCE(dtc.paid_amount::numeric, 0),
      dtc.contract_status,
      dtc.debt_range,
      dtc.is_paid,
      dtc.is_arrears,
      dtc.is_bad_debt,
      dtc.is_closed,
      dtc.is_suspended,
      dtc.is_current_period,
      dtc.is_future_period,
      '${snapshotMode}' AS snapshot_mode,
      '${cutoffDate}' AS cutoff_date,
      ${filterDebtOnly ? "TRUE" : "FALSE"} AS filter_debt_only,
      ${filterPrincipalOnly ? "TRUE" : "FALSE"} AS filter_principal_only,
      c.phone,
      NOW()
    FROM debt_target_cache dtc
    LEFT JOIN contracts c ON c.external_id = dtc.contract_external_id
    WHERE dtc.section = '${section}'
  `));

  // ดึงจำนวน rows ที่ insert
  const countResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const countRows = pgRows(countResult);
  const inserted = n(countRows[0]?.cnt ?? 0);
  console.log(`[targetDetailSnapshot] ${section}: ${snapshotMonth} (${snapshotMode}, cutoff=${cutoffDate}) inserted ${inserted} rows`);
  return inserted;
}

// ─── Query ────────────────────────────────────────────────────────────────────
/**
 * ดึง detail rows จาก monthly_target_detail_snapshot
 * สำหรับ Snapshot View ใน tab เป้าเก็บหนี้
 *
 * @param snapshotMonth - เดือน snapshot ที่ต้องการดู (YYYY-MM)
 * @param snapshotMode  - 'today' | 'end_of_month' (default = 'today')
 * @param upToMonth     - filter due_date <= เดือนนี้ (YYYY-MM) — optional
 */
export async function getTargetDetailSnapshot(params: {
  section: SectionKey;
  snapshotMonth: string;
  snapshotMode?: string;
  upToMonth?: string;
  search?: string;
  productType?: string;
  debtRange?: string;
  debtOnly?: boolean;
  offset?: number;
  limit?: number;
}): Promise<TargetDetailSnapshotResult> {
  const {
    section,
    snapshotMonth,
    snapshotMode = "today",
    upToMonth,
    search,
    productType,
    debtRange,
    debtOnly = false,
    offset = 0,
    limit = 100,
  } = params;

  const db = await getDb(section);
  if (!db) return {
    rows: [], total: 0, snapshotMonth, populatedAt: null,
    snapshotMode: null, cutoffDate: null, filterDebtOnly: false, filterPrincipalOnly: true,
    sumPrincipal: 0, sumInterest: 0, sumFee: 0, sumPenalty: 0, sumUnlockFee: 0,
    sumTotalAmount: 0, sumPaidAmount: 0, sumNetAmount: 0,
  };

  // ตรวจสอบว่า snapshot นี้มีข้อมูลหรือไม่ + ดึง metadata
  const checkResult = await db.execute(sql.raw(`
    SELECT
      COUNT(*) AS cnt,
      MAX(populated_at::text) AS populated_at,
      MAX(COALESCE(snapshot_mode, 'today')) AS snapshot_mode,
      MAX(cutoff_date) AS cutoff_date,
      BOOL_OR(COALESCE(filter_debt_only, FALSE)) AS filter_debt_only,
      BOOL_OR(COALESCE(filter_principal_only, TRUE)) AS filter_principal_only
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const checkRows = pgRows(checkResult);
  const totalInSnapshot = n(checkRows[0]?.cnt ?? 0);
  const populatedAt = checkRows[0]?.populated_at ? String(checkRows[0].populated_at) : null;
  const resolvedMode = checkRows[0]?.snapshot_mode ? String(checkRows[0].snapshot_mode) : snapshotMode;
  const cutoffDate = checkRows[0]?.cutoff_date ? String(checkRows[0].cutoff_date) : null;
  const filterDebtOnlyMeta = Boolean(checkRows[0]?.filter_debt_only);
  const filterPrincipalOnlyMeta = Boolean(checkRows[0]?.filter_principal_only);

  if (totalInSnapshot === 0) {
    return {
      rows: [], total: 0, snapshotMonth, populatedAt: null,
      snapshotMode: resolvedMode, cutoffDate: null, filterDebtOnly: false, filterPrincipalOnly: true,
      sumPrincipal: 0, sumInterest: 0, sumFee: 0, sumPenalty: 0, sumUnlockFee: 0,
      sumTotalAmount: 0, sumPaidAmount: 0, sumNetAmount: 0,
    };
  }

  // สร้าง WHERE conditions (ไม่กรองด้วย snapshotMode เพราะ snapshot เดือนหนึ่งมีแค่ 1 ชุดข้อมูล)
  const conditions: string[] = [
    `section = '${section}'`,
    `snapshot_month = '${snapshotMonth}'`,
  ];

  // filter due_date <= upToMonth (ดึงย้อนหลังทั้งหมดจนถึงเดือนที่คลิก)
  if (upToMonth) {
    conditions.push(`TO_CHAR(due_date::date, 'YYYY-MM') <= '${upToMonth}'`);
  }

  if (search) {
    const escaped = search.replace(/'/g, "''").toLowerCase();
    conditions.push(
      `(LOWER(contract_no) LIKE '%${escaped}%' OR LOWER(customer_name) LIKE '%${escaped}%' OR LOWER(partner_code) LIKE '%${escaped}%')`,
    );
  }
  if (productType) {
    conditions.push(`product_type = '${productType.replace(/'/g, "''")}'`);
  }
  if (debtRange) {
    conditions.push(`debt_range = '${debtRange.replace(/'/g, "''")}'`);
  }
  // Toggle ตั้งหนี้: กรองเฉพาะแถวที่ยอดหนี้คงเหลือ > 0
  if (debtOnly) {
    conditions.push(`GREATEST(COALESCE(total_amount::numeric, 0) - COALESCE(paid_amount::numeric, 0), 0) > 0`);
  }

  const whereClause = conditions.join(" AND ");

  // Count + Sum (server-side, ไม่ขึ้นกับ pagination)
  const countResult = await db.execute(sql.raw(`
    SELECT
      COUNT(*) AS cnt,
      COALESCE(SUM(principal::numeric), 0) AS sum_principal,
      COALESCE(SUM(interest::numeric), 0) AS sum_interest,
      COALESCE(SUM(fee::numeric), 0) AS sum_fee,
      COALESCE(SUM(penalty::numeric), 0) AS sum_penalty,
      COALESCE(SUM(unlock_fee::numeric), 0) AS sum_unlock_fee,
      COALESCE(SUM(total_amount::numeric), 0) AS sum_total_amount,
      COALESCE(SUM(paid_amount::numeric), 0) AS sum_paid_amount,
      COALESCE(SUM(GREATEST(total_amount::numeric - paid_amount::numeric, 0)), 0) AS sum_net_amount
    FROM monthly_target_detail_snapshot
    WHERE ${whereClause}
  `));
  const countRows = pgRows(countResult);
  const total = n(countRows[0]?.cnt ?? 0);
  const sumPrincipal = n(countRows[0]?.sum_principal ?? 0);
  const sumInterest = n(countRows[0]?.sum_interest ?? 0);
  const sumFee = n(countRows[0]?.sum_fee ?? 0);
  const sumPenalty = n(countRows[0]?.sum_penalty ?? 0);
  const sumUnlockFee = n(countRows[0]?.sum_unlock_fee ?? 0);
  const sumTotalAmount = n(countRows[0]?.sum_total_amount ?? 0);
  const sumPaidAmount = n(countRows[0]?.sum_paid_amount ?? 0);
  const sumNetAmount = n(countRows[0]?.sum_net_amount ?? 0);

  // Data
  const dataResult = await db.execute(sql.raw(`
    SELECT
      id,
      section,
      snapshot_month,
      contract_external_id,
      contract_no,
      customer_name,
      partner_code,
      partner_name,
      approve_date,
      product_type,
      device,
      model,
      COALESCE(finance_amount::numeric, 0) AS finance_amount,
      installment_count,
      COALESCE(baseline_amount::numeric, 0) AS baseline_amount,
      period,
      due_date,
      COALESCE(principal::numeric, 0) AS principal,
      COALESCE(interest::numeric, 0) AS interest,
      COALESCE(fee::numeric, 0) AS fee,
      COALESCE(penalty::numeric, 0) AS penalty,
      COALESCE(unlock_fee::numeric, 0) AS unlock_fee,
      COALESCE(total_amount::numeric, 0) AS total_amount,
      COALESCE(paid_amount::numeric, 0) AS paid_amount,
      GREATEST(COALESCE(total_amount::numeric, 0) - COALESCE(paid_amount::numeric, 0), 0) AS net_amount,
      contract_status,
      debt_range,
      is_paid,
      is_arrears,
      is_bad_debt,
      is_closed,
      is_suspended,
      is_current_period,
      is_future_period,
      COALESCE(phone, '') AS phone,
      populated_at::text AS populated_at
    FROM monthly_target_detail_snapshot
    WHERE ${whereClause}
    ORDER BY contract_no, period
    LIMIT ${limit} OFFSET ${offset}
  `));
  const dataRows = pgRows(dataResult);

  const rows: TargetDetailSnapshotRow[] = dataRows.map((row: any) => ({
    id: n(row.id),
    section: String(row.section ?? ""),
    snapshotMonth: String(row.snapshot_month ?? ""),
    contractExternalId: String(row.contract_external_id ?? ""),
    contractNo: row.contract_no ? String(row.contract_no) : null,
    customerName: row.customer_name ? String(row.customer_name) : null,
    partnerCode: row.partner_code ? String(row.partner_code) : null,
    partnerName: row.partner_name ? String(row.partner_name) : null,
    approveDate: row.approve_date ? String(row.approve_date) : null,
    productType: row.product_type ? String(row.product_type) : null,
    device: row.device ? String(row.device) : null,
    model: row.model ? String(row.model) : null,
    financeAmount: n(row.finance_amount),
    installmentCount: row.installment_count != null ? n(row.installment_count) : null,
    baselineAmount: n(row.baseline_amount),
    period: row.period != null ? n(row.period) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
    principal: n(row.principal),
    interest: n(row.interest),
    fee: n(row.fee),
    penalty: n(row.penalty),
    unlockFee: n(row.unlock_fee),
    totalAmount: n(row.total_amount),
    paidAmount: n(row.paid_amount),
    contractStatus: row.contract_status ? String(row.contract_status) : null,
    debtRange: row.debt_range ? String(row.debt_range) : null,
    isPaid: Boolean(row.is_paid),
    isArrears: Boolean(row.is_arrears),
    isBadDebt: Boolean(row.is_bad_debt),
    isClosed: Boolean(row.is_closed),
    isSuspended: Boolean(row.is_suspended),
    isCurrentPeriod: Boolean(row.is_current_period),
    isFuturePeriod: Boolean(row.is_future_period),
    phone: row.phone ? String(row.phone) : null,
    populatedAt: String(row.populated_at ?? ""),
  }));

  return {
    rows,
    total,
    snapshotMonth,
    populatedAt,
    snapshotMode: resolvedMode,
    cutoffDate,
    filterDebtOnly: filterDebtOnlyMeta,
    filterPrincipalOnly: filterPrincipalOnlyMeta,
    sumPrincipal,
    sumInterest,
    sumFee,
    sumPenalty,
    sumUnlockFee,
    sumTotalAmount,
    sumPaidAmount,
    sumNetAmount,
  };
}

/**
 * ดึงรายการ snapshot months ที่มีอยู่ใน DB สำหรับ section นี้
 * Returns: SnapshotMonthMeta[] เรียงจากใหม่ไปเก่า
 */
export async function getAvailableSnapshotMonths(section: SectionKey): Promise<SnapshotMonthMeta[]> {
  const db = await getDb(section);
  if (!db) return [];
  const result = await db.execute(sql.raw(`
    SELECT
      snapshot_month,
      MAX(COALESCE(snapshot_mode, 'today')) AS snapshot_mode,
      MAX(cutoff_date) AS cutoff_date,
      BOOL_OR(COALESCE(filter_debt_only, FALSE)) AS filter_debt_only,
      BOOL_OR(COALESCE(filter_principal_only, TRUE)) AS filter_principal_only,
      MAX(populated_at::text) AS populated_at,
      COUNT(*) AS row_count,
      MAX(filter_state) AS filter_state
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
    GROUP BY snapshot_month
    ORDER BY snapshot_month DESC
  `));
  const rows = pgRows(result);
  return rows.map((r: any) => ({
    snapshotMonth: String(r.snapshot_month ?? ""),
    snapshotMode: String(r.snapshot_mode ?? "today"),
    cutoffDate: r.cutoff_date ? String(r.cutoff_date) : null,
    filterDebtOnly: Boolean(r.filter_debt_only),
    filterPrincipalOnly: Boolean(r.filter_principal_only),
    populatedAt: r.populated_at ? String(r.populated_at) : null,
    rowCount: n(r.row_count),
    filterState: r.filter_state ? String(r.filter_state) : null,
  }));
}

/**
 * ดึงงวดทั้งหมดของสัญญาหนึ่งจาก monthly_target_detail_snapshot
 * ใช้สำหรับ Installment Detail Lightbox เมื่อกดปุ่ม "ค่างวด"
 */
export async function getContractInstallmentsBySnapshot(params: {
  section: SectionKey;
  snapshotMonth: string;
  snapshotMode?: string;
  contractNo: string;
}): Promise<TargetDetailSnapshotRow[]> {
  const { section, snapshotMonth, snapshotMode = "today", contractNo } = params;
  const db = await getDb(section);
  if (!db) return [];

  const escaped = contractNo.replace(/'/g, "''");
  const result = await db.execute(sql.raw(`
    SELECT
      id,
      section,
      snapshot_month,
      contract_external_id,
      contract_no,
      customer_name,
      partner_code,
      partner_name,
      approve_date::text AS approve_date,
      product_type,
      device,
      model,
      COALESCE(finance_amount::numeric, 0) AS finance_amount,
      installment_count,
      COALESCE(baseline_amount::numeric, 0) AS baseline_amount,
      period,
      due_date::text AS due_date,
      COALESCE(principal::numeric, 0) AS principal,
      COALESCE(interest::numeric, 0) AS interest,
      COALESCE(fee::numeric, 0) AS fee,
      COALESCE(penalty::numeric, 0) AS penalty,
      COALESCE(unlock_fee::numeric, 0) AS unlock_fee,
      COALESCE(total_amount::numeric, 0) AS total_amount,
      COALESCE(paid_amount::numeric, 0) AS paid_amount,
      contract_status,
      debt_range,
      is_paid,
      is_arrears,
      is_bad_debt,
      is_closed,
      is_suspended,
      is_current_period,
      is_future_period,
      populated_at::text AS populated_at
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
      AND contract_no = '${escaped}'
    ORDER BY period ASC
  `));
  const dataRows = pgRows(result);

  return dataRows.map((row: any) => ({
    id: n(row.id),
    section: String(row.section ?? ""),
    snapshotMonth: String(row.snapshot_month ?? ""),
    contractExternalId: String(row.contract_external_id ?? ""),
    contractNo: row.contract_no ? String(row.contract_no) : null,
    customerName: row.customer_name ? String(row.customer_name) : null,
    partnerCode: row.partner_code ? String(row.partner_code) : null,
    partnerName: row.partner_name ? String(row.partner_name) : null,
    approveDate: row.approve_date ? String(row.approve_date) : null,
    productType: row.product_type ? String(row.product_type) : null,
    device: row.device ? String(row.device) : null,
    model: row.model ? String(row.model) : null,
    financeAmount: n(row.finance_amount),
    installmentCount: row.installment_count != null ? n(row.installment_count) : null,
    baselineAmount: n(row.baseline_amount),
    period: row.period != null ? n(row.period) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
    principal: n(row.principal),
    interest: n(row.interest),
    fee: n(row.fee),
    penalty: n(row.penalty),
    unlockFee: n(row.unlock_fee),
    totalAmount: n(row.total_amount),
    paidAmount: n(row.paid_amount),
    contractStatus: row.contract_status ? String(row.contract_status) : null,
    debtRange: row.debt_range ? String(row.debt_range) : null,
    isPaid: Boolean(row.is_paid),
    isArrears: Boolean(row.is_arrears),
    isBadDebt: Boolean(row.is_bad_debt),
    isClosed: Boolean(row.is_closed),
    isSuspended: Boolean(row.is_suspended),
    isCurrentPeriod: Boolean(row.is_current_period),
    isFuturePeriod: Boolean(row.is_future_period),
    populatedAt: String(row.populated_at ?? ""),
  }));
}

// ─── WYSIWYS Snapshot (What You See Is What You Save) ─────────────────────────
/**
 * Payload shape สำหรับ 1 สัญญา ที่ client ส่งมาจาก filteredRows
 * (ตรงกับ TargetRow ใน DebtReport.tsx)
 */
export interface ClientSnapshotContractRow {
  contractExternalId: string;
  contractNo: string | null;
  customerName: string | null;
  phone: string | null;
  approveDate: string | null;
  productType: string | null;
  installmentCount: number | null;
  installmentAmount: number | null;
  debtStatus: string;
  installments: Array<{
    period: number | null;
    dueDate: string | null;
    principal: number;
    interest: number;
    fee: number;
    penalty: number;
    unlockFee: number;
    amount: number;
    paid: number;
    baselineAmount: number;
    isClosed: boolean;
    isSuspended: boolean;
    isCurrentPeriod: boolean;
    isFuturePeriod: boolean;
    isArrears: boolean;
    isPaid: boolean;
    netAmount?: number;
  }>;
}

/**
 * บันทึก Snapshot จาก rows ที่ client ส่งมา (WYSIWYS — What You See Is What You Save)
 *
 * แทนที่จะ query DB ใหม่ฝั่ง server, ใช้ข้อมูลที่แสดงอยู่บนหน้าจอโดยตรง
 * → ข้อมูลที่บันทึกตรงกับที่เห็น 100%
 *
 * @param section       - section key
 * @param snapshotMonth - YYYY-MM
 * @param snapshotMode  - 'today' | 'end_of_month'
 * @param cutoffDate    - YYYY-MM-DD (cutoff ที่ client ใช้กรอง)
 * @param filterDebtOnly       - toggle ตั้งหนี้เปิดอยู่ไหม (metadata)
 * @param filterPrincipalOnly  - toggle เฉพาะเงินต้นเปิดอยู่ไหม (metadata)
 * @param rows          - filteredRows จาก client (ทุก row ที่แสดงอยู่บนหน้าจอ)
 * @returns จำนวน rows ที่ insert
 */
export async function saveClientSnapshot(
  section: SectionKey,
  snapshotMonth: string,
  snapshotMode: "today" | "end_of_month",
  cutoffDate: string,
  filterDebtOnly: boolean,
  filterPrincipalOnly: boolean,
  rows: ClientSnapshotContractRow[],
  filterState: string | null = null, // JSON string ของ filter ที่ใช้ตอน Snapshot — ใช้ auto-restore ตอนเปิดดู Snapshot
): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;

  // ลบ snapshot เก่าของเดือนนี้ออกก่อน (overwrite)
  const existingResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const existingCnt = n(pgRows(existingResult)[0]?.cnt ?? 0);
  if (existingCnt > 0) {
    console.log(`[saveClientSnapshot] ${section}: ${snapshotMonth} has ${existingCnt} existing rows — deleting before re-insert`);
    await db.execute(sql.raw(`
      DELETE FROM monthly_target_detail_snapshot
      WHERE section = '${section}'
        AND snapshot_month = '${snapshotMonth}'
    `));
  }

  // Flatten: 1 contract × N installments → N rows
  const BATCH_SIZE = 200;
  let totalInserted = 0;
  let batch: string[] = [];

  const escape = (v: string | null | undefined): string => {
    if (v == null) return "NULL";
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const num = (v: number | null | undefined): string => {
    const n = Number(v ?? 0);
    return isNaN(n) ? "0" : String(n);
  };
  const bool = (v: boolean | null | undefined): string => (v ? "TRUE" : "FALSE");

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const valuesSql = batch.join(",\n");
    await db.execute(sql.raw(`
      INSERT INTO monthly_target_detail_snapshot (
        section, snapshot_month,
        contract_external_id, contract_no, customer_name, phone,
        approve_date, product_type, installment_count, baseline_amount,
        period, due_date,
        principal, interest, fee, penalty, unlock_fee,
        total_amount, paid_amount,
        contract_status, debt_range,
        is_paid, is_arrears, is_bad_debt, is_closed, is_suspended,
        is_current_period, is_future_period,
        snapshot_mode, cutoff_date,
        filter_debt_only, filter_principal_only,
        filter_state,
        populated_at
      ) VALUES ${valuesSql}
    `));
    totalInserted += batch.length;
    batch = [];
  };

  for (const contract of rows) {
    const extId = contract.contractExternalId;
    const contractStatus = contract.debtStatus; // debtStatus = computed status (ปกติ/เกิน X/ระงับ/etc.)
    // debtRange = same as debtStatus (ใช้ debtStatus เป็น debt_range ใน snapshot)
    const debtRange = contractStatus;

    for (const inst of contract.installments ?? []) {
      const isBadDebt = !!inst.isSuspended && contractStatus === "หนี้เสีย";
      batch.push(`(
        ${escape(section)}, ${escape(snapshotMonth)},
        ${escape(extId)}, ${escape(contract.contractNo)}, ${escape(contract.customerName)}, ${escape(contract.phone)},
        ${escape(contract.approveDate)}, ${escape(contract.productType)}, ${contract.installmentCount != null ? String(contract.installmentCount) : "NULL"}, ${num(inst.baselineAmount)},
        ${inst.period != null ? String(inst.period) : "NULL"}, ${escape(inst.dueDate)},
        ${num(inst.principal)}, ${num(inst.interest)}, ${num(inst.fee)}, ${num(inst.penalty)}, ${num(inst.unlockFee)},
        ${num(inst.amount)}, ${num(inst.paid)},
        ${escape(contractStatus)}, ${escape(debtRange)},
        ${bool(inst.isPaid)}, ${bool(inst.isArrears)}, ${bool(isBadDebt)}, ${bool(inst.isClosed)}, ${bool(inst.isSuspended)},
        ${bool(inst.isCurrentPeriod)}, ${bool(inst.isFuturePeriod)},
        ${escape(snapshotMode)}, ${escape(cutoffDate)},
        ${bool(filterDebtOnly)}, ${bool(filterPrincipalOnly)},
        ${escape(filterState)},
        NOW()
      )`);

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }
    }
  }
  await flushBatch();

  console.log(`[saveClientSnapshot] ${section}: ${snapshotMonth} (${snapshotMode}, cutoff=${cutoffDate}) saved ${totalInserted} rows from client (WYSIWYS)`);
  return totalInserted;
}

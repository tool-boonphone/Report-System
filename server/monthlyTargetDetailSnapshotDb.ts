/**
 * monthlyTargetDetailSnapshotDb.ts
 *
 * Populate และ Query ข้อมูล monthly_target_detail_snapshot
 * — snapshot รายสัญญา ณ วันที่ 1 ของทุกเดือน (freeze ตลอด)
 *
 * Logic การ populate:
 *  - ดึงจาก debt_target_cache โดยใช้ debtSetMode filter:
 *    ตัดออก: is_closed, is_future_period, is_suspended, is_bad_debt
 *    เหลือ: งวดที่ถึงกำหนดชำระ (is_current_period) + ค้างชำระ (is_arrears)
 *  - snapshot_month = เดือนปัจจุบัน (YYYY-MM)
 *  - ถ้า snapshot_month นั้นมีข้อมูลอยู่แล้ว → ไม่ทำอะไร (freeze ตลอด ไม่ replace)
 *  - populate เฉพาะวันที่ 1 ของเดือน (ควบคุมโดย runner.ts)
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
  populatedAt: string;
}

export interface TargetDetailSnapshotResult {
  rows: TargetDetailSnapshotRow[];
  total: number;
  snapshotMonth: string;
  populatedAt: string | null;
}

// ─── Populate ─────────────────────────────────────────────────────────────────
/**
 * Populate monthly_target_detail_snapshot สำหรับ section + snapshotMonth ที่กำหนด
 * ถ้า snapshotMonth ไม่ระบุ จะใช้เดือนปัจจุบัน (Asia/Bangkok)
 * Returns: จำนวน rows ที่ insert
 */
export async function populateTargetDetailSnapshot(
  section: SectionKey,
  snapshotMonth?: string, // YYYY-MM, default = เดือนปัจจุบัน
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
    // en-CA format: "YYYY-MM" (เพราะ en-CA ใช้ ISO format)
    snapshotMonth = bangkokNow.slice(0, 7);
  }

  // ตรวจสอบว่ามีข้อมูลเดือนนี้แล้วหรือไม่ (freeze strategy)
  // ถ้ามีแล้ว → ไม่ populate ซ้ำ (ข้อมูลถูก freeze ไว้ตลอด)
  const existingCountResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const existingCountRows = pgRows(existingCountResult);
  const existingCnt = n(existingCountRows[0]?.cnt ?? 0);
  if (existingCnt > 0) {
    console.log(`[targetDetailSnapshot] ${section}: ${snapshotMonth} already has ${existingCnt} rows — skipping (frozen)`);
    return existingCnt;
  }

  // Insert ใหม่จาก debt_target_cache
  // debtSetMode filter: ตัด is_closed, is_future_period, is_suspended, is_bad_debt ออก
  // เหลือเฉพาะ: งวดที่ถึงกำหนดชำระ + ค้างชำระ (is_arrears)
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
      populated_at
    )
    SELECT
      section,
      '${snapshotMonth}' AS snapshot_month,
      contract_external_id,
      contract_no,
      customer_name,
      partner_code,
      partner_name,
      approve_date,
      product_type,
      device,
      model,
      COALESCE(finance_amount::numeric, 0),
      installment_count,
      COALESCE(baseline_amount::numeric, 0),
      period,
      due_date,
      COALESCE(principal::numeric, 0),
      COALESCE(interest::numeric, 0),
      COALESCE(fee::numeric, 0),
      COALESCE(penalty::numeric, 0),
      COALESCE(unlock_fee::numeric, 0),
      COALESCE(total_amount::numeric, 0),
      COALESCE(paid_amount::numeric, 0),
      contract_status,
      debt_range,
      is_paid,
      is_arrears,
      is_bad_debt,
      is_closed,
      is_suspended,
      is_current_period,
      is_future_period,
      NOW()
    FROM debt_target_cache
    WHERE section = '${section}'
      AND is_closed IS NOT TRUE
      AND is_future_period IS NOT TRUE
      AND is_suspended IS NOT TRUE
      AND is_bad_debt IS NOT TRUE
  `));

  // ดึงจำนวน rows ที่ insert
  const countResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const countRows = pgRows(countResult);
  return n(countRows[0]?.cnt ?? 0);
}

// ─── Query ────────────────────────────────────────────────────────────────────
/**
 * ดึง detail rows จาก monthly_target_detail_snapshot
 * สำหรับ Lightbox ยอดเก็บหนี้ใน tab รายเดือน
 *
 * @param snapshotMonth - เดือน snapshot ที่ต้องการดู (YYYY-MM)
 * @param upToMonth - ดึงข้อมูลตั้งแต่เดือนแรกจนถึงเดือนนี้ (YYYY-MM) — ถ้าไม่ระบุ = snapshotMonth เดียว
 */
export async function getTargetDetailSnapshot(params: {
  section: SectionKey;
  snapshotMonth: string; // snapshot ที่ populate ไว้ (YYYY-MM)
  upToMonth?: string; // filter due_date <= เดือนนี้ (YYYY-MM)
  search?: string;
  productType?: string;
  debtRange?: string;
  offset?: number;
  limit?: number;
}): Promise<TargetDetailSnapshotResult> {
  const {
    section,
    snapshotMonth,
    upToMonth,
    search,
    productType,
    debtRange,
    offset = 0,
    limit = 100,
  } = params;

  const db = await getDb(section);
  if (!db) return { rows: [], total: 0, snapshotMonth, populatedAt: null };

  // ตรวจสอบว่า snapshot นี้มีข้อมูลหรือไม่
  const checkResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt, MAX(populated_at::text) AS populated_at
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
      AND snapshot_month = '${snapshotMonth}'
  `));
  const checkRows = pgRows(checkResult);
  const totalInSnapshot = n(checkRows[0]?.cnt ?? 0);
  const populatedAt = checkRows[0]?.populated_at ? String(checkRows[0].populated_at) : null;

  if (totalInSnapshot === 0) {
    return { rows: [], total: 0, snapshotMonth, populatedAt: null };
  }

  // สร้าง WHERE conditions
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

  const whereClause = conditions.join(" AND ");

  // Count
  const countResult = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM monthly_target_detail_snapshot
    WHERE ${whereClause}
  `));
  const countRows = pgRows(countResult);
  const total = n(countRows[0]?.cnt ?? 0);

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
    populatedAt: String(row.populated_at ?? ""),
  }));

  return { rows, total, snapshotMonth, populatedAt };
}

/**
 * ดึงรายการ snapshot months ที่มีอยู่ใน DB สำหรับ section นี้
 */
export async function getAvailableSnapshotMonths(section: SectionKey): Promise<string[]> {
  const db = await getDb(section);
  if (!db) return [];
  const result = await db.execute(sql.raw(`
    SELECT DISTINCT snapshot_month
    FROM monthly_target_detail_snapshot
    WHERE section = '${section}'
    ORDER BY snapshot_month DESC
  `));
  const rows = pgRows(result);
  return rows.map((r: any) => String(r.snapshot_month ?? ""));
}

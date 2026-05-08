/**
 * accountingDb.ts — Query helpers สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 *
 * รายรับ (Income):
 *   - ดึงจาก debt_collected_cache ทุก row
 *   - แยกประเภทตาม:
 *       is_bad_debt_row = 1  → ขายเครื่อง  (ยอด = bad_debt)
 *       is_close_row = 1     → ปิดยอด     (ยอด = total_amount)
 *       otherwise            → ค่างวด     (ยอด = total_amount)
 *   - "เงินดาวน์" ซ่อนไว้ก่อน (period = 0 ไม่มีในข้อมูลจริง)
 *
 * รายจ่าย (Expense):
 *   - ดึงจาก contracts.commission_net (ค่าคอมมิชชั่น)
 *   - รองรับประเภทอื่นในอนาคต
 */

import { sql } from "drizzle-orm";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

// ─── Income Types ─────────────────────────────────────────────────────────────

export type IncomeType = "ค่างวด" | "ขายเครื่อง" | "ปิดยอด" | "เงินดาวน์";
export type ExpenseType = "ค่าคอมมิชชั่น";

export interface IncomeRow {
  id: number;
  contractNo: string;
  customerName: string | null;
  paidAt: string | null;
  incomeType: IncomeType;
  amount: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface IncomeParams {
  section: SectionKey;
  search?: string;
  dateFrom?: string;         // YYYY-MM-DD
  dateTo?: string;           // YYYY-MM-DD
  dateField?: "paidAt" | "updatedAt";
  incomeTypes?: IncomeType[];
  updatedBy?: string;
  page?: number;
  pageSize?: number;
}

export interface ExpenseRow {
  id: number;
  contractNo: string;
  approveDate: string | null;
  expenseType: ExpenseType;
  amount: number;
  partnerCode: string | null;
  partnerName: string | null;
}

export interface ExpenseParams {
  section: SectionKey;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  expenseTypes?: ExpenseType[];
  page?: number;
  pageSize?: number;
}

// ─── Income ───────────────────────────────────────────────────────────────────

/**
 * Income type CASE expression:
 *   is_bad_debt_row = 1  → ขายเครื่อง
 *   is_close_row = 1     → ปิดยอด
 *   otherwise            → ค่างวด
 *
 * NOTE: "เงินดาวน์" (period = 0) ซ่อนไว้ก่อน — ไม่มีในข้อมูลจริง
 */
const INCOME_TYPE_CASE = `
  CASE
    WHEN is_bad_debt_row = 1 THEN 'ขายเครื่อง'
    WHEN is_close_row = 1 THEN 'ปิดยอด'
    ELSE 'ค่างวด'
  END
`;

/**
 * Amount CASE expression:
 *   ขายเครื่อง → bad_debt column
 *   ปิดยอด / ค่างวด → total_amount column
 */
const AMOUNT_CASE = `
  CASE
    WHEN is_bad_debt_row = 1 THEN COALESCE(bad_debt, 0)
    ELSE COALESCE(total_amount, 0)
  END
`;

/**
 * ดึง income rows พร้อม pagination
 * ใช้ CASE WHEN ใน SQL เพื่อจำแนก income_type ตาม is_close_row / is_bad_debt_row
 */
export async function listIncome(params: IncomeParams): Promise<{
  rows: IncomeRow[];
  total: number;
}> {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };

  const {
    section,
    search,
    dateFrom,
    dateTo,
    dateField = "paidAt",
    incomeTypes,
    updatedBy,
    page = 1,
    pageSize = 50,
  } = params;

  const offset = (page - 1) * pageSize;
  const esc = (v: string) => v.replace(/'/g, "''");

  // Date column
  const dateCol = dateField === "paidAt" ? "paid_at" : "updated_at";

  // Build WHERE conditions
  const conditions: string[] = [`section = '${esc(section)}'`];

  if (search) {
    conditions.push(`(contract_no LIKE '%${esc(search)}%' OR customer_name LIKE '%${esc(search)}%')`);
  }
  if (dateFrom) {
    conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  }
  if (dateTo) {
    conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);
  }
  if (updatedBy) {
    conditions.push(`updated_by = '${esc(updatedBy)}'`);
  }

  // Income type filter (applied as outer WHERE on subquery)
  let incomeTypeFilter = "";
  if (incomeTypes && incomeTypes.length > 0) {
    const quoted = incomeTypes.map((t) => `'${esc(t)}'`).join(", ");
    incomeTypeFilter = `WHERE income_type IN (${quoted})`;
  }

  const whereStr = conditions.join(" AND ");

  // Total count query
  const countSql = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT ${INCOME_TYPE_CASE} AS income_type
      FROM debt_collected_cache
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
  `;

  // Data query
  const dataSql = `
    SELECT *
    FROM (
      SELECT
        id,
        contract_no,
        customer_name,
        paid_at,
        updated_by,
        updated_at,
        ${INCOME_TYPE_CASE} AS income_type,
        ${AMOUNT_CASE} AS amount
      FROM debt_collected_cache
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
    ORDER BY paid_at DESC, id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const [countResult, dataResult] = await Promise.all([
    db.execute(sql.raw(countSql)),
    db.execute(sql.raw(dataSql)),
  ]);

  const countArr: any[] = (countResult as any)[0] ?? countResult;
  const total = Number(countArr[0]?.total ?? 0);
  const dataArr: any[] = (dataResult as any)[0] ?? dataResult;
  const rows: IncomeRow[] = (dataArr ?? []).map((r: any) => ({
    id: Number(r.id),
    contractNo: r.contract_no ?? "",
    customerName: r.customer_name ?? null,
    paidAt: r.paid_at ?? null,
    incomeType: r.income_type as IncomeType,
    amount: Number(r.amount ?? 0),
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ?? null,
  }));

  return { rows, total };
}

/** ดึง distinct updatedBy สำหรับ income filter dropdown */
export async function listIncomeUpdatedBy(section: SectionKey): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db.execute(
    sql.raw(`
      SELECT DISTINCT updated_by
      FROM debt_collected_cache
      WHERE section = '${section.replace(/'/g, "''")}' AND updated_by IS NOT NULL AND updated_by != ''
      ORDER BY updated_by ASC
    `),
  );
  const arr: any[] = (result as any)[0] ?? result;
  return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
}

// ─── Expense ──────────────────────────────────────────────────────────────────

/** ดึง expense rows (ค่าคอมมิชชั่น) พร้อม pagination */
export async function listExpense(params: ExpenseParams): Promise<{
  rows: ExpenseRow[];
  total: number;
}> {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };

  const {
    section,
    search,
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 50,
  } = params;

  const offset = (page - 1) * pageSize;
  const esc = (v: string) => v.replace(/'/g, "''");

  const conditions: string[] = [
    `section = '${esc(section)}'`,
    `commission_net IS NOT NULL`,
    `commission_net > 0`,
  ];

  if (search) {
    conditions.push(`contract_no LIKE '%${esc(search)}%'`);
  }
  if (dateFrom) {
    conditions.push(`approve_date >= '${esc(dateFrom)}'`);
  }
  if (dateTo) {
    conditions.push(`approve_date <= '${esc(dateTo)}'`);
  }

  const whereStr = conditions.join(" AND ");

  const [countResult, dataResult] = await Promise.all([
    db.execute(sql.raw(`SELECT COUNT(*) AS total FROM contracts WHERE ${whereStr}`)),
    db.execute(
      sql.raw(`
        SELECT id, contract_no, approve_date, commission_net, partner_code, partner_name
        FROM contracts
        WHERE ${whereStr}
        ORDER BY approve_date DESC, id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
    ),
  ]);

  const countArr: any[] = (countResult as any)[0] ?? countResult;
  const total = Number(countArr[0]?.total ?? 0);
  const dataArr: any[] = (dataResult as any)[0] ?? dataResult;
  const rows: ExpenseRow[] = (dataArr ?? []).map((r: any) => ({
    id: Number(r.id),
    contractNo: r.contract_no ?? "",
    approveDate: r.approve_date ?? null,
    expenseType: "ค่าคอมมิชชั่น" as ExpenseType,
    amount: Number(r.commission_net ?? 0),
    partnerCode: r.partner_code ?? null,
    partnerName: r.partner_name ?? null,
  }));

  return { rows, total };
}

// ─── Summary (Badge sums) ─────────────────────────────────────────────────────

export interface IncomeSummary {
  "ค่างวด": number;
  "ขายเครื่อง": number;
  "ปิดยอด": number;
  "เงินดาวน์": number;
  total: number;
}

/**
 * คำนวณ SUM ของแต่ละ income type ใน SQL โดยตรง
 * ใช้สำหรับ Badge display แทนการดึง rows ทั้งหมดมา sum ฝั่ง client
 */
export async function getIncomeSummary(
  params: Omit<IncomeParams, "page" | "pageSize">,
): Promise<IncomeSummary> {
  const db = await getDb();
  if (!db) return { "ค่างวด": 0, "ขายเครื่อง": 0, "ปิดยอด": 0, "เงินดาวน์": 0, total: 0 };

  const {
    section,
    search,
    dateFrom,
    dateTo,
    dateField = "paidAt",
    incomeTypes,
    updatedBy,
  } = params;

  const esc = (v: string) => v.replace(/'/g, "''");
  const dateCol = dateField === "paidAt" ? "paid_at" : "updated_at";

  const conditions: string[] = [`section = '${esc(section)}'`];
  if (search) conditions.push(`(contract_no LIKE '%${esc(search)}%' OR customer_name LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);
  if (updatedBy) conditions.push(`updated_by = '${esc(updatedBy)}'`);

  let incomeTypeFilter = "";
  if (incomeTypes && incomeTypes.length > 0) {
    const quoted = incomeTypes.map((t) => `'${esc(t)}'`).join(", ");
    incomeTypeFilter = `WHERE income_type IN (${quoted})`;
  }

  const whereStr = conditions.join(" AND ");

  const querySql = `
    SELECT income_type, SUM(amount) AS sum_amount
    FROM (
      SELECT
        ${INCOME_TYPE_CASE} AS income_type,
        ${AMOUNT_CASE} AS amount
      FROM debt_collected_cache
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
    GROUP BY income_type
  `;

  const result = await db.execute(sql.raw(querySql));
  const rows: any[] = (result as any)[0] ?? result;

  const summary: IncomeSummary = { "ค่างวด": 0, "ขายเครื่อง": 0, "ปิดยอด": 0, "เงินดาวน์": 0, total: 0 };
  for (const r of rows) {
    const t = r.income_type as IncomeType;
    const v = Number(r.sum_amount ?? 0);
    if (t in summary) (summary as any)[t] = v;
    summary.total += v;
  }
  return summary;
}

export interface ExpenseSummary {
  "ค่าคอมมิชชั่น": number;
  total: number;
}

/** คำนวณ SUM ของแต่ละ expense type ใน SQL โดยตรง */
export async function getExpenseSummary(
  params: Omit<ExpenseParams, "page" | "pageSize">,
): Promise<ExpenseSummary> {
  const db = await getDb();
  if (!db) return { "ค่าคอมมิชชั่น": 0, total: 0 };

  const { section, search, dateFrom, dateTo } = params;
  const esc = (v: string) => v.replace(/'/g, "''");

  const conditions: string[] = [
    `section = '${esc(section)}'`,
    `commission_net IS NOT NULL`,
    `commission_net > 0`,
  ];
  if (search) conditions.push(`contract_no LIKE '%${esc(search)}%'`);
  if (dateFrom) conditions.push(`approve_date >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`approve_date <= '${esc(dateTo)}'`);

  const whereStr = conditions.join(" AND ");
  const result = await db.execute(
    sql.raw(`SELECT SUM(commission_net) AS total FROM contracts WHERE ${whereStr}`),
  );
  const arr: any[] = (result as any)[0] ?? result;
  const total = Number(arr[0]?.total ?? 0);
  return { "ค่าคอมมิชชั่น": total, total };
}

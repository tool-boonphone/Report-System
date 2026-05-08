/**
 * accountingDb.ts — Query helpers สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 *
 * รายรับ (Income):
 *   - ดึงจาก debt_collected_cache ทุก row
 *   - แยกประเภทตาม: ค่างวด, ขายเครื่อง (is_bad_debt_row=1), ปิดยอด (overpaid>0 & principal=0),
 *     เงินดาวน์ (period=0)
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
 * ดึง income rows พร้อม pagination
 * ใช้ CASE WHEN ใน SQL เพื่อจำแนก income_type ตาม logic เดียวกับ DebtReport
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
    conditions.push(`contract_no LIKE '%${esc(search)}%'`);
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

  // Income type CASE expression
  // Logic:
  //   period = 0 → เงินดาวน์
  //   is_bad_debt_row = 1 → ขายเครื่อง
  //   overpaid > 0 AND principal = 0 AND interest = 0 AND fee = 0 → ปิดยอด
  //   otherwise → ค่างวด
  const incomeTypeCaseExpr = `
    CASE
      WHEN period = 0 THEN 'เงินดาวน์'
      WHEN is_bad_debt_row = 1 THEN 'ขายเครื่อง'
      WHEN overpaid > 0 AND principal = 0 AND interest = 0 AND fee = 0 THEN 'ปิดยอด'
      ELSE 'ค่างวด'
    END
  `;

  // Amount CASE expression
  const amountCaseExpr = `
    CASE
      WHEN is_bad_debt_row = 1 THEN COALESCE(bad_debt, 0)
      WHEN overpaid > 0 AND principal = 0 AND interest = 0 AND fee = 0 THEN COALESCE(overpaid, 0)
      ELSE COALESCE(total_amount, 0)
    END
  `;

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
      SELECT ${incomeTypeCaseExpr} AS income_type
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
        ${incomeTypeCaseExpr} AS income_type,
        ${amountCaseExpr} AS amount
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

  const total = Number((countResult as any[])[0]?.total ?? 0);
  const rows: IncomeRow[] = ((dataResult as any[]) ?? []).map((r: any) => ({
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
  return ((result as any[]) ?? []).map((r: any) => r.updated_by).filter(Boolean);
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

  const total = Number((countResult as any[])[0]?.total ?? 0);
  const rows: ExpenseRow[] = ((dataResult as any[]) ?? []).map((r: any) => ({
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
  if (search) conditions.push(`contract_no LIKE '%${esc(search)}%'`);
  if (dateFrom) conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);
  if (updatedBy) conditions.push(`updated_by = '${esc(updatedBy)}'`);

  const incomeTypeCaseExpr = `
    CASE
      WHEN period = 0 THEN 'เงินดาวน์'
      WHEN is_bad_debt_row = 1 THEN 'ขายเครื่อง'
      WHEN overpaid > 0 AND principal = 0 AND interest = 0 AND fee = 0 THEN 'ปิดยอด'
      ELSE 'ค่างวด'
    END
  `;
  const amountCaseExpr = `
    CASE
      WHEN is_bad_debt_row = 1 THEN COALESCE(bad_debt, 0)
      WHEN overpaid > 0 AND principal = 0 AND interest = 0 AND fee = 0 THEN COALESCE(overpaid, 0)
      ELSE COALESCE(total_amount, 0)
    END
  `;

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
        ${incomeTypeCaseExpr} AS income_type,
        ${amountCaseExpr} AS amount
      FROM debt_collected_cache
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
    GROUP BY income_type
  `;

  const result = await db.execute(sql.raw(querySql));
  const rows = (result as any[]) ?? [];

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
  const total = Number((result as any[])[0]?.total ?? 0);
  return { "ค่าคอมมิชชั่น": total, total };
}

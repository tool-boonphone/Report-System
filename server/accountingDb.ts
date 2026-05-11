/**
 * accountingDb.ts — Query helpers สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 *
 * รายรับ (Income):
 *   - ดึงจาก payment_transactions WHERE JSON_EXTRACT(raw_json, '$.source') IS NULL
 *     (เฉพาะ close rows ที่มี principal_paid, interest_paid ฯลฯ ครบถ้วน)
 *   - ยอดรวม = payment_transactions.amount ตรงกับ Fastfone/Boonphone Report เป๊ะ
 *   - แยกประเภทตาม logic:
 *       ขายเครื่อง = payment ในวันสุดท้ายของสัญญาที่มีสถานะ 'หนี้เสีย'
 *                    (c.status = 'หนี้เสีย' AND DATE(pt.paid_at) = last paid date ของสัญญานั้น)
 *       ปิดยอด     = มี close_installment_amount > 0 ใน raw_json (สัญญาสิ้นสุด ลูกค้าชำระครบ)
 *       ค่างวด     = payment ปกติที่ไม่ใช่สองประเภทข้างต้น
 *   - ยอดของแต่ละประเภท = pt.amount (ไม่ต้องแยกย่อย เพราะ 1 row = 1 payment)
 *   - ค่างวด + ปิดยอด + ขายเครื่อง = total = ตรงกับ Fastfone/Boonphone Report เป๊ะ
 *
 * รายจ่าย (Expense):
 *   - ดึงจาก contracts.commission_net (ค่าคอมมิชชั่น)
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
  /**
   * incomeType = classified type (ค่างวด / ปิดยอด / ขายเครื่อง)
   * ใช้สำหรับ mode รายการตามบิล (slip mode)
   */
  incomeType: IncomeType;
  /**
   * originalIncomeType = type ตาม API จริงๆ (ค่างวด / ปิดยอด เท่านั้น ไม่มีขายเครื่อง)
   * ขายเครื่อง → ค่างวด (API ส่งมาเป็น ค่างวด แต่ระบบ classify เป็น ขายเครื่อง)
   * ใช้สำหรับ mode รายการตามการบันทึก (detail mode)
   */
  originalIncomeType: "ค่างวด" | "ปิดยอด";
  /** receiptNo = รหัสรายการ เช่น TXRT1225-PTE010-19331-01-1 หรือ TXRTC1225-PTE010-19331-01 */
  receiptNo: string | null;
  /** contractStatus = สถานะสัญญา เช่น 'ปกติ', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ระงับสัญญา' */
  contractStatus: string | null;
  amount: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface IncomeParams {
  section: SectionKey;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
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
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ExpenseParams {
  section: SectionKey;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  expenseTypes?: ExpenseType[];
  updatedBy?: string;
  page?: number;
  pageSize?: number;
}

// ─── Income SQL Helpers ────────────────────────────────────────────────────────

/**
 * Income type CASE expression (ต้องใช้ร่วมกับ JOIN contracts c และ bad_debt_last_days bdl)
 *
 * ขายเครื่อง = payment ในวันสุดท้ายของสัญญาหนี้เสีย
 *   - c.status = 'หนี้เสีย'
 *   - DATE(pt.paid_at) = วันสุดท้ายที่มีการชำระของสัญญานั้น (จาก subquery bad_debt_last_days)
 * ปิดยอด = มี close_installment_amount > 0 ใน raw_json AND c.status = 'สิ้นสุดสัญญา'
 * ค่างวด = อื่นๆ
 *
 * หมายเหตุ: ต้อง LEFT JOIN bad_debt_last_days bdl ก่อนใช้ expression นี้
 */

/**
 * Original income type CASE expression — type ตาม API จริงๆ
 * ไม่มี ขายเครื่อง เพราะ API ส่งมาแค่ ค่างวด และ ปิดยอด
 * ขายเครื่อง (classified) → ค่างวด (original)
 * ใช้สำหรับ mode รายการตามการบันทึก (detail mode)
 *
 * ปิดยอด = receipt_no ขึ้นต้นด้วย 'TXRTC' (ไม่มีเลขต่อท้าย เช่น TXRTC1225-PTE010-19331-01)
 * ค่างวด = receipt_no ขึ้นต้นด้วย 'TXRT' แต่ไม่ใช่ 'TXRTC' (เช่น TXRT1225-PTE010-19331-01-1)
 */
const PT_ORIGINAL_INCOME_TYPE_CASE = `
  CASE
    WHEN pt.receipt_no LIKE 'TXRTC%'
      THEN 'ปิดยอด'
    ELSE 'ค่างวด'
  END
`;
const PT_INCOME_TYPE_CASE = `
  CASE
    -- ขายเครื่อง: สัญญาหนี้เสีย + transaction อยู่ใน batch สุดท้าย
    -- (paid_at วันสุดท้าย + DATE(created_at) วันเดียวกัน + updated_by คนเดียวกัน)
    WHEN c.status = 'หนี้เสีย'
      AND bdl.last_paid_date IS NOT NULL
      AND DATE(pt.paid_at) = bdl.last_paid_date
      AND bdl.last_created_at IS NOT NULL
      AND DATE(pt.created_at) = DATE(bdl.last_created_at)
      AND (bdl.last_updated_by IS NULL OR pt.updated_by = bdl.last_updated_by)
      THEN 'ขายเครื่อง'
    -- ปิดยอด: สัญญาสิ้นสุดสัญญา/สำเร็จ + transaction อยู่ใน batch สุดท้าย
    -- (paid_at วันสุดท้าย + DATE(created_at) วันเดียวกัน + updated_by คนเดียวกัน)
    WHEN c.status IN ('สิ้นสุดสัญญา', 'สำเร็จ')
      AND bdl.last_paid_date IS NOT NULL
      AND DATE(pt.paid_at) = bdl.last_paid_date
      AND bdl.last_created_at IS NOT NULL
      AND DATE(pt.created_at) = DATE(bdl.last_created_at)
      AND (bdl.last_updated_by IS NULL OR pt.updated_by = bdl.last_updated_by)
      THEN 'ปิดยอด'
    ELSE 'ค่างวด'
  END
`;

/**
 * Amount CASE expression — ยอดของแต่ละ row = pt.amount เสมอ
 * (1 payment row = 1 ยอด ไม่ว่าจะเป็นประเภทใด)
 */
const PT_AMOUNT_CASE = `CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2))`;

// Base WHERE: เฉพาะ close rows (source IS NULL) ที่ตรงกับ Fastfone/Boonphone Report
const PT_INCOME_BASE_WHERE = `JSON_EXTRACT(pt.raw_json, '$.source') IS NULL`;



/**
 * Subquery สำหรับหาวันสุดท้ายที่ชำระของแต่ละสัญญาหนี้เสีย
 * ใช้ LEFT JOIN กับ payment_transactions pt ด้วย contract_no + section
 *
 * @param section - SectionKey ที่ต้องการ (ใส่ escaped string)
 */
function buildBadDebtLastDaysSubquery(section: string): string {
  // หา batch สุดท้ายของแต่ละสัญญา โดยใช้ ROW_NUMBER() เรียง paid_at DESC, created_at DESC
  // batch เดียวกัน = paid_at วันเดียวกัน + DATE(created_at) วันเดียวกัน + updated_by คนเดียวกัน
  // (admin อาจบันทึกหลาย payments ในช่วงเวลาสั้นๆ ทำให้ created_at ต่างกัน 1-2 นาที)
  return `
    SELECT
      inner_q.contract_no,
      inner_q.section,
      inner_q.last_paid_date,
      inner_q.last_created_at,
      inner_q.last_updated_by
    FROM (
      SELECT
        pt2.contract_no,
        pt2.section,
        DATE(pt2.paid_at) AS last_paid_date,
        pt2.created_at AS last_created_at,
        pt2.updated_by AS last_updated_by,
        ROW_NUMBER() OVER (
          PARTITION BY pt2.contract_no, pt2.section
          ORDER BY pt2.paid_at DESC, pt2.created_at DESC
        ) AS rn
      FROM payment_transactions pt2
      WHERE pt2.section = '${section}'
        AND JSON_EXTRACT(pt2.raw_json, '$.source') IS NULL
    ) AS inner_q
    WHERE inner_q.rn = 1
  `;
}

// ─── Income ───────────────────────────────────────────────────────────────────

export async function listIncome(params: IncomeParams): Promise<{
  rows: IncomeRow[];
  total: number;
}> {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };

  const {
    section, search, dateFrom, dateTo,
    dateField = "paidAt", incomeTypes, updatedBy,
    page = 1, pageSize = 50,
  } = params;

  const offset = (page - 1) * pageSize;
  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);
  const dateCol = dateField === "paidAt" ? "pt.paid_at" : "pt.updated_at";

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    PT_INCOME_BASE_WHERE,
  ];
  // ค้นหาจาก รหัสรายการ (receipt_no) หรือ เลขที่สัญญา (contract_no) เท่านั้น
  if (search) conditions.push(`(pt.receipt_no LIKE '%${esc(search)}%' OR pt.contract_no LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);
  if (updatedBy) conditions.push(`pt.updated_by = '${esc(updatedBy)}'`);

  let incomeTypeFilter = "";
  if (incomeTypes && incomeTypes.length > 0) {
    const quoted = incomeTypes.map((t) => `'${esc(t)}'`).join(", ");
    incomeTypeFilter = `WHERE income_type IN (${quoted})`;
  }

  const whereStr = conditions.join(" AND ");
  const bdlSubquery = buildBadDebtLastDaysSubquery(secEsc);

  const countSql = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT ${PT_INCOME_TYPE_CASE} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      LEFT JOIN (${bdlSubquery}) AS bdl ON bdl.contract_no = pt.contract_no AND bdl.section = pt.section
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
  `;

  const dataSql = `
    SELECT *
    FROM (
      SELECT
        pt.id,
        pt.contract_no,
        c.customer_name,
        pt.paid_at,
        pt.updated_by,
        pt.updated_at,
        pt.receipt_no,
        c.status AS contract_status,
        ${PT_INCOME_TYPE_CASE} AS income_type,
        ${PT_ORIGINAL_INCOME_TYPE_CASE} AS original_income_type,
        ${PT_AMOUNT_CASE} AS amount
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      LEFT JOIN (${bdlSubquery}) AS bdl ON bdl.contract_no = pt.contract_no AND bdl.section = pt.section
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
    originalIncomeType: (r.original_income_type === 'ปิดยอด' ? 'ปิดยอด' : 'ค่างวด') as "ค่างวด" | "ปิดยอด",
    receiptNo: r.receipt_no ?? null,
    contractStatus: r.contract_status ?? null,
    amount: Number(r.amount ?? 0),
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ?? null,
  }));

  return { rows, total };
}

export async function listIncomeUpdatedBy(
  section: SectionKey,
  opts?: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    dateField?: "paidAt" | "updatedAt";
    incomeTypes?: IncomeType[];
  }
): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);

  // ถ้าไม่มี filter เพิ่มเติม ใช้ query เร็ว (ไม่ต้อง JOIN)
  if (!opts?.search && !opts?.dateFrom && !opts?.dateTo && (!opts?.incomeTypes || opts.incomeTypes.length === 0)) {
    const result = await db.execute(
      sql.raw(`
        SELECT DISTINCT updated_by
        FROM payment_transactions
        WHERE section = '${secEsc}'
          AND JSON_EXTRACT(raw_json, '$.source') IS NULL
          AND updated_by IS NOT NULL AND updated_by != ''
        ORDER BY updated_by ASC
      `),
    );
    const arr: any[] = (result as any)[0] ?? result;
    return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
  }

  // มี filter เพิ่มเติม — ต้อง JOIN contracts + bad_debt_last_days เพื่อ filter income_type
  const { search, dateFrom, dateTo, dateField = "paidAt", incomeTypes } = opts ?? {};
  const dateCol = dateField === "paidAt" ? "pt.paid_at" : "pt.updated_at";
  const bdlSubquery = buildBadDebtLastDaysSubquery(secEsc);

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    PT_INCOME_BASE_WHERE,
  ];
  // ค้นหาจาก รหัสรายการ (receipt_no) หรือ เลขที่สัญญา (contract_no) เท่านั้น
  if (search) conditions.push(`(pt.receipt_no LIKE '%${esc(search)}%' OR pt.contract_no LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);

  let incomeTypeCondition = "";
  if (incomeTypes && incomeTypes.length > 0) {
    const quoted = incomeTypes.map((t) => `'${esc(t)}'`).join(", ");
    incomeTypeCondition = `AND income_type IN (${quoted})`;
  }

  const whereStr = conditions.join(" AND ");
  const querySql = `
    SELECT DISTINCT updated_by
    FROM (
      SELECT
        pt.updated_by AS updated_by,
        ${PT_INCOME_TYPE_CASE} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      LEFT JOIN (${bdlSubquery}) AS bdl ON bdl.contract_no = pt.contract_no AND bdl.section = pt.section
      WHERE ${whereStr}
        AND pt.updated_by IS NOT NULL AND pt.updated_by != ''
    ) AS filtered
    WHERE 1=1 ${incomeTypeCondition}
    ORDER BY updated_by ASC
  `;

  const result = await db.execute(sql.raw(querySql));
  const arr: any[] = (result as any)[0] ?? result;
  return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
}

// ─── Expense ──────────────────────────────────────────────────────────────────

export async function listExpense(params: ExpenseParams): Promise<{
  rows: ExpenseRow[];
  total: number;
}> {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };

  const {
    section, search, dateFrom, dateTo, updatedBy,
    page = 1, pageSize = 50,
  } = params;
  const offset = (page - 1) * pageSize;
  const esc = (v: string) => v.replace(/'/g, "''");
  const conditions: string[] = [
    `c.section = '${esc(section)}'`,
    `c.commission_net IS NOT NULL`,
    `c.commission_net > 0`,
  ];
  if (search) conditions.push(`c.contract_no LIKE '%${esc(search)}%'`);
  if (dateFrom) conditions.push(`c.approve_date >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`c.approve_date <= '${esc(dateTo)}'`);
  if (updatedBy) conditions.push(`latest_i.updated_by = '${esc(updatedBy)}'`);
  const whereStr = conditions.join(" AND ");

  const joinSql = `
    FROM contracts c
    LEFT JOIN (
      SELECT contract_no, section, updated_by, updated_at
      FROM installments
      WHERE (contract_no, section, updated_at) IN (
        SELECT contract_no, section, MAX(updated_at)
        FROM installments
        WHERE updated_by IS NOT NULL AND updated_by != ''
        GROUP BY contract_no, section
      )
    ) AS latest_i ON latest_i.contract_no = c.contract_no AND latest_i.section = c.section
  `;
  const [countResult, dataResult] = await Promise.all([
    db.execute(sql.raw(`SELECT COUNT(*) AS total ${joinSql} WHERE ${whereStr}`)),
    db.execute(sql.raw(`
      SELECT c.id, c.contract_no, c.approve_date, c.commission_net, c.partner_code, c.partner_name,
             latest_i.updated_by, latest_i.updated_at
      ${joinSql}
      WHERE ${whereStr}
      ORDER BY c.approve_date DESC, c.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `)),
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
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ?? null,
  }));
  return { rows, total };
}

export async function listExpenseUpdatedBy(section: SectionKey): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const esc = (v: string) => v.replace(/'/g, "''");
  const result = await db.execute(
    sql.raw(`
      SELECT DISTINCT i.updated_by
      FROM installments i
      INNER JOIN contracts c ON c.contract_no = i.contract_no AND c.section = i.section
      WHERE c.section = '${esc(section)}'
        AND c.commission_net IS NOT NULL AND c.commission_net > 0
        AND i.updated_by IS NOT NULL AND i.updated_by != ''
      ORDER BY i.updated_by ASC
    `),
  );
  const arr: any[] = (result as any)[0] ?? result;
  return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
}

// ─── Summary (Badge sums) ─────────────────────────────────────────────────────

export interface IncomeSummary {
  "ค่างวด": number;
  "ขายเครื่อง": number;
  "ปิดยอด": number;
  "เงินดาวน์": number;
  total: number;
}

export async function getIncomeSummary(
  params: Omit<IncomeParams, "page" | "pageSize">,
): Promise<IncomeSummary> {
  const db = await getDb();
  if (!db) return { "ค่างวด": 0, "ขายเครื่อง": 0, "ปิดยอด": 0, "เงินดาวน์": 0, total: 0 };

  const {
    section, search, dateFrom, dateTo,
    dateField = "paidAt", incomeTypes, updatedBy,
  } = params;

  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);
  const dateCol = dateField === "paidAt" ? "pt.paid_at" : "pt.updated_at";

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    PT_INCOME_BASE_WHERE,
  ];
  // ค้นหาจาก รหัสรายการ (receipt_no) หรือ เลขที่สัญญา (contract_no) เท่านั้น
  if (search) conditions.push(`(pt.receipt_no LIKE '%${esc(search)}%' OR pt.contract_no LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);
  if (updatedBy) conditions.push(`pt.updated_by = '${esc(updatedBy)}'`);

  let incomeTypeFilter = "";
  if (incomeTypes && incomeTypes.length > 0) {
    const quoted = incomeTypes.map((t) => `'${esc(t)}'`).join(", ");
    incomeTypeFilter = `WHERE income_type IN (${quoted})`;
  }

  const whereStr = conditions.join(" AND ");
  const bdlSubquery = buildBadDebtLastDaysSubquery(secEsc);

  const querySql = `
    SELECT income_type, SUM(amount) AS sum_amount
    FROM (
      SELECT
        ${PT_INCOME_TYPE_CASE} AS income_type,
        ${PT_AMOUNT_CASE} AS amount
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      LEFT JOIN (${bdlSubquery}) AS bdl ON bdl.contract_no = pt.contract_no AND bdl.section = pt.section
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

// ─── Income Summary (Yearly / Monthly) ────────────────────────────────────────

export interface IncomeSummaryRow {
  period: string;
  "ค่างวด": number;
  "ปิดยอด": number;
  "ขายเครื่อง": number;
  total: number;
}

export interface IncomeSummaryParams {
  section: SectionKey;
  groupBy: "year" | "month";
  years?: number[];
  months?: number[];
}

/**
 * คำนวณยอดรายรับแยกตาม period (year/month)
 * ดึงจาก payment_transactions (source IS NULL) — ตรงกับ Fastfone/Boonphone Report เป๊ะ
 *
 * Logic แยกประเภท:
 * - ขายเครื่อง = payment ในวันสุดท้ายของสัญญาหนี้เสีย
 *                (c.status = 'หนี้เสีย' AND DATE(pt.paid_at) = last_paid_date ของสัญญานั้น)
 * - ปิดยอด     = มี close_installment_amount > 0 ใน raw_json
 * - ค่างวด     = อื่นๆ
 *
 * ยอดของแต่ละ row = pt.amount เสมอ → รวมกัน = total = ตรงกับ Report ระบบ
 */
export async function getIncomeSummaryByPeriod(
  params: IncomeSummaryParams,
): Promise<IncomeSummaryRow[]> {
  const db = await getDb();
  if (!db) return [];
  const { section, groupBy, years, months } = params;
  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    `JSON_EXTRACT(pt.raw_json, '$.source') IS NULL`,
    `pt.paid_at IS NOT NULL`,
    `pt.paid_at != ''`,
  ];
  if (years && years.length > 0) {
    conditions.push(`SUBSTRING(pt.paid_at, 1, 4) IN (${years.map(y => "'" + y + "'").join(",")})`);
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(pt.paid_at, 6, 2) IN (${months.map(m => "'" + String(m).padStart(2,'0') + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");
  const periodLen = groupBy === "year" ? 4 : 7;

  // Subquery: หาวันสุดท้ายที่ชำระของแต่ละสัญญาหนี้เสีย
  const bdlSubquery = buildBadDebtLastDaysSubquery(secEsc);

  const querySql = `
    SELECT
      period,
      SUM(CASE WHEN income_type = 'ค่างวด'     THEN amt ELSE 0 END) AS kw,
      SUM(CASE WHEN income_type = 'ปิดยอด'     THEN amt ELSE 0 END) AS close_sum,
      SUM(CASE WHEN income_type = 'ขายเครื่อง' THEN amt ELSE 0 END) AS bad_debt_sum
    FROM (
      SELECT
        SUBSTRING(pt.paid_at, 1, ${periodLen}) AS period,
        CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2)) AS amt,
        CASE
          -- ขายเครื่อง: สัญญาหนี้เสีย + batch สุดท้าย (ใช้ logic เดียวกับ PT_INCOME_TYPE_CASE)
          WHEN c.status = 'หนี้เสีย'
            AND bdl.last_paid_date IS NOT NULL
            AND DATE(pt.paid_at) = bdl.last_paid_date
            AND bdl.last_created_at IS NOT NULL
            AND DATE(pt.created_at) = DATE(bdl.last_created_at)
            AND (bdl.last_updated_by IS NULL OR pt.updated_by = bdl.last_updated_by)
            THEN 'ขายเครื่อง'
          -- ปิดยอด: สัญญาสิ้นสุดสัญญา/สำเร็จ + batch สุดท้าย (ใช้ logic เดียวกับ PT_INCOME_TYPE_CASE)
          WHEN c.status IN ('สิ้นสุดสัญญา', 'สำเร็จ')
            AND bdl.last_paid_date IS NOT NULL
            AND DATE(pt.paid_at) = bdl.last_paid_date
            AND bdl.last_created_at IS NOT NULL
            AND DATE(pt.created_at) = DATE(bdl.last_created_at)
            AND (bdl.last_updated_by IS NULL OR pt.updated_by = bdl.last_updated_by)
            THEN 'ปิดยอด'
          ELSE 'ค่างวด'
        END AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      LEFT JOIN (${bdlSubquery}) AS bdl ON bdl.contract_no = pt.contract_no AND bdl.section = pt.section
      WHERE ${whereStr}
    ) AS sub
    GROUP BY period
    ORDER BY period ASC
  `;

  const result = await db.execute(sql.raw(querySql));
  const arr: any[] = (result as any)[0] ?? result;
  return (arr ?? []).map((r: any) => {
    const kw = Number(r.kw ?? 0);
    const close = Number(r.close_sum ?? 0);
    const sell = Number(r.bad_debt_sum ?? 0);
    return {
      period: r.period ?? "",
      "ค่างวด": kw,
      "ปิดยอด": close,
      "ขายเครื่อง": sell,
      total: kw + close + sell,
    };
  });
}

// ─── Expense Summary (Yearly / Monthly) ───────────────────────────────────────

export interface ExpenseSummaryRow {
  period: string;
  "ค่าคอมมิชชั่น": number;
  total: number;
}

export interface ExpenseSummaryParams {
  section: SectionKey;
  groupBy: "year" | "month";
  years?: number[];
  months?: number[];
}

export async function getExpenseSummaryByPeriod(
  params: ExpenseSummaryParams,
): Promise<ExpenseSummaryRow[]> {
  const db = await getDb();
  if (!db) return [];
  const { section, groupBy, years, months } = params;
  const esc = (v: string) => v.replace(/'/g, "''");

  const conditions: string[] = [
    `c.section = '${esc(section)}'`,
    `c.commission_net IS NOT NULL`,
    `c.commission_net > 0`,
    `c.approve_date IS NOT NULL`,
  ];
  if (years && years.length > 0) {
    conditions.push(`SUBSTRING(c.approve_date, 1, 4) IN (${years.map(y => "'" + y + "'").join(",")})`);
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(c.approve_date, 6, 2) IN (${months.map(m => "'" + String(m).padStart(2,'0') + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");

  const periodExpr =
    groupBy === "year"
      ? `SUBSTRING(c.approve_date, 1, 4)`
      : `SUBSTRING(c.approve_date, 1, 7)`;

  const querySql = `
    SELECT
      ${periodExpr} AS period,
      SUM(COALESCE(c.commission_net, 0)) AS comm
    FROM contracts c
    WHERE ${whereStr} AND c.approve_date != ''
    GROUP BY ${periodExpr}
    ORDER BY ${periodExpr} ASC
  `;

  const result = await db.execute(sql.raw(querySql));
  const arr: any[] = (result as any)[0] ?? result;
  return (arr ?? []).map((r: any) => {
    const comm = Number(r.comm ?? 0);
    return {
      period: r.period ?? "",
      "ค่าคอมมิชชั่น": comm,
      total: comm,
    };
  });
}

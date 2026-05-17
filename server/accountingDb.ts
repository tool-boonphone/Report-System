/**
 * accountingDb.ts — Query helpers สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 *
 * รายรับ (Income):
 *   - ดึงจาก payment_transactions WHERE (raw_json::jsonb->>'source') IS NULL
 *     (เฉพาะ close rows ที่มี principal_paid, interest_paid ฯลฯ ครบถ้วน)
 *   - ยอดรวม = payment_transactions.amount ตรงกับ Fastfone/Boonphone Report เป๊ะ
 *   - แยกประเภทตาม logic:
 *       ขายเครื่อง = payment ในวันสุดท้ายของสัญญาที่มีสถานะ 'หนี้เสีย'
 *                    (c.status = 'หนี้เสีย' AND DATE(pt.created_at) = last created date ของสัญญานั้น)
 *       ปิดยอด     = receipt_no ขึ้นต้นด้วย 'TXRTC'
 *       ค่างวด     = payment ปกติที่ไม่ใช่สองประเภทข้างต้น
 *   - ยอดของแต่ละประเภท = pt.amount (ไม่ต้องแยกย่อย เพราะ 1 row = 1 payment)
 *   - ค่างวด + ปิดยอด + ขายเครื่อง = total = ตรงกับ Fastfone/Boonphone Report เป๊ะ
 *
 * รายจ่าย (Expense):
 *   - ดึงจาก contracts.commission_net (ค่าคอมมิชชั่น)
 *
 * ─── การปรับปรุง (v3) ────────────────────────────────────────────────────────
 * เปลี่ยนจาก 2-step approach (fetchBatchKeyMap + buildIncomeCaseFromMap) ที่สร้าง
 * CASE expression ขนาดใหญ่มาก เป็น single SQL query ด้วย CTE:
 *
 *   WITH bad_debt_last AS (
 *     -- หา MAX(created_at) ของแต่ละสัญญาหนี้เสีย
 *     SELECT contract_no, MAX(DATE(created_at)) AS last_created_date
 *     FROM payment_transactions
 *     WHERE section = $sec AND source IS NULL
 *     GROUP BY contract_no
 *     -- เฉพาะสัญญาที่ status = 'หนี้เสีย' (JOIN กับ contracts)
 *   )
 *   SELECT ...,
 *     CASE
 *       WHEN pt.receipt_no LIKE 'TXRTC%' THEN 'ปิดยอด'
 *       WHEN c.status = 'หนี้เสีย'
 *            AND DATE(pt.created_at) = bdl.last_created_date THEN 'ขายเครื่อง'
 *       ELSE 'ค่างวด'
 *     END AS income_type
 *   FROM payment_transactions pt
 *   LEFT JOIN contracts c ON ...
 *   LEFT JOIN bad_debt_last bdl ON bdl.contract_no = pt.contract_no
 *
 * ข้อดี: ไม่ต้อง fetch ข้อมูลมา JS แล้วสร้าง CASE ขนาดใหญ่ → เร็วขึ้นมาก
 */
import { sql } from "drizzle-orm";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";
import { pgRows } from "./db";

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
  /** createdAt = วันที่บันทึกรายการ (DATE ใช้เป็น batch key ระดับ 2 สำหรับขายเครื่อง) */
  createdAt: string | null;
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

// ─── SQL Constants ────────────────────────────────────────────────────────────

/**
 * Original income type CASE expression — type ตาม API จริงๆ
 * ไม่มี ขายเครื่อง เพราะ API ส่งมาแค่ ค่างวด และ ปิดยอด
 *
 * ปิดยอด = receipt_no ขึ้นต้นด้วย 'TXRTC'
 * ค่างวด = อื่นๆ
 */
const PT_ORIGINAL_INCOME_TYPE_CASE = `
  CASE
    WHEN pt.receipt_no LIKE 'TXRTC%'
      THEN 'ปิดยอด'
    ELSE 'ค่างวด'
  END
`;

/** Amount CASE expression — ยอดของแต่ละ row = pt.amount เสมอ */
const PT_AMOUNT_CASE = `CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2))`;

/** Base WHERE: เฉพาะ close rows (source IS NULL) ที่ตรงกับ Fastfone/Boonphone Report
 * Fastfone365 ไม่มี source field เลย → ใช้ TRUE เพื่อข้าม jsonb cast ที่ช้า
 */
function ptIncomeBaseWhere(secEsc: string): string {
  if (secEsc === 'Fastfone365') return 'TRUE';
  return `(pt.raw_json::jsonb->>'source') IS NULL`;
}
// compat alias สำหรับ Boonphone (default)
const PT_INCOME_BASE_WHERE = `(pt.raw_json::jsonb->>'source') IS NULL`;

// ─── CTE-based Income Type CASE ───────────────────────────────────────────────

/**
 * สร้าง CTE + CASE expression สำหรับ classify income_type
 * ใช้ single SQL query แทน 2-step approach เดิม
 *
 * CTE: bad_debt_last — หา MAX(DATE(created_at)) ของแต่ละสัญญาหนี้เสีย
 * CASE:
 *   ปิดยอด     = receipt_no LIKE 'TXRTC%'
 *   ขายเครื่อง = c.status = 'หนี้เสีย' AND DATE(pt.created_at) = bdl.last_created_date
 *   ค่างวด     = อื่นๆ
 *
 * @param secEsc - section name (escaped)
 * @returns { cte, incomeTypeCase, joinClause }
 */
function buildIncomeCTE(secEsc: string): {
  cte: string;
  incomeTypeCase: string;
  joinClause: string;
} {
  const sourceWhere = ptIncomeBaseWhere(secEsc);
  const cte = `
    bad_debt_last AS (
      SELECT
        pt2.contract_no,
        MAX(DATE(pt2.created_at)) AS last_created_date
      FROM payment_transactions pt2
      INNER JOIN contracts c2
        ON c2.contract_no = pt2.contract_no AND c2.section = pt2.section
      WHERE pt2.section = '${secEsc}'
        AND ${sourceWhere}
        AND c2.status = 'หนี้เสีย'
      GROUP BY pt2.contract_no
    )
  `;

  const incomeTypeCase = `
    CASE
      WHEN pt.receipt_no LIKE 'TXRTC%'
        THEN 'ปิดยอด'
      WHEN c.status = 'หนี้เสีย'
        AND bdl.last_created_date IS NOT NULL
        AND DATE(pt.created_at) = bdl.last_created_date
        THEN 'ขายเครื่อง'
      ELSE 'ค่างวด'
    END
  `;

  const joinClause = `LEFT JOIN bad_debt_last bdl ON bdl.contract_no = pt.contract_no`;

  return { cte, incomeTypeCase, joinClause };
}

// ─── Income ───────────────────────────────────────────────────────────────────

export async function listIncome(params: IncomeParams): Promise<{
  rows: IncomeRow[];
  total: number;
}> {
  const db = await getDb(params.section);
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
    ptIncomeBaseWhere(secEsc),
  ];
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
  const { cte, incomeTypeCase, joinClause } = buildIncomeCTE(secEsc);

  const countSql = `
    WITH ${cte}
    SELECT COUNT(*) AS total
    FROM (
      SELECT ${incomeTypeCase} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      ${joinClause}
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
  `;

  const dataSql = `
    WITH ${cte}
    SELECT *
    FROM (
      SELECT
        pt.id,
        pt.contract_no,
        c.customer_name,
        pt.paid_at,
        pt.updated_by,
        pt.updated_at,
        pt.created_at,
        pt.receipt_no,
        c.status AS contract_status,
        ${incomeTypeCase} AS income_type,
        ${PT_ORIGINAL_INCOME_TYPE_CASE} AS original_income_type,
        ${PT_AMOUNT_CASE} AS amount
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      ${joinClause}
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

  const countArr: any[] = pgRows(countResult);
  const total = Number(countArr[0]?.total ?? 0);
  const dataArr: any[] = pgRows(dataResult);

  const rows: IncomeRow[] = (dataArr ?? []).map((r: any) => ({
    id: Number(r.id),
    contractNo: r.contract_no ?? "",
    customerName: r.customer_name ?? null,
    paidAt: r.paid_at ?? null,
    incomeType: r.income_type as IncomeType,
    originalIncomeType: (r.original_income_type === "ปิดยอด" ? "ปิดยอด" : "ค่างวด") as "ค่างวด" | "ปิดยอด",
    receiptNo: r.receipt_no ?? null,
    contractStatus: r.contract_status ?? null,
    amount: Number(r.amount ?? 0),
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ?? null,
    createdAt: r.created_at ?? null,
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
  },
): Promise<string[]> {
  const db = await getDb(section);
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
          AND ${ptIncomeBaseWhere(secEsc)}
          AND updated_by IS NOT NULL AND updated_by != ''
        ORDER BY updated_by ASC
      `),
    );
    const arr: any[] = pgRows(result);
    return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
  }

  // มี filter เพิ่มเติม — ต้อง JOIN contracts + CTE
  const { search, dateFrom, dateTo, dateField = "paidAt", incomeTypes } = opts ?? {};
  const dateCol = dateField === "paidAt" ? "pt.paid_at" : "pt.updated_at";

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    ptIncomeBaseWhere(secEsc),
  ];
  if (search) conditions.push(`(pt.receipt_no LIKE '%${esc(search)}%' OR pt.contract_no LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dateCol} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dateCol} <= '${esc(dateTo)} 23:59:59'`);

  let incomeTypeCondition = "";
  if (incomeTypes && incomeTypes.length > 0) {
    const quoted = incomeTypes.map((t) => `'${esc(t)}'`).join(", ");
    incomeTypeCondition = `AND income_type IN (${quoted})`;
  }

  const whereStr = conditions.join(" AND ");
  const { cte, incomeTypeCase, joinClause } = buildIncomeCTE(secEsc);

  const querySql = `
    WITH ${cte}
    SELECT DISTINCT updated_by
    FROM (
      SELECT
        pt.updated_by AS updated_by,
        ${incomeTypeCase} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      ${joinClause}
      WHERE ${whereStr}
        AND pt.updated_by IS NOT NULL AND pt.updated_by != ''
    ) AS filtered
    WHERE 1=1 ${incomeTypeCondition}
    ORDER BY updated_by ASC
  `;

  const result = await db.execute(sql.raw(querySql));
  const arr: any[] = pgRows(result);
  return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
}

// ─── Expense ──────────────────────────────────────────────────────────────────

export async function listExpense(params: ExpenseParams): Promise<{
  rows: ExpenseRow[];
  total: number;
}> {
  const db = await getDb(params.section);
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

  const countArr: any[] = pgRows(countResult);
  const total = Number(countArr[0]?.total ?? 0);
  const dataArr: any[] = pgRows(dataResult);

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
  const db = await getDb(section);
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
  const arr: any[] = pgRows(result);
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
  const db = await getDb(params.section);
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
    ptIncomeBaseWhere(secEsc),
  ];
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
  const { cte, incomeTypeCase, joinClause } = buildIncomeCTE(secEsc);

  const querySql = `
    WITH ${cte}
    SELECT income_type, SUM(amount) AS sum_amount
    FROM (
      SELECT
        ${incomeTypeCase} AS income_type,
        ${PT_AMOUNT_CASE} AS amount
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      ${joinClause}
      WHERE ${whereStr}
    ) AS sub
    ${incomeTypeFilter}
    GROUP BY 1
  `;

  const result = await db.execute(sql.raw(querySql));
  const rows: any[] = pgRows(result);

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
  const db = await getDb(params.section);
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
  const arr: any[] = pgRows(result);
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
 * Query จาก income_monthly_summary table (pre-aggregated) เพื่อความเร็ว
 * ถ้า summary table ยังไม่มีข้อมูล (empty) จะ fallback ไป query จาก payment_transactions โดยตรง
 */
export async function getIncomeSummaryByPeriod(
  params: IncomeSummaryParams,
): Promise<IncomeSummaryRow[]> {
  const db = await getDb(params.section);
  if (!db) return [];

  const { section, groupBy, years, months } = params;
  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);

  // ตรวจว่า summary table มีข้อมูลหรือเปล่า
  const checkResult = await db.execute(sql.raw(
    `SELECT COUNT(*) AS cnt FROM income_monthly_summary WHERE section = '${secEsc}'`
  ));
  const summaryCount = Number((pgRows(checkResult)[0] as any)?.cnt ?? 0);

  if (summaryCount > 0) {
    // ── Fast path: query จาก income_monthly_summary ──────────────────────────────────────
    const conditions: string[] = [`section = '${secEsc}'`];
    if (years && years.length > 0) {
      conditions.push(`year IN (${years.join(",")})`);
    }
    if (months && months.length > 0) {
      conditions.push(`month IN (${months.join(",")})`);
    }
    const whereStr = conditions.join(" AND ");

    const periodExpr = groupBy === "year"
      ? `year::text`
      : `LPAD(year::text, 4, '0') || '-' || LPAD(month::text, 2, '0')`;

    const querySql = `
      SELECT
        ${periodExpr} AS period,
        SUM(CASE WHEN income_type = 'ค่างวด'     THEN total_amount ELSE 0 END) AS kw,
        SUM(CASE WHEN income_type = 'ปิดยอด'     THEN total_amount ELSE 0 END) AS close_sum,
        SUM(CASE WHEN income_type = 'ขายเครื่อง' THEN total_amount ELSE 0 END) AS bad_debt_sum
      FROM income_monthly_summary
      WHERE ${whereStr}
      GROUP BY ${periodExpr}
      ORDER BY ${periodExpr} ASC
    `;

    const result = await db.execute(sql.raw(querySql));
    const arr: any[] = pgRows(result);

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

  // ── Fallback: query จาก payment_transactions โดยตรง (summary ยังไม่ถูก build) ──────
  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    ptIncomeBaseWhere(secEsc),
    `pt.paid_at IS NOT NULL`,
  ];
  if (years && years.length > 0) {
    conditions.push(`LEFT(pt.paid_at::text, 4) IN (${years.map((y) => "'" + y + "'").join(",")})`);
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(pt.paid_at::text, 6, 2) IN (${months.map((m) => "'" + String(m).padStart(2, "0") + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");
  const periodLen = groupBy === "year" ? 4 : 7;

  const { cte, incomeTypeCase, joinClause } = buildIncomeCTE(secEsc);

  const querySql = `
    WITH ${cte}
    SELECT
      period,
      SUM(CASE WHEN income_type = 'ค่างวด'     THEN amt ELSE 0 END) AS kw,
      SUM(CASE WHEN income_type = 'ปิดยอด'     THEN amt ELSE 0 END) AS close_sum,
      SUM(CASE WHEN income_type = 'ขายเครื่อง' THEN amt ELSE 0 END) AS bad_debt_sum
    FROM (
      SELECT
        LEFT(pt.paid_at::text, ${periodLen}) AS period,
        CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2)) AS amt,
        ${incomeTypeCase} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      ${joinClause}
      WHERE ${whereStr}
    ) AS sub
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  const result = await db.execute(sql.raw(querySql));
  const arr: any[] = pgRows(result);

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
  const db = await getDb(params.section);
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
    conditions.push(`LEFT(c.approve_date::text, 4) IN (${years.map((y) => "'" + y + "'").join(",")})`);
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(c.approve_date::text, 6, 2) IN (${months.map((m) => "'" + String(m).padStart(2, "0") + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");

  const periodExpr =
    groupBy === "year"
      ? `LEFT(c.approve_date::text, 4)`
      : `LEFT(c.approve_date::text, 7)`;

  const querySql = `
    SELECT
      ${periodExpr} AS period,
      SUM(COALESCE(c.commission_net, 0)) AS comm
    FROM contracts c
    WHERE ${whereStr}
    GROUP BY ${periodExpr}
    ORDER BY ${periodExpr} ASC
  `;

  const result = await db.execute(sql.raw(querySql));
  const arr: any[] = pgRows(result);

  return (arr ?? []).map((r: any) => {
    const comm = Number(r.comm ?? 0);
    return {
      period: r.period ?? "",
      "ค่าคอมมิชชั่น": comm,
      total: comm,
    };
  });
}

// ─── Finance (ยอดจัดไฟแนนซ์) ──────────────────────────────────────────────────

export interface FinanceRow {
  id: number;
  contractNo: string;
  customerName: string | null;
  approveDate: string | null;
  financeAmount: number;
  productType: string | null;
  partnerCode: string | null;
  partnerName: string | null;
}

export interface FinanceParams {
  section: SectionKey;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface FinanceSummaryRow {
  period: string;
  "ยอดจัดไฟแนนซ์": number;
  total: number;
}

export interface FinanceSummaryParams {
  section: SectionKey;
  groupBy: "year" | "month";
  years?: number[];
  months?: number[];
}

/** ดึงรายการยอดจัดไฟแนนซ์ (finance_amount) จาก contracts */
export async function listFinance(params: FinanceParams): Promise<{ rows: FinanceRow[]; total: number }> {
  const db = await getDb(params.section);
  if (!db) return { rows: [], total: 0 };

  const { section, search, dateFrom, dateTo, page = 1, pageSize = 50 } = params;
  const offset = (page - 1) * pageSize;
  const esc = (v: string) => v.replace(/'/g, "''");
  const conditions: string[] = [
    `c.section = '${esc(section)}'`,
    `c.finance_amount IS NOT NULL`,
    `c.finance_amount > 0`,
  ];
  if (search) conditions.push(`(c.contract_no LIKE '%${esc(search)}%' OR c.customer_name LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`c.approve_date >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`c.approve_date <= '${esc(dateTo)}'`);
  const whereStr = conditions.join(" AND ");

  const [countResult, dataResult] = await Promise.all([
    db.execute(sql.raw(`SELECT COUNT(*) AS total FROM contracts c WHERE ${whereStr}`)),
    db.execute(sql.raw(`
      SELECT c.id, c.contract_no, c.customer_name, c.approve_date,
             c.finance_amount, c.product_type, c.partner_code, c.partner_name
      FROM contracts c
      WHERE ${whereStr}
      ORDER BY c.approve_date DESC, c.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `)),
  ]);

  const countArr: any[] = pgRows(countResult);
  const total = Number(countArr[0]?.total ?? 0);
  const dataArr: any[] = pgRows(dataResult);

  const rows: FinanceRow[] = (dataArr ?? []).map((r: any) => ({
    id: Number(r.id),
    contractNo: r.contract_no ?? "",
    customerName: r.customer_name ?? null,
    approveDate: r.approve_date ?? null,
    financeAmount: Number(r.finance_amount ?? 0),
    productType: r.product_type ?? null,
    partnerCode: r.partner_code ?? null,
    partnerName: r.partner_name ?? null,
  }));

  return { rows, total };
}

/** สรุปยอดจัดไฟแนนซ์แยกตามปี หรือ เดือน */
export async function getFinanceSummaryByPeriod(params: FinanceSummaryParams): Promise<FinanceSummaryRow[]> {
  const db = await getDb(params.section);
  if (!db) return [];

  const { section, groupBy, years, months } = params;
  const esc = (v: string) => v.replace(/'/g, "''");
  const conditions: string[] = [
    `c.section = '${esc(section)}'`,
    `c.finance_amount IS NOT NULL`,
    `c.finance_amount > 0`,
    `c.approve_date IS NOT NULL`,
  ];
  if (years && years.length > 0) {
    conditions.push(`LEFT(c.approve_date::text, 4) IN (${years.map((y) => "'" + y + "'").join(",")})`)
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(c.approve_date::text, 6, 2) IN (${months.map((m) => "'" + String(m).padStart(2, "0") + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");
  const periodExpr =
    groupBy === "year"
      ? `LEFT(c.approve_date::text, 4)`
      : `LEFT(c.approve_date::text, 7)`;

  const result = await db.execute(sql.raw(`
    SELECT ${periodExpr} AS period, SUM(COALESCE(c.finance_amount, 0)) AS fin
    FROM contracts c
    WHERE ${whereStr}
    GROUP BY ${periodExpr}
    ORDER BY ${periodExpr} ASC
  `));

  const arr: any[] = pgRows(result);
  return (arr ?? []).map((r: any) => {
    const fin = Number(r.fin ?? 0);
    return { period: r.period ?? "", "ยอดจัดไฟแนนซ์": fin, total: fin };
  });
}

// ─── Commissions (จาก tb commissions) ────────────────────────────────────────

export interface CommissionRow {
  id: number;
  externalId: string | null;
  contractNo: string;
  approvedAt: string | null;
  paymentAt: string | null;
  paymentStatus: string | null;
  paymentBy: string | null;
  memberName: string | null;
  memberTel: string | null;
  productName: string | null;
  financeAmount: number;
  commAmount: number;
  incentive: number;
  totalTransfer: number;
}

export interface CommissionParams {
  section: SectionKey;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** "paymentAt" (default) หรือ "approvedAt" */
  dateField?: "paymentAt" | "approvedAt";
  page?: number;
  pageSize?: number;
}

export interface CommissionSummary {
  financeAmount: number;
  commAmount: number;
  incentive: number;
  totalTransfer: number;
  total: number;
}

export interface CommissionSummaryRow {
  period: string;
  financeAmount: number;
  commAmount: number;
  incentive: number;
  totalTransfer: number;
}

export interface CommissionSummaryParams {
  section: SectionKey;
  groupBy: "year" | "month";
  years?: number[];
  months?: number[];
}

const PAID_STATUS = "'ชำระแล้ว'";

/** ดึงรายการ commissions (เฉพาะสถานะ ชำระแล้ว) พร้อม pagination */
export async function listCommissions(params: CommissionParams): Promise<{
  rows: CommissionRow[];
  total: number;
}> {
  const db = await getDb(params.section);
  if (!db) return { rows: [], total: 0 };

  const {
    section, search, dateFrom, dateTo,
    dateField = "paymentAt",
    page = 1, pageSize = 50,
  } = params;
  const offset = (page - 1) * pageSize;
  const esc = (v: string) => v.replace(/'/g, "''");

  const dbDateField = dateField === "approvedAt" ? "approved_at" : "payment_at";

  const conditions: string[] = [
    `section = '${esc(section)}'`,
    `payment_status = ${PAID_STATUS}`,
  ];
  if (search) conditions.push(`(contract_no LIKE '%${esc(search)}%' OR member_name LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dbDateField} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dbDateField} <= '${esc(dateTo)} 23:59:59'`);
  const whereStr = conditions.join(" AND ");

  const [countResult, dataResult] = await Promise.all([
    db.execute(sql.raw(`SELECT COUNT(*) AS total FROM commissions WHERE ${whereStr}`)),
    db.execute(sql.raw(`
      SELECT id, external_id, contract_no, approved_at, payment_at, payment_status,
             payment_by, member_name, member_tel, product_name,
             finance_amount, comm_amount, incentive, total_transfer
      FROM commissions
      WHERE ${whereStr}
      ORDER BY ${dbDateField} DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `)),
  ]);

  const total = Number((pgRows(countResult)[0] as any)?.total ?? 0);
  const rows: CommissionRow[] = (pgRows(dataResult) as any[]).map((r) => ({
    id: Number(r.id),
    externalId: r.external_id ?? null,
    contractNo: r.contract_no ?? "",
    approvedAt: r.approved_at ?? null,
    paymentAt: r.payment_at ?? null,
    paymentStatus: r.payment_status ?? null,
    paymentBy: r.payment_by ?? null,
    memberName: r.member_name ?? null,
    memberTel: r.member_tel ?? null,
    productName: r.product_name ?? null,
    financeAmount: Number(r.finance_amount ?? 0),
    commAmount: Number(r.comm_amount ?? 0),
    incentive: Number(r.incentive ?? 0),
    totalTransfer: Number(r.total_transfer ?? 0),
  }));

  return { rows, total };
}

/** คำนวณ SUM badge ของ commissions (เฉพาะสถานะ ชำระแล้ว) */
export async function getCommissionSummary(
  params: Omit<CommissionParams, "page" | "pageSize">,
): Promise<CommissionSummary> {
  const db = await getDb(params.section);
  if (!db) return { financeAmount: 0, commAmount: 0, incentive: 0, totalTransfer: 0, total: 0 };

  const { section, search, dateFrom, dateTo, dateField = "paymentAt" } = params;
  const esc = (v: string) => v.replace(/'/g, "''");
  const dbDateField = dateField === "approvedAt" ? "approved_at" : "payment_at";

  const conditions: string[] = [
    `section = '${esc(section)}'`,
    `payment_status = ${PAID_STATUS}`,
  ];
  if (search) conditions.push(`(contract_no LIKE '%${esc(search)}%' OR member_name LIKE '%${esc(search)}%')`);
  if (dateFrom) conditions.push(`${dbDateField} >= '${esc(dateFrom)}'`);
  if (dateTo) conditions.push(`${dbDateField} <= '${esc(dateTo)} 23:59:59'`);
  const whereStr = conditions.join(" AND ");

  const result = await db.execute(sql.raw(`
    SELECT
      SUM(COALESCE(finance_amount, 0)) AS fin,
      SUM(COALESCE(comm_amount, 0)) AS comm,
      SUM(COALESCE(incentive, 0)) AS inc,
      SUM(COALESCE(total_transfer, 0)) AS tot
    FROM commissions
    WHERE ${whereStr}
  `));
  const r = (pgRows(result)[0] as any) ?? {};
  const fin = Number(r.fin ?? 0);
  const comm = Number(r.comm ?? 0);
  const inc = Number(r.inc ?? 0);
  const tot = Number(r.tot ?? 0);
  return { financeAmount: fin, commAmount: comm, incentive: inc, totalTransfer: tot, total: tot };
}

/**
 * สรุป commissions แยกตาม period (year/month)
 * ยึดจาก payment_at เป็นหลัก (วันที่โอนเงิน)
 */
export async function getCommissionSummaryByPeriod(
  params: CommissionSummaryParams,
): Promise<CommissionSummaryRow[]> {
  const db = await getDb(params.section);
  if (!db) return [];

  const { section, groupBy, years, months } = params;
  const esc = (v: string) => v.replace(/'/g, "''");

  const conditions: string[] = [
    `section = '${esc(section)}'`,
    `payment_status = ${PAID_STATUS}`,
    `payment_at IS NOT NULL`,
  ];
  if (years && years.length > 0) {
    conditions.push(`LEFT(payment_at::text, 4) IN (${years.map((y) => "'" + y + "'").join(",")})`);
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(payment_at::text, 6, 2) IN (${months.map((m) => "'" + String(m).padStart(2, "0") + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");
  const periodExpr = groupBy === "year"
    ? `LEFT(payment_at::text, 4)`
    : `LEFT(payment_at::text, 7)`;

  const result = await db.execute(sql.raw(`
    SELECT
      ${periodExpr} AS period,
      SUM(COALESCE(finance_amount, 0)) AS fin,
      SUM(COALESCE(comm_amount, 0)) AS comm,
      SUM(COALESCE(incentive, 0)) AS inc,
      SUM(COALESCE(total_transfer, 0)) AS tot
    FROM commissions
    WHERE ${whereStr}
    GROUP BY ${periodExpr}
    ORDER BY ${periodExpr} ASC
  `));

  return (pgRows(result) as any[]).map((r) => ({
    period: r.period ?? "",
    financeAmount: Number(r.fin ?? 0),
    commAmount: Number(r.comm ?? 0),
    incentive: Number(r.inc ?? 0),
    totalTransfer: Number(r.tot ?? 0),
  }));
}


// ─── Income Monthly Summary — Rebuild ─────────────────────────────────────────

/**
 * Pre-aggregate ยอดรายรับรายเดือนลง income_monthly_summary table
 * เรียกหลัง sync payments เสร็จ เพื่อให้หน้าสรุปรายเดือน/รายปีโหลดเร็วขึ้น
 *
 * Logic:
 *   DELETE ทุก row ของ section นี้ แล้ว INSERT ใหม่ทั้งหมด
 *   GROUP BY section, year, month, income_type
 */
export async function rebuildIncomeMonthlySummary(section: SectionKey): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;

  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);

  // sourceWhere ใช้ alias pt2 ใน CTE และ pt ใน classified CTE
  const sourceWherePt2 = secEsc === 'Fastfone365' ? 'TRUE' : `(pt2.raw_json::jsonb->>'source') IS NULL`;
  const sourceWherePt  = secEsc === 'Fastfone365' ? 'TRUE' : `(pt.raw_json::jsonb->>'source') IS NULL`;

  // Step 1: DELETE existing rows for this section
  await db.execute(sql.raw(`DELETE FROM income_monthly_summary WHERE section = '${secEsc}'`));

  // Step 2: INSERT aggregated data
  // สร้าง CTE เองแทนใช้ buildIncomeCTE เพื่อควบคุม alias ให้ถูกต้อง
  const insertSql = `
    WITH bad_debt_last AS (
      SELECT
        pt2.contract_no,
        MAX(DATE(pt2.created_at)) AS last_created_date
      FROM payment_transactions pt2
      INNER JOIN contracts c2
        ON c2.contract_no = pt2.contract_no AND c2.section = pt2.section
      WHERE pt2.section = '${secEsc}'
        AND ${sourceWherePt2}
        AND c2.status = 'หนี้เสีย'
      GROUP BY pt2.contract_no
    ),
    classified AS (
      SELECT
        pt.section,
        EXTRACT(YEAR  FROM pt.paid_at::date)::integer AS year,
        EXTRACT(MONTH FROM pt.paid_at::date)::integer AS month,
        CASE
          WHEN pt.receipt_no LIKE 'TXRTC%'
            THEN 'ปิดยอด'
          WHEN c.status = 'หนี้เสีย'
            AND bdl.last_created_date IS NOT NULL
            AND DATE(pt.created_at) = bdl.last_created_date
            THEN 'ขายเครื่อง'
          ELSE 'ค่างวด'
        END AS income_type,
        CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2)) AS amt
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
      LEFT JOIN bad_debt_last bdl ON bdl.contract_no = pt.contract_no
      WHERE pt.section = '${secEsc}'
        AND ${sourceWherePt}
        AND pt.paid_at IS NOT NULL
    )
    INSERT INTO income_monthly_summary (section, year, month, income_type, total_amount, row_count, updated_at)
    SELECT
      section,
      year,
      month,
      income_type,
      SUM(amt)   AS total_amount,
      COUNT(*)   AS row_count,
      NOW()      AS updated_at
    FROM classified
    GROUP BY section, year, month, income_type
    ON CONFLICT (section, year, month, income_type)
    DO UPDATE SET
      total_amount = EXCLUDED.total_amount,
      row_count    = EXCLUDED.row_count,
      updated_at   = EXCLUDED.updated_at
  `;

  const result = await db.execute(sql.raw(insertSql));
  const rowCount = (result as any)?.rowCount ?? (result as any)?.count ?? 0;
  console.log(`[rebuildIncomeMonthlySummary] ${section}: inserted/updated ${rowCount} rows`);
  return Number(rowCount);
}

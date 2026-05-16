/**
 * accountingDb.ts — Query helpers สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 *
 * รายรับ (Income):
 *   - ดึงจาก payment_transactions WHERE (raw_json::jsonb->>'source') IS NULL
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
 *
 * ─── การปรับปรุง (v2) ────────────────────────────────────────────────────────
 * เปลี่ยนจาก buildBadDebtLastDaysSubquery (4 ชั้น nested) เป็น 2-step approach:
 *   Step 1: ดึง batch_key map ของทุกสัญญาใน section ก่อน (1 query เบา)
 *   Step 2: ใช้ batch_key map ใน CASE expression แบบ IN clause (ไม่ต้อง JOIN subquery ซ้อน)
 *
 * สำหรับ getIncomeSummaryByPeriod / getIncomeSummary / listIncome:
 *   - ใช้ WITH (CTE) แทน nested subquery เพื่อให้ query planner optimize ได้ดีกว่า
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

/** Base WHERE: เฉพาะ close rows (source IS NULL) ที่ตรงกับ Fastfone/Boonphone Report */
const PT_INCOME_BASE_WHERE = `(pt.raw_json::jsonb->>'source') IS NULL`;

// ─── 2-Step Batch Key Helpers ─────────────────────────────────────────────────

/**
 * BatchKey สำหรับ classify ขายเครื่อง และ ปิดยอด
 * แทนที่ buildBadDebtLastDaysSubquery เดิม (4 ชั้น nested)
 *
 * Step 1: ดึง batch_key map ของทุกสัญญาใน section ก่อน
 *   - ขายเครื่อง: สัญญาหนี้เสีย → batch สุดท้าย (2 ระดับ)
 *   - ปิดยอด: สัญญาสิ้นสุดสัญญา/สำเร็จ → batch สุดท้าย
 *
 * Return: Map<contractNo, { lastCreatedDate, lastPaidDate, lastUpdatedBy, isFallback, status }>
 */
interface BatchKeyEntry {
  lastCreatedDate: string;
  lastPaidDate: string;
  lastUpdatedBy: string;
  isFallback: boolean;
  status: string;
}

async function fetchBatchKeyMap(
  db: any,
  section: string,
): Promise<Map<string, BatchKeyEntry>> {
  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);

  // Step 1a: หา row ล่าสุดของแต่ละสัญญา (เฉพาะ หนี้เสีย / สิ้นสุดสัญญา / สำเร็จ)
  const lastRowSql = `
    SELECT
      pt.contract_no,
      DATE(pt.paid_at)    AS last_paid_date,
      DATE(pt.created_at) AS last_created_date,
      pt.updated_by       AS last_updated_by,
      c.status            AS contract_status
    FROM payment_transactions pt
    INNER JOIN contracts c
      ON c.contract_no = pt.contract_no AND c.section = pt.section
    WHERE pt.section = '${secEsc}'
      AND (pt.raw_json::jsonb->>'source') IS NULL
      AND c.status IN ('หนี้เสีย', 'สิ้นสุดสัญญา', 'สำเร็จ')
      AND pt.created_at = (
        SELECT MAX(pt2.created_at)
        FROM payment_transactions pt2
        WHERE pt2.contract_no = pt.contract_no
          AND pt2.section = pt.section
          AND (pt2.raw_json::jsonb->>'source') IS NULL
      )
  `;

  // Step 1b: หา primary batch sum (paid_date + created_date + updated_by)
  // เพื่อตรวจสอบว่าต้อง fallback หรือไม่ (สำหรับสัญญาหนี้เสีย)
  const batchSumSql = `
    SELECT
      pt.contract_no,
      DATE(pt.paid_at)    AS paid_date,
      DATE(pt.created_at) AS created_date,
      pt.updated_by,
      SUM(CAST(COALESCE(pt.amount, 0) AS DECIMAL(18,2))) AS batch_sum
    FROM payment_transactions pt
    INNER JOIN contracts c
      ON c.contract_no = pt.contract_no AND c.section = pt.section
    WHERE pt.section = '${secEsc}'
      AND (pt.raw_json::jsonb->>'source') IS NULL
      AND c.status = 'หนี้เสีย'
    GROUP BY pt.contract_no, DATE(pt.paid_at), DATE(pt.created_at), pt.updated_by
  `;

  const [lastRowResult, batchSumResult] = await Promise.all([
    db.execute(sql.raw(lastRowSql)),
    db.execute(sql.raw(batchSumSql)),
  ]);

  const lastRows: any[] = pgRows(lastRowResult);
  const batchSums: any[] = pgRows(batchSumResult);

  // สร้าง batchSum lookup: contractNo + paidDate + createdDate + updatedBy → sum
  const batchSumMap = new Map<string, number>();
  for (const r of batchSums) {
    const key = `${r.contract_no}||${r.paid_date}||${r.created_date}||${r.updated_by}`;
    batchSumMap.set(key, Number(r.batch_sum ?? 0));
  }

  // สร้าง batch key map
  const map = new Map<string, BatchKeyEntry>();
  for (const r of lastRows) {
    const contractNo: string = r.contract_no ?? "";
    const lastCreatedDate: string = r.last_created_date ?? "";
    const lastPaidDate: string = r.last_paid_date ?? "";
    const lastUpdatedBy: string = r.last_updated_by ?? "";
    const status: string = r.contract_status ?? "";

    let isFallback = false;
    if (status === "หนี้เสีย") {
      const batchKey = `${contractNo}||${lastPaidDate}||${lastCreatedDate}||${lastUpdatedBy}`;
      const batchSum = batchSumMap.get(batchKey) ?? 0;
      isFallback = batchSum < 1000;
    }

    map.set(contractNo, {
      lastCreatedDate,
      lastPaidDate,
      lastUpdatedBy,
      isFallback,
      status,
    });
  }

  return map;
}

/**
 * สร้าง CASE expression สำหรับ classify income_type
 * โดยใช้ batch key map ที่ดึงมาแล้ว (ไม่ต้อง JOIN subquery ซ้อน)
 *
 * แทนที่ PT_INCOME_TYPE_CASE + buildBadDebtLastDaysSubquery เดิม
 */
function buildIncomeCaseFromMap(batchMap: Map<string, BatchKeyEntry>): string {
  if (batchMap.size === 0) {
    return `'ค่างวด'`;
  }

  const esc = (v: string) => v.replace(/'/g, "''");
  const whenClauses: string[] = [];

  for (const [contractNo, entry] of Array.from(batchMap)) {
    const cn = esc(contractNo);
    const lcd = esc(entry.lastCreatedDate);
    const lpd = esc(entry.lastPaidDate);
    const lub = esc(entry.lastUpdatedBy);

    if (entry.status === "หนี้เสีย") {
      if (entry.isFallback) {
        // Fallback: ไม่สนใจ paid_date
        whenClauses.push(`
          WHEN pt.contract_no = '${cn}'
            AND DATE(pt.created_at) = '${lcd}'
            AND pt.updated_by = '${lub}'
            THEN 'ขายเครื่อง'`);
      } else {
        // Primary: paid_date ต้องตรง
        whenClauses.push(`
          WHEN pt.contract_no = '${cn}'
            AND DATE(pt.created_at) = '${lcd}'
            AND pt.updated_by = '${lub}'
            AND DATE(pt.paid_at) = '${lpd}'
            THEN 'ขายเครื่อง'`);
      }
    } else if (entry.status === "สิ้นสุดสัญญา" || entry.status === "สำเร็จ") {
      whenClauses.push(`
        WHEN pt.contract_no = '${cn}'
          AND DATE(pt.created_at) = '${lcd}'
          AND pt.updated_by = '${lub}'
          AND DATE(pt.paid_at) = '${lpd}'
          THEN 'ปิดยอด'`);
    }
  }

  if (whenClauses.length === 0) {
    return `'ค่างวด'`;
  }

  return `CASE ${whenClauses.join("")}
    ELSE 'ค่างวด'
  END`;
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
    PT_INCOME_BASE_WHERE,
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

  // Step 1: ดึง batch key map
  const batchMap = await fetchBatchKeyMap(db, secEsc);
  const incomeTypeCase = buildIncomeCaseFromMap(batchMap);

  const countSql = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT ${incomeTypeCase} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
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
        pt.created_at,
        pt.receipt_no,
        c.status AS contract_status,
        ${incomeTypeCase} AS income_type,
        ${PT_ORIGINAL_INCOME_TYPE_CASE} AS original_income_type,
        ${PT_AMOUNT_CASE} AS amount
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
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
          AND raw_json::jsonb->>'source' IS NULL
          AND updated_by IS NOT NULL AND updated_by != ''
        ORDER BY updated_by ASC
      `),
    );
    const arr: any[] = pgRows(result);
    return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean);
  }

  // มี filter เพิ่มเติม — ต้อง JOIN contracts + batch map
  const { search, dateFrom, dateTo, dateField = "paidAt", incomeTypes } = opts ?? {};
  const dateCol = dateField === "paidAt" ? "pt.paid_at" : "pt.updated_at";

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    PT_INCOME_BASE_WHERE,
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

  // Step 1: ดึง batch key map
  const batchMap = await fetchBatchKeyMap(db, secEsc);
  const incomeTypeCase = buildIncomeCaseFromMap(batchMap);

  const querySql = `
    SELECT DISTINCT updated_by
    FROM (
      SELECT
        pt.updated_by AS updated_by,
        ${incomeTypeCase} AS income_type
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
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
    PT_INCOME_BASE_WHERE,
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

  // Step 1: ดึง batch key map
  const batchMap = await fetchBatchKeyMap(db, secEsc);
  const incomeTypeCase = buildIncomeCaseFromMap(batchMap);

  const querySql = `
    SELECT income_type, SUM(amount) AS sum_amount
    FROM (
      SELECT
        ${incomeTypeCase} AS income_type,
        ${PT_AMOUNT_CASE} AS amount
      FROM payment_transactions pt
      LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
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
 *
 * ใช้ 2-step approach:
 *   Step 1: fetchBatchKeyMap — ดึง batch key ของทุกสัญญา (1 query เบา)
 *   Step 2: ใช้ CASE expression จาก map ใน GROUP BY query (ไม่ต้อง JOIN subquery ซ้อน)
 */
export async function getIncomeSummaryByPeriod(
  params: IncomeSummaryParams,
): Promise<IncomeSummaryRow[]> {
  const db = await getDb(params.section);
  if (!db) return [];

  const { section, groupBy, years, months } = params;
  const esc = (v: string) => v.replace(/'/g, "''");
  const secEsc = esc(section);

  const conditions: string[] = [
    `pt.section = '${secEsc}'`,
    `(pt.raw_json::jsonb->>'source') IS NULL`,
    `pt.paid_at IS NOT NULL`,
    `pt.paid_at != ''`,
  ];
  if (years && years.length > 0) {
    conditions.push(`LEFT(pt.paid_at::text, 4) IN (${years.map((y) => "'" + y + "'").join(",")})`);
  }
  if (months && months.length > 0) {
    conditions.push(`SUBSTRING(pt.paid_at::text, 6, 2) IN (${months.map((m) => "'" + String(m).padStart(2, "0") + "'").join(",")})`);
  }
  const whereStr = conditions.join(" AND ");
  const periodLen = groupBy === "year" ? 4 : 7;

  // Step 1: ดึง batch key map
  const batchMap = await fetchBatchKeyMap(db, secEsc);
  const incomeTypeCase = buildIncomeCaseFromMap(batchMap);

  const querySql = `
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
    WHERE ${whereStr} AND c.approve_date != ''
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
      WHERE ${whereStr} AND c.approve_date != ''
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
    `c.approve_date != ''`,
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

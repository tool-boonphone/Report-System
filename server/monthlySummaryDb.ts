/**
 * Monthly Summary DB helpers — Phase 128
 *
 * Primary sources:
 *   - debt_target_cache  → Count tab + Target tab + Due tab + NotYetDue tab
 *   - debt_collected_cache → Paid tab
 *
 * Tabs:
 *   1. จำนวนสัญญา    (count)      — COUNT DISTINCT contract per approve_month+bucket
 *   2. ยอดที่ต้องชำระ (target)    — SUM total_amount WHERE is_future_period = 0 (ถึงกำหนดแล้ว)
 *   3. ยอดที่ชำระแล้ว (paid)      — SUM from debt_collected_cache
 *   4. ยอดค้างชำระ   (due)        — SUM (total_amount - paid_amount) WHERE is_arrears = 1
 *                                    + penalty/unlockFee จากงวดล่าสุดของแต่ละสัญญาเท่านั้น
 *   5. ยอดที่ยังไม่ถึงกำหนด (notYetDue) — SUM total_amount WHERE is_future_period = 1
 *                                    + penalty/unlockFee จากงวดล่าสุดของแต่ละสัญญาเท่านั้น
 *
 * Bucket (debt_status) ใช้ contract_status + debt_range จาก debt_target_cache:
 *   ปกติ / เกิน 1-7 / เกิน 8-14 / เกิน 15-30 / เกิน 31-60 /
 *   เกิน 61-90 / เกิน >90 / ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย
 *
 * iOS = device IN ('iPhone','iPad') | Android = device NOT IN ('iPhone','iPad') AND device IS NOT NULL
 */
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** ยอดเงินแยกรายการ */
export type MoneyBreakdown = {
  principal: number;
  interest: number;
  fee: number;
  penalty: number;
  unlockFee: number;   // paid side + due side (จากงวดล่าสุด) + notYetDue side (จากงวดล่าสุด)
  discount: number;    // paid side เท่านั้น
  overpaid: number;    // paid side เท่านั้น
  badDebt: number;     // paid side เท่านั้น — ยอดขายเครื่อง (bad_debt)
  badDebtInstallment: number; // paid side — ยอดค่างวดหนี้เสีย (total_amount สำหรับ is_bad_debt_row=0)
  total: number;
};

export type MonthlySummaryCell = {
  contractCount: number;
  paid: MoneyBreakdown;
  due: MoneyBreakdown;
  target: MoneyBreakdown;
  notYetDue: MoneyBreakdown;
  installTotal: MoneyBreakdown; // ยอดหนี้รวม = SUM(net_amount) ทุกงวด (principal+interest+fee ไม่มีค่าปรับ/ค่าปลดล็อก)
};

export type MonthlySummaryRow = {
  approveMonth: string; // YYYY-MM
  buckets: Record<string, MonthlySummaryCell>;
  totalCount: number;
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
  totalTarget: MoneyBreakdown;
  totalNotYetDue: MoneyBreakdown;
  totalInstallTotal: MoneyBreakdown; // ยอดหนี้รวม
};

export type MonthlySummaryParams = {
  section: SectionKey;
  // Tab 1: จำนวนสัญญา
  countApproveDate?: string;       // exact date YYYY-MM-DD
  countApproveMonths?: string[];   // multi YYYY-MM
  countProductType?: string;
  countDeviceFamily?: string;      // "iOS" | "Android"
  // Tab 2: ยอดที่ต้องชำระ
  targetDueDate?: string;          // exact date YYYY-MM-DD (due_date)
  targetDueMonths?: string[];      // multi YYYY-MM (due_date)
  targetApproveMonths?: string[];  // multi YYYY-MM (approve_date)
  targetProductType?: string;
  targetDeviceFamily?: string;
  // Tab 3: ยอดชำระแล้ว
  paidAtDate?: string;             // exact date YYYY-MM-DD (paid_at)
  paidAtMonths?: string[];         // multi YYYY-MM
  paidProductType?: string;
  paidDeviceFamily?: string;
  // Tab 4: ยอดค้างชำระ
  dueAtDate?: string;              // exact date YYYY-MM-DD (due_date)
  dueAtMonths?: string[];          // multi YYYY-MM
  dueProductType?: string;
  dueDeviceFamily?: string;
  // Tab 5: ยอดที่ยังไม่ถึงกำหนด
  notYetDueDueDate?: string;       // exact date YYYY-MM-DD (due_date)
  notYetDueDueMonths?: string[];   // multi YYYY-MM (due_date)
  notYetDueApproveMonths?: string[]; // multi YYYY-MM (approve_date)
  notYetDueProductType?: string;
  notYetDueDeviceFamily?: string;
  // Tab 6: ยอดหนี้รวม (installTotal)
  installTotalApproveMonths?: string[]; // multi YYYY-MM (approve_date)
  installTotalProductType?: string;
  installTotalDeviceFamily?: string;
};

// ---------------------------------------------------------------------------
// Bucket list
// ---------------------------------------------------------------------------
export const DEBT_BUCKETS = [
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
export type DebtBucket = (typeof DEBT_BUCKETS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emptyMoney(): MoneyBreakdown {
  return { principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: 0 };
}
function emptyCell(): MonthlySummaryCell {
  return { contractCount: 0, paid: emptyMoney(), due: emptyMoney(), target: emptyMoney(), notYetDue: emptyMoney(), installTotal: emptyMoney() };
}
function n(v: unknown): number {
  const x = parseFloat(String(v ?? 0));
  return isNaN(x) ? 0 : x;
}

/**
 * Derive bucket from contract_status + debt_range stored in debt_target_cache.
 * SQL CASE expression for use in queries.
 */
const BUCKET_CASE_DTC = `
  CASE
    WHEN dtc.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
    WHEN dtc.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
    WHEN dtc.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
    ELSE COALESCE(dtc.debt_range, 'ปกติ')
  END
`;

/** Build WHERE clause for debt_target_cache (base — no date filter) */
function dtcWhere(section: string, opts: {
  productType?: string;
  deviceFamily?: string;
  approveDate?: string;
  approveMonths?: string[];
}): string {
  let w = `dtc.section = '${section}'
    AND dtc.approve_date IS NOT NULL
    AND COALESCE(dtc.contract_status, '') != 'ยกเลิกสัญญา'`;

  if (opts.productType) {
    w += `\n    AND dtc.product_type = '${opts.productType.replace(/'/g, "''")}'`;
  }
  if (opts.deviceFamily === "iOS") {
    w += `\n    AND dtc.device IN ('iPhone', 'iPad')`;
  } else if (opts.deviceFamily === "Android") {
    w += `\n    AND dtc.device NOT IN ('iPhone', 'iPad') AND dtc.device IS NOT NULL AND dtc.device != ''`;
  }
  if (opts.approveDate) {
    w += `\n    AND DATE(dtc.approve_date) = '${opts.approveDate}'`;
  } else if (opts.approveMonths && opts.approveMonths.length > 0) {
    const list = opts.approveMonths.map((m) => `'${m}'`).join(",");
    w += `\n    AND DATE_FORMAT(dtc.approve_date, '%Y-%m') IN (${list})`;
  }
  return w;
}

/** Build WHERE clause for debt_collected_cache */
function dccWhere(section: string, opts: {
  productType?: string;
  deviceFamily?: string;
  paidAtDate?: string;
  paidAtMonths?: string[];
}): string {
  let w = `dcc.section = '${section}'
    AND dcc.approve_date IS NOT NULL
    AND COALESCE(dcc.contract_status, '') != 'ยกเลิกสัญญา'`;

  if (opts.productType) {
    w += `\n    AND dcc.product_type = '${opts.productType.replace(/'/g, "''")}'`;
  }
  if (opts.deviceFamily === "iOS") {
    w += `\n    AND dcc.device IN ('iPhone', 'iPad')`;
  } else if (opts.deviceFamily === "Android") {
    w += `\n    AND dcc.device NOT IN ('iPhone', 'iPad') AND dcc.device IS NOT NULL AND dcc.device != ''`;
  }
  if (opts.paidAtDate) {
    w += `\n    AND DATE(dcc.paid_at) = '${opts.paidAtDate}'`;
  } else if (opts.paidAtMonths && opts.paidAtMonths.length > 0) {
    const list = opts.paidAtMonths.map((m) => `'${m}'`).join(",");
    w += `\n    AND DATE_FORMAT(dcc.paid_at, '%Y-%m') IN (${list})`;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Query 1: Count tab — from debt_target_cache (1 row per contract per period)
// We use DISTINCT contract_external_id per approve_month + bucket
// ---------------------------------------------------------------------------
async function queryCount(section: SectionKey, opts: {
  productType?: string;
  deviceFamily?: string;
  approveDate?: string;
  approveMonths?: string[];
}): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const q = `
    SELECT
      DATE_FORMAT(dtc.approve_date, '%Y-%m') AS approve_month,
      ${BUCKET_CASE_DTC} AS bucket,
      COUNT(DISTINCT dtc.contract_external_id) AS contract_count
    FROM debt_target_cache dtc
    WHERE ${dtcWhere(section, opts)}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 2: Target tab — ยอดที่ต้องชำระ (แบบ A)
// SUM total_amount WHERE is_future_period = 0 (งวดที่ถึงกำหนดแล้ว)
// penalty/unlockFee: ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น (MAX period per contract)
// ---------------------------------------------------------------------------
async function queryTarget(
  section: SectionKey,
  opts: {
    dueDate?: string;
    dueMonths?: string[];
    approveMonths?: string[];
    productType?: string;
    deviceFamily?: string;
  },
): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
  principal_target: number;
  interest_target: number;
  fee_target: number;
  penalty_target: number;
  unlock_fee_target: number;
  total_target: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
  });

  // due_date filter
  let dueDateFilter = "";
  if (opts.dueDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueDate}'`;
  } else if (opts.dueMonths && opts.dueMonths.length > 0) {
    const list = opts.dueMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND DATE_FORMAT(dtc.due_date, '%Y-%m') IN (${list})`;
  }

  /*
   * penalty และ unlock_fee ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น
   * ใช้ subquery หา MAX(period) per contract แล้ว JOIN กลับมา
   * สำหรับ total_amount, principal, interest, fee — SUM จากทุกงวดที่ถึงกำหนดแล้ว
   */
  const q = `
    SELECT
      DATE_FORMAT(base.approve_date, '%Y-%m') AS approve_month,
      CASE
        WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        ELSE COALESCE(base.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT base.contract_external_id) AS contract_count,
      SUM(CAST(base.principal    AS DECIMAL(18,2))) AS principal_target,
      SUM(CAST(base.interest     AS DECIMAL(18,2))) AS interest_target,
      SUM(CAST(base.fee          AS DECIMAL(18,2))) AS fee_target,
      SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.penalty    AS DECIMAL(18,2)) ELSE 0 END) AS penalty_target,
      SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.unlock_fee AS DECIMAL(18,2)) ELSE 0 END) AS unlock_fee_target,
      SUM(CAST(base.principal AS DECIMAL(18,2)))
        + SUM(CAST(base.interest  AS DECIMAL(18,2)))
        + SUM(CAST(base.fee       AS DECIMAL(18,2)))
        + SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.penalty    AS DECIMAL(18,2)) ELSE 0 END)
        + SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.unlock_fee AS DECIMAL(18,2)) ELSE 0 END) AS total_target
    FROM debt_target_cache base
    JOIN (
      SELECT dtc.section, dtc.contract_external_id, MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.is_future_period = 0
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE base.section = '${section}'
      AND base.is_future_period = 0
      AND COALESCE(base.contract_status, '') != 'ยกเลิกสัญญา'
      ${dueDateFilter.replace(/dtc\./g, "base.")}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 3: Paid tab — from debt_collected_cache
// ---------------------------------------------------------------------------
async function queryPaid(
  section: SectionKey,
  opts: {
    paidAtDate?: string;
    paidAtMonths?: string[];
    productType?: string;
    deviceFamily?: string;
  },
): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
  principal_paid: number;
  interest_paid: number;
  fee_paid: number;
  penalty_paid: number;
  unlock_fee_paid: number;
  discount_amount: number;
  overpaid_amount: number;
  installment_paid: number;
  device_sale_amount: number;
  total_paid: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const q = `
    SELECT
      DATE_FORMAT(dcc.approve_date, '%Y-%m') AS approve_month,
      CASE
        WHEN dcc.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN dcc.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN dcc.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        ELSE COALESCE(dtc_latest.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT dcc.contract_external_id)                                                       AS contract_count,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.principal   AS DECIMAL(18,2)) ELSE 0 END) AS principal_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.interest    AS DECIMAL(18,2)) ELSE 0 END) AS interest_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.fee         AS DECIMAL(18,2)) ELSE 0 END) AS fee_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.penalty     AS DECIMAL(18,2)) ELSE 0 END) AS penalty_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.unlock_fee  AS DECIMAL(18,2)) ELSE 0 END) AS unlock_fee_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.discount    AS DECIMAL(18,2)) ELSE 0 END) AS discount_amount,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.overpaid    AS DECIMAL(18,2)) ELSE 0 END) AS overpaid_amount,
      SUM(CASE WHEN dcc.is_bad_debt_row = 0 THEN CAST(dcc.total_amount AS DECIMAL(18,2)) ELSE 0 END) AS installment_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = 1 THEN CAST(dcc.bad_debt    AS DECIMAL(18,2)) ELSE 0 END) AS device_sale_amount,
      SUM(CAST(dcc.total_amount AS DECIMAL(18,2)))                                                   AS total_paid
    FROM debt_collected_cache dcc
    LEFT JOIN (
      SELECT dtc.section, dtc.contract_external_id, dtc.debt_range
      FROM debt_target_cache dtc
      INNER JOIN (
        SELECT section, contract_external_id, MAX(period) AS max_period
        FROM debt_target_cache
        WHERE section = '${section}'
        GROUP BY section, contract_external_id
      ) mx ON mx.section = dtc.section
           AND mx.contract_external_id = dtc.contract_external_id
           AND mx.max_period = dtc.period
    ) dtc_latest ON dtc_latest.section = dcc.section
                AND dtc_latest.contract_external_id = dcc.contract_external_id
    WHERE ${dccWhere(section, opts)}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 4: Due tab — ยอดค้างชำระ
// SUM (total_amount - paid_amount) WHERE is_arrears = 1
// penalty/unlockFee: ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น
// ---------------------------------------------------------------------------
async function queryDue(
  section: SectionKey,
  opts: {
    dueAtDate?: string;
    dueAtMonths?: string[];
    productType?: string;
    deviceFamily?: string;
  },
): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
  principal_due: number;
  interest_due: number;
  fee_due: number;
  penalty_due: number;
  unlock_fee_due: number;
  total_due: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  // due_date filter
  let dueDateFilter = "";
  if (opts.dueAtDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueAtDate}'`;
  } else if (opts.dueAtMonths && opts.dueAtMonths.length > 0) {
    const list = opts.dueAtMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND DATE_FORMAT(dtc.due_date, '%Y-%m') IN (${list})`;
  }

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
  });

  /*
   * penalty/unlockFee ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น (MAX period WHERE is_arrears=1)
   * ยอดอื่น SUM จากทุกงวดที่ค้างชำระ
   */
  const q = `
    SELECT
      DATE_FORMAT(base.approve_date, '%Y-%m') AS approve_month,
      CASE
        WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        ELSE COALESCE(base.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT base.contract_external_id) AS contract_count,
      SUM(GREATEST(CAST(base.principal  AS DECIMAL(18,2)) - CAST(base.paid_amount AS DECIMAL(18,2)), 0)) AS principal_due,
      SUM(CAST(base.interest  AS DECIMAL(18,2))) AS interest_due,
      SUM(CAST(base.fee       AS DECIMAL(18,2))) AS fee_due,
      SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.penalty    AS DECIMAL(18,2)) ELSE 0 END) AS penalty_due,
      SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.unlock_fee AS DECIMAL(18,2)) ELSE 0 END) AS unlock_fee_due,
      SUM(GREATEST(CAST(base.total_amount AS DECIMAL(18,2)) - CAST(base.paid_amount AS DECIMAL(18,2)), 0)) AS total_due
    FROM debt_target_cache base
    JOIN (
      SELECT dtc.section, dtc.contract_external_id, MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.is_arrears = 1
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE base.section = '${section}'
      AND base.is_arrears = 1
      AND COALESCE(base.contract_status, '') != 'ยกเลิกสัญญา'
      ${dueDateFilter.replace(/dtc\./g, "base.")}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 5: NotYetDue tab — ยอดที่ยังไม่ถึงกำหนด
// SUM total_amount WHERE is_future_period = 1
// penalty/unlockFee: ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น
// ---------------------------------------------------------------------------
async function queryNotYetDue(
  section: SectionKey,
  opts: {
    dueDate?: string;
    dueMonths?: string[];
    approveMonths?: string[];
    productType?: string;
    deviceFamily?: string;
  },
): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
  principal_notyet: number;
  interest_notyet: number;
  fee_notyet: number;
  penalty_notyet: number;
  unlock_fee_notyet: number;
  total_notyet: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
  });

  // due_date filter
  let dueDateFilter = "";
  if (opts.dueDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueDate}'`;
  } else if (opts.dueMonths && opts.dueMonths.length > 0) {
    const list = opts.dueMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND DATE_FORMAT(dtc.due_date, '%Y-%m') IN (${list})`;
  }

  /*
   * penalty/unlockFee ดึงจากงวดล่าสุดของแต่ละสัญญา (MAX period WHERE due_date > CURDATE())
   * หมายเหตุ: ใช้ due_date > CURDATE() แทน is_future_period เพราะ is_future_period ถูก populate
   * ณ เวลา sync และอาจล้าสมัย ส่วน due_date > CURDATE() คำนวณ real-time เสมอ
   */
  const q = `
    SELECT
      DATE_FORMAT(base.approve_date, '%Y-%m') AS approve_month,
      CASE
        WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        ELSE COALESCE(base.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT base.contract_external_id) AS contract_count,
      SUM(CAST(base.principal    AS DECIMAL(18,2))) AS principal_notyet,
      SUM(CAST(base.interest     AS DECIMAL(18,2))) AS interest_notyet,
      SUM(CAST(base.fee          AS DECIMAL(18,2))) AS fee_notyet,
      SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.penalty    AS DECIMAL(18,2)) ELSE 0 END) AS penalty_notyet,
      SUM(CASE WHEN base.period = latest.max_period
               THEN CAST(base.unlock_fee AS DECIMAL(18,2)) ELSE 0 END) AS unlock_fee_notyet,
      SUM(CAST(base.total_amount AS DECIMAL(18,2))) AS total_notyet
    FROM debt_target_cache base
    JOIN (
      SELECT dtc.section, dtc.contract_external_id, MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.due_date > CURDATE()
        AND COALESCE(dtc.is_closed, 0) = 0
        AND COALESCE(dtc.is_paid, 0) = 0
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE base.section = '${section}'
      AND base.due_date > CURDATE()
      AND COALESCE(base.is_closed, 0) = 0
      AND COALESCE(base.is_paid, 0) = 0
      AND COALESCE(base.contract_status, '') != 'ยกเลิกสัญญา'
      ${dueDateFilter.replace(/dtc\./g, "base.")}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 6: InstallTotal tab — ยอดหนี้รวม
// SUM(net_amount) ทุกงวด (principal+interest+fee ไม่มีค่าปรับ/ค่าปลดล็อก)
// การจัดกลุ่ม bucket ใช้ contract_status ปัจจุบันของสัญญา
// ---------------------------------------------------------------------------
async function queryInstallTotal(
  section: SectionKey,
  opts: {
    approveMonths?: string[];
    productType?: string;
    deviceFamily?: string;
  },
): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
  principal_install: number;
  interest_install: number;
  fee_install: number;
  total_install: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
  });

  /*
   * ยอดหนี้รวม = SUM(principal + interest + fee) ทุกงวด ตั้งแต่งวดแรกถึงงวดสุดท้าย
   * net_amount = principal + interest + fee (ไม่มี penalty/unlock_fee)
   * ดึงจากทุกงวด (is_future_period=0 และ =1) ไม่มี filter
   * bucket ใช้จากงวดล่าสุด (max_period) ของแต่ละสัญญา (สถานะหนี้ปัจจุบัน)
   */
  const q = `
    SELECT
      DATE_FORMAT(all_p.approve_date, '%Y-%m') AS approve_month,
      CASE
        WHEN latest.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN latest.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN latest.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        ELSE COALESCE(latest.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT all_p.contract_external_id) AS contract_count,
      SUM(CAST(all_p.principal  AS DECIMAL(18,2))) AS principal_install,
      SUM(CAST(all_p.interest   AS DECIMAL(18,2))) AS interest_install,
      SUM(CAST(all_p.fee        AS DECIMAL(18,2))) AS fee_install,
      SUM(CAST(all_p.net_amount AS DECIMAL(18,2))) AS total_install
    FROM debt_target_cache all_p
    JOIN (
      SELECT
        dtc.section,
        dtc.contract_external_id,
        dtc.contract_status,
        dtc.debt_range
      FROM debt_target_cache dtc
      INNER JOIN (
        SELECT dtc2.section, dtc2.contract_external_id, MAX(dtc2.period) AS max_period
        FROM debt_target_cache dtc2
        WHERE dtc2.section = '${section}'
          AND dtc2.approve_date IS NOT NULL
          AND COALESCE(dtc2.contract_status, '') != 'ยกเลิกสัญญา'
        GROUP BY dtc2.section, dtc2.contract_external_id
      ) mp ON mp.section = dtc.section
          AND mp.contract_external_id = dtc.contract_external_id
          AND mp.max_period = dtc.period
    ) latest ON latest.section = all_p.section
            AND latest.contract_external_id = all_p.contract_external_id
    WHERE all_p.section = '${section}'
      AND all_p.approve_date IS NOT NULL
      AND COALESCE(all_p.contract_status, '') NOT IN ('ยกเลิกสัญญา')
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Main export: getMonthlySummary
// ---------------------------------------------------------------------------
export async function getMonthlySummary(
  params: MonthlySummaryParams,
): Promise<MonthlySummaryRow[]> {
  const { section } = params;

  // Run 6 queries in parallel
  const [countRows, targetRows, paidRows, dueRows, notYetDueRows, installTotalRows] = await Promise.all([
    queryCount(section, {
      productType:    params.countProductType,
      deviceFamily:   params.countDeviceFamily,
      approveDate:    params.countApproveDate,
      approveMonths:  params.countApproveMonths,
    }),
    queryTarget(section, {
      dueDate:        params.targetDueDate,
      dueMonths:      params.targetDueMonths,
      approveMonths:  params.targetApproveMonths,
      productType:    params.targetProductType,
      deviceFamily:   params.targetDeviceFamily,
    }),
    queryPaid(section, {
      paidAtDate:    params.paidAtDate,
      paidAtMonths:  params.paidAtMonths,
      productType:   params.paidProductType,
      deviceFamily:  params.paidDeviceFamily,
    }),
    queryDue(section, {
      dueAtDate:    params.dueAtDate,
      dueAtMonths:  params.dueAtMonths,
      productType:  params.dueProductType,
      deviceFamily: params.dueDeviceFamily,
    }),
    queryNotYetDue(section, {
      dueDate:        params.notYetDueDueDate,
      dueMonths:      params.notYetDueDueMonths,
      approveMonths:  params.notYetDueApproveMonths,
      productType:    params.notYetDueProductType,
      deviceFamily:   params.notYetDueDeviceFamily,
    }),
    queryInstallTotal(section, {
      approveMonths:  params.installTotalApproveMonths,
      productType:    params.installTotalProductType,
      deviceFamily:   params.installTotalDeviceFamily,
    }),
  ]);

  // Collect all approve_months
  const monthSet = new Set<string>();
  for (const r of countRows)     monthSet.add(r.approve_month);
  for (const r of targetRows)    monthSet.add(r.approve_month);
  for (const r of paidRows)      monthSet.add(r.approve_month);
  for (const r of dueRows)       monthSet.add(r.approve_month);
  for (const r of notYetDueRows)    monthSet.add(r.approve_month);
  for (const r of installTotalRows) monthSet.add(r.approve_month);

  const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

  // Build lookup maps
  type CellKey = string;
  const countMap = new Map<CellKey, number>();
  for (const r of countRows) {
    countMap.set(`${r.approve_month}|${r.bucket}`, n(r.contract_count));
  }

  const targetMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of targetRows) {
    targetMap.set(`${r.approve_month}|${r.bucket}`, {
      principal:          n(r.principal_target),
      interest:           n(r.interest_target),
      fee:                n(r.fee_target),
      penalty:            n(r.penalty_target),
      unlockFee:          n(r.unlock_fee_target),
      discount:           0,
      overpaid:           0,
      badDebt:            0,
      badDebtInstallment: 0,
      total:              n(r.total_target),
    });
  }

  const paidMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of paidRows) {
    paidMap.set(`${r.approve_month}|${r.bucket}`, {
      principal:          n(r.principal_paid),
      interest:           n(r.interest_paid),
      fee:                n(r.fee_paid),
      penalty:            n(r.penalty_paid),
      unlockFee:          n(r.unlock_fee_paid),
      discount:           n(r.discount_amount),
      overpaid:           n(r.overpaid_amount),
      badDebt:            n(r.device_sale_amount),
      badDebtInstallment: n(r.installment_paid),
      total:              n(r.total_paid),
    });
  }

  const dueMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of dueRows) {
    dueMap.set(`${r.approve_month}|${r.bucket}`, {
      principal:          n(r.principal_due),
      interest:           n(r.interest_due),
      fee:                n(r.fee_due),
      penalty:            n(r.penalty_due),
      unlockFee:          n(r.unlock_fee_due),
      discount:           0,
      overpaid:           0,
      badDebt:            0,
      badDebtInstallment: 0,
      total:              n(r.total_due),
    });
  }

  const notYetDueMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of notYetDueRows) {
    notYetDueMap.set(`${r.approve_month}|${r.bucket}`, {
      principal:          n(r.principal_notyet),
      interest:           n(r.interest_notyet),
      fee:                n(r.fee_notyet),
      penalty:            n(r.penalty_notyet),
      unlockFee:          n(r.unlock_fee_notyet),
      discount:           0,
      overpaid:           0,
      badDebt:            0,
      badDebtInstallment: 0,
      total:              n(r.total_notyet),
    });
  }

  const installTotalMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of installTotalRows) {
    installTotalMap.set(`${r.approve_month}|${r.bucket}`, {
      principal:          n(r.principal_install),
      interest:           n(r.interest_install),
      fee:                n(r.fee_install),
      penalty:            0,
      unlockFee:          0,
      discount:           0,
      overpaid:           0,
      badDebt:            0,
      badDebtInstallment: 0,
      total:              n(r.total_install),
    });
  }

  // Assemble MonthlySummaryRow[]
  return months.map((month) => {
    const buckets: Record<string, MonthlySummaryCell> = {};
    let totalCount = 0;
    const totalPaid         = emptyMoney();
    const totalDue          = emptyMoney();
    const totalTarget       = emptyMoney();
    const totalNotYetDue    = emptyMoney();
    const totalInstallTotal = emptyMoney();

    for (const bucket of DEBT_BUCKETS) {
      const key = `${month}|${bucket}`;
      const contractCount = countMap.get(key)      ?? 0;
      const paid          = paidMap.get(key)        ?? emptyMoney();
      const due           = dueMap.get(key)         ?? emptyMoney();
      const target        = targetMap.get(key)      ?? emptyMoney();
      const notYetDue     = notYetDueMap.get(key)    ?? emptyMoney();
      const installTotal  = installTotalMap.get(key)  ?? emptyMoney();

      buckets[bucket] = { contractCount, paid, due, target, notYetDue, installTotal };
      totalCount += contractCount;

      for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
        (totalPaid         as any)[k] += paid[k];
        (totalDue          as any)[k] += due[k];
        (totalTarget       as any)[k] += target[k];
        (totalNotYetDue    as any)[k] += notYetDue[k];
        (totalInstallTotal as any)[k] += installTotal[k];
      }
    }

    return { approveMonth: month, buckets, totalCount, totalPaid, totalDue, totalTarget, totalNotYetDue, totalInstallTotal };
  });
}

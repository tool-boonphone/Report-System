/**
 * Monthly Summary DB helpers — Phase 128
 *
 * Primary sources:
 *   - debt_target_cache  → Count tab + Target tab + Due tab + NotYetDue tab
 *   - debt_collected_cache → Paid tab
 *
 * Tabs:
 *   1. จำนวนสัญญา    (count)      — COUNT DISTINCT contract per approve_month+bucket
 *   2. ยอดที่ต้องชำระ (target)    — SUM total_amount WHERE is_future_period = false (ถึงกำหนดแล้ว)
 *   3. ยอดที่ชำระแล้ว (paid)      — SUM from debt_collected_cache
 *   4. ยอดค้างชำระ   (due)        — SUM (total_amount - paid_amount) WHERE is_arrears = true
 *                                    + penalty/unlockFee จากงวดล่าสุดของแต่ละสัญญาเท่านั้น
 *   5. ยอดที่ยังไม่ถึงกำหนด (notYetDue) — SUM total_amount WHERE is_future_period = true
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
import { pgRows } from "./db";

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
  badDebtInstallment: number; // paid side — ยอดค่างวดหนี้เสีย (total_amount สำหรับ is_bad_debt_row = false)
  total: number;
};

export type MonthlySummaryCell = {
  contractCount: number;
  paid: MoneyBreakdown;
  due: MoneyBreakdown;
  target: MoneyBreakdown;
  notYetDue: MoneyBreakdown;
  installTotal: MoneyBreakdown; // ยอดผ่อนรวม = SUM(baseline_amount) ทุกงวด (principal+interest+fee ก่อนหักชำระเกิน ไม่มีค่าปรับ/ค่าปลดล็อก)
};

export type MonthlySummaryRow = {
  approveMonth: string; // YYYY-MM
  buckets: Record<string, MonthlySummaryCell>;
  totalCount: number;
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
  totalTarget: MoneyBreakdown;
  totalNotYetDue: MoneyBreakdown;
  totalInstallTotal: MoneyBreakdown; // ยอดผ่อนรวม
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
  // Global search — ค้นหาตามเลขสัญญา / ชื่อลูกค้า / เบอร์โทร
  search?: string;
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
  "ยกเลิกสัญญา",
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
    WHEN dtc.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
    ELSE COALESCE(dtc.debt_range, 'ปกติ')
  END
`;

/** Escape value for SQL LIKE — prevent injection and wildcard abuse */
function escapeLike(s: string): string {
  return s.replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Build WHERE clause for debt_target_cache (base — no date filter) */
function dtcWhere(section: string, opts: {
  productType?: string;
  deviceFamily?: string;
  approveDate?: string;
  approveMonths?: string[];
  search?: string;
}): string {
  let w = `dtc.section = '${section}'
    AND dtc.approve_date IS NOT NULL`;

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
    w += `\n    AND TO_CHAR(dtc.approve_date, 'YYYY-MM') IN (${list})`;
  }
  if (opts.search) {
    const s = escapeLike(opts.search);
    w += `\n    AND (dtc.contract_no LIKE '%${s}%' OR dtc.customer_name LIKE '%${s}%')`;
  }
  return w;
}

/** Build WHERE clause for debt_collected_cache */
function dccWhere(section: string, opts: {
  productType?: string;
  deviceFamily?: string;
  paidAtDate?: string;
  paidAtMonths?: string[];
  search?: string;
}): string {
  // หมายเหตุ: ไม่ filter ยกเลิกสัญญา ออก เพราะสัญญายกเลิกอาจมียอดชำระเข้ามาก่อนยกเลิก ซึ่งต้องนับรวมในยอดเก็บหนี้
  let w = `dcc.section = '${section}'
    AND dcc.approve_date IS NOT NULL`;

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
    w += `\n    AND TO_CHAR(dcc.paid_at, 'YYYY-MM') IN (${list})`;
  }
  if (opts.search) {
    const s = escapeLike(opts.search);
    w += `\n    AND (dcc.contract_no LIKE '%${s}%' OR dcc.customer_name LIKE '%${s}%')`;
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
  search?: string;
}): Promise<Array<{
  approve_month: string;
  bucket: string;
  contract_count: number;
}>> {
  const db = await getDb(section);
  if (!db) return [];

  const q = `
    SELECT
      TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
      ${BUCKET_CASE_DTC} AS bucket,
      COUNT(DISTINCT dtc.contract_external_id) AS contract_count
    FROM debt_target_cache dtc
    WHERE ${dtcWhere(section, opts)}
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows);
}

// ---------------------------------------------------------------------------
// Query 2: Target tab — เป้าเก็บหนี้
// SUM(principal+interest+fee) WHERE due_date <= CURRENT_DATE (งวดที่ถึงกำหนดแล้วเท่านั้น)
// penalty/unlockFee: ดึงจากงวดล่าสุดที่ถึงกำหนดแล้ว (MAX period WHERE due_date <= CURRENT_DATE)
// ---------------------------------------------------------------------------
async function queryTarget(
  section: SectionKey,
  opts: {
    dueDate?: string;
    dueMonths?: string[];
    approveMonths?: string[];
    productType?: string;
    deviceFamily?: string;
    search?: string;
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
  const db = await getDb(section);
  if (!db) return [];

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });

  // due_date filter
  let dueDateFilter = "";
  if (opts.dueDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueDate}'`;
  } else if (opts.dueMonths && opts.dueMonths.length > 0) {
    const list = opts.dueMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND TO_CHAR(dtc.due_date, 'YYYY-MM') IN (${list})`;
  }

  /*
   * penalty และ unlock_fee ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น
   * ใช้ subquery หา MAX(period) per contract แล้ว JOIN กลับมา
   * สำหรับ total_amount, principal, interest, fee — SUM จากทุกงวดที่ถึงกำหนดแล้ว
   */
  const q = `
    SELECT
      TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
      CASE
        WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        WHEN base.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
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
        AND DATE(dtc.due_date) <= CURRENT_DATE
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE base.section = '${section}'
      AND DATE(base.due_date) <= CURRENT_DATE
      ${dueDateFilter.replace(/dtc\./g, "base.")}
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows);
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
    search?: string;
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
  const db = await getDb(section);
  if (!db) return [];

  // Phase 141+: ใช้ payment_tx_amount เป็น total base เหมือน DebtReport.tsx (source of truth)
  // Phase 141+ fix2: เพิ่ม bucket derivation จาก dcc.contract_status
  //   → สถานะพิเศษ (หนี้เสีย/ระงับ/สิ้นสุด/ยกเลิก) ใช้ contract_status โดยตรง
  //   → อื่นๆ = 'ปกติ' (dcc ไม่มี debt_range → bucket ย่อยเกิน 1-7 ฯลฯ รวมเป็น 'ปกติ')
  // - badge summary ยังถูกต้องเพราะ getMonthlySummary ใช้ totalPaid จาก paidMap|__paid__ โดยตรง
  // - per-bucket paid cell ใน table จะแสดงยอดตาม contract_status bucket
  // - payment_tx_amount = p.total = pt.amount จาก stream (ตรงกับ ptTotal ของหน้ายอดเก็บหนี้)
  // - isExtraPenalty = payment_tx_amount=0 AND penalty>0 AND is_bad_debt_row = false
  //   → ข้ามออกจาก penalty_paid และ total_paid เหมือน DebtReport.tsx
  // - total_paid = SUM(payment_tx_amount + bad_debt) ทุก row ยกเว้น isExtraPenalty
  // - installment_paid = SUM(payment_tx_amount) WHERE is_bad_debt_row = false AND NOT isExtraPenalty
  // - device_sale_amount = SUM(bad_debt) WHERE is_bad_debt_row = true
  const q = `
    SELECT
      TO_CHAR(dcc.approve_date, 'YYYY-MM') AS approve_month,
      CASE
        WHEN dcc.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN dcc.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN dcc.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        WHEN dcc.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
        ELSE COALESCE(dcc.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT dcc.contract_external_id) AS contract_count,
      -- breakdown fields: ข้าม isExtraPenalty rows (payment_tx_amount=0 AND penalty>0 AND is_bad_debt_row = false)
      -- เหมือน DebtReport.tsx บรรทัด 858-861
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.principal   AS DECIMAL(18,2)) ELSE 0 END) AS principal_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.interest    AS DECIMAL(18,2)) ELSE 0 END) AS interest_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.fee         AS DECIMAL(18,2)) ELSE 0 END) AS fee_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.penalty     AS DECIMAL(18,2)) ELSE 0 END) AS penalty_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.unlock_fee  AS DECIMAL(18,2)) ELSE 0 END) AS unlock_fee_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.discount    AS DECIMAL(18,2)) ELSE 0 END) AS discount_amount,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.overpaid    AS DECIMAL(18,2)) ELSE 0 END) AS overpaid_amount,
      -- installment_paid = SUM(payment_tx_amount) ยกเว้น isExtraPenalty
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) ELSE 0 END) AS installment_paid,
      SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2)) ELSE 0 END) AS device_sale_amount,
      -- total_paid = SUM(payment_tx_amount + bad_debt) ยกเว้น isExtraPenalty
      -- = ptTotal ของหน้ายอดเก็บหนี้ (DebtReport.tsx บรรทัด 872)
      SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2))
               WHEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                    AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0 THEN 0
               ELSE CAST(dcc.payment_tx_amount AS DECIMAL(18,2))
          END) AS total_paid
    FROM debt_collected_cache dcc
    WHERE ${dccWhere(section, { paidAtDate: opts.paidAtDate, paidAtMonths: opts.paidAtMonths, productType: opts.productType, deviceFamily: opts.deviceFamily, search: opts.search })}
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows);
}

// ---------------------------------------------------------------------------
// Query 4: Due tab — ยอดค้างชำระ
// SUM (total_amount - paid_amount) WHERE is_arrears = true
// penalty/unlockFee: ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น
// ---------------------------------------------------------------------------
async function queryDue(
  section: SectionKey,
  opts: {
    dueAtDate?: string;
    dueAtMonths?: string[];
    productType?: string;
    deviceFamily?: string;
    search?: string;
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
  const db = await getDb(section);
  if (!db) return [];

  // due_date filter
  let dueDateFilter = "";
  if (opts.dueAtDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueAtDate}'`;
  } else if (opts.dueAtMonths && opts.dueAtMonths.length > 0) {
    const list = opts.dueAtMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND TO_CHAR(dtc.due_date, 'YYYY-MM') IN (${list})`;
  }

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    search: opts.search,
  });

  /*
   * penalty/unlockFee ดึงจากงวดล่าสุดของแต่ละสัญญาเท่านั้น (MAX period WHERE is_arrears = true)
   * ยอดอื่น SUM จากทุกงวดที่ค้างชำระ
   */
  const q = `
    SELECT
      TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
      CASE
        WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        WHEN base.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
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
        AND dtc.is_arrears = true
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE base.section = '${section}'
      AND base.is_arrears = true
      ${dueDateFilter.replace(/dtc\./g, "base.")}
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows);
}

// ---------------------------------------------------------------------------
// Query 5: NotYetDue tab — ยอดที่ยังไม่ถึงกำหนด
// SUM total_amount WHERE is_future_period = true
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
    search?: string;
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
  const db = await getDb(section);
  if (!db) return [];

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });

  // due_date filter
  let dueDateFilter = "";
  if (opts.dueDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueDate}'`;
  } else if (opts.dueMonths && opts.dueMonths.length > 0) {
    const list = opts.dueMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND TO_CHAR(dtc.due_date, 'YYYY-MM') IN (${list})`;
  }

  /*
   * penalty/unlockFee ดึงจากงวดล่าสุดของแต่ละสัญญา (MAX period WHERE due_date > CURRENT_DATE)
   * หมายเหตุ: ใช้ due_date > CURRENT_DATE แทน is_future_period เพราะ is_future_period ถูก populate
   * ณ เวลา sync และอาจล้าสมัย ส่วน due_date > CURRENT_DATE คำนวณ real-time เสมอ
   */
  const q = `
    SELECT
      TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
      CASE
        WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        WHEN base.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
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
        AND dtc.due_date > CURRENT_DATE
        AND dtc.is_closed IS NOT TRUE
        AND dtc.is_paid IS NOT TRUE
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE base.section = '${section}'
      AND base.due_date > CURRENT_DATE
      AND base.is_closed IS NOT TRUE
      AND base.is_paid IS NOT TRUE
      ${dueDateFilter.replace(/dtc\./g, "base.")}
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows);
}

// ---------------------------------------------------------------------------
// Query 6: InstallTotal tab — ยอดผ่อนรวม
// SUM(baseline_amount) ทุกงวด (principal+interest+fee ก่อนหักชำระเกิน ไม่มีค่าปรับ/ค่าปลดล็อก)
// การจัดกลุ่ม bucket ใช้ contract_status ปัจจุบันของสัญญา
// ---------------------------------------------------------------------------
async function queryInstallTotal(
  section: SectionKey,
  opts: {
    approveMonths?: string[];
    productType?: string;
    deviceFamily?: string;
    search?: string;
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
  const db = await getDb(section);
  if (!db) return [];

  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
  });

  /*
   * Phase 9AK-fix2: ดึงจาก debt_target_cache โดยตรงเหมือน queryCount
   * ใช้ latest period (ROW_NUMBER DESC) เพื่อให้ bucket ตรงกับแถบสัญญา
   * Breakdown:
   *   total_install  = baseline_amount × installment_count  (ยอดผ่อนรวมทั้งสัญญา)
   *   principal_install = CEIL(finance_amount / installment_count) × installment_count
   *   fee_install    = 100 × installment_count
   *   interest_install = total_install - principal_install - fee_install
   */
  const q = `
    WITH latest AS (
      SELECT
        dtc.section,
        dtc.contract_external_id,
        dtc.contract_status,
        dtc.debt_range,
        dtc.approve_date,
        dtc.baseline_amount,
        dtc.installment_count,
        dtc.finance_amount,
        dtc.product_type,
        dtc.device,
        ROW_NUMBER() OVER (
          PARTITION BY dtc.section, dtc.contract_external_id
          ORDER BY dtc.period DESC
        ) AS rn
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
    )
    SELECT
      TO_CHAR(l.approve_date, 'YYYY-MM') AS approve_month,
      CASE
        WHEN l.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN l.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN l.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        WHEN l.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
        ELSE COALESCE(l.debt_range, 'ปกติ')
      END AS bucket,
      COUNT(DISTINCT l.contract_external_id) AS contract_count,
      -- principal = CEIL(finance_amount / installment_count) × installment_count
      SUM(
        CASE
          WHEN l.finance_amount > 0 AND l.installment_count > 0
          THEN CEIL(CAST(l.finance_amount AS DECIMAL(18,2)) / l.installment_count) * l.installment_count
          ELSE COALESCE(l.baseline_amount, 0) * COALESCE(l.installment_count, 0)
        END
      ) AS principal_install,
      -- interest = total - principal - fee
      SUM(
        CASE
          WHEN l.finance_amount > 0 AND l.installment_count > 0
            AND l.baseline_amount > 0
          THEN GREATEST(0,
            l.baseline_amount * l.installment_count
            - CEIL(CAST(l.finance_amount AS DECIMAL(18,2)) / l.installment_count) * l.installment_count
            - 100 * l.installment_count
          )
          ELSE 0
        END
      ) AS interest_install,
      -- fee = 100 × installment_count
      SUM(
        CASE
          WHEN l.finance_amount > 0 AND l.installment_count > 0
          THEN 100 * l.installment_count
          ELSE 0
        END
      ) AS fee_install,
      -- total = baseline_amount × installment_count
      SUM(COALESCE(l.baseline_amount, 0) * COALESCE(l.installment_count, 0)) AS total_install
    FROM latest l
    WHERE l.rn = 1
      ${opts.search ? `AND (l.contract_external_id LIKE '%${escapeLike(opts.search)}%')` : ''}
    GROUP BY 1, 2
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows);
}

// ---------------------------------------------------------------------------
// Main export: getMonthlySummary
// Fast path: ดึงจาก monthly_summary_cache ถ้าไม่มี search
// Fallback: รัน 6 queries สดถ้ามี search หรือ cache ว่าง
// ---------------------------------------------------------------------------
export async function getMonthlySummary(
  params: MonthlySummaryParams,
): Promise<MonthlySummaryRow[]> {
  const { section } = params;

  // Fast path: ถ้าไม่มี search → ลองดึงจาก cache ก่อน
  if (!params.search) {
    const cacheResult = await getMonthlySummaryFromCache(params);
    if (cacheResult !== null) return cacheResult;
  }

  // Fallback: รัน 6 queries สด (มี search หรือ cache ว่าง)
  // Run 6 queries in parallel
  const [countRows, targetRows, paidRows, dueRows, notYetDueRows, installTotalRows] = await Promise.all([
    queryCount(section, {
      productType:    params.countProductType,
      deviceFamily:   params.countDeviceFamily,
      approveDate:    params.countApproveDate,
      approveMonths:  params.countApproveMonths,
      search:         params.search,
    }),
    queryTarget(section, {
      dueDate:        params.targetDueDate,
      dueMonths:      params.targetDueMonths,
      approveMonths:  params.targetApproveMonths,
      productType:    params.targetProductType,
      deviceFamily:   params.targetDeviceFamily,
      search:         params.search,
    }),
    queryPaid(section, {
      paidAtDate:    params.paidAtDate,
      paidAtMonths:  params.paidAtMonths,
      productType:   params.paidProductType,
      deviceFamily:  params.paidDeviceFamily,
      search:        params.search,
    }),
    queryDue(section, {
      dueAtDate:    params.dueAtDate,
      dueAtMonths:  params.dueAtMonths,
      productType:  params.dueProductType,
      deviceFamily: params.dueDeviceFamily,
      search:       params.search,
    }),
    queryNotYetDue(section, {
      dueDate:        params.notYetDueDueDate,
      dueMonths:      params.notYetDueDueMonths,
      approveMonths:  params.notYetDueApproveMonths,
      productType:    params.notYetDueProductType,
      deviceFamily:   params.notYetDueDeviceFamily,
      search:         params.search,
    }),
    queryInstallTotal(section, {
      approveMonths:  params.installTotalApproveMonths,
      productType:    params.installTotalProductType,
      deviceFamily:   params.installTotalDeviceFamily,
      search:         params.search,
    }),
  ]);

  // Assemble MonthlySummaryRow[] โดยใช้ shared function
  return assembleMonthlySummaryRows(
    countRows as any[],
    targetRows as any[],
    paidRows as any[],
    dueRows as any[],
    notYetDueRows as any[],
    installTotalRows as any[],
  );
}

// ---------------------------------------------------------------------------
// populateMonthlySummaryCache — เรียกตอน Sync (Stage 8+)
// Pre-aggregate ทุก combination ของ productType × deviceFamily × dateMonth
// แล้วเขียนลง monthly_summary_cache ด้วย INSERT ... ON CONFLICT DO UPDATE
// ---------------------------------------------------------------------------

/** Filter dimensions ที่จะ iterate */
type FilterCombo = {
  productType: string | null;
  deviceFamily: "iOS" | "Android" | null;
  dateMonth: string | null; // YYYY-MM ของ paidAtMonth / dueMonth / approveMonth (ขึ้นกับ queryType)
};

/**
 * ดึง distinct values ของ productType, paidAtMonth, dueMonth จาก DB
 * เพื่อสร้าง filter combinations ทั้งหมด
 */
async function getFilterDimensions(section: SectionKey): Promise<{
  productTypes: Array<string | null>;
  deviceFamilies: Array<"iOS" | "Android" | null>;
  paidAtMonths: Array<string | null>;
  dueMonths: Array<string | null>;
  approveMonths: Array<string | null>;
}> {
  const db = await getDb(section);
  if (!db) return { productTypes: [null], deviceFamilies: [null], paidAtMonths: [null], dueMonths: [null], approveMonths: [null] };

  const [ptRows, paidRows, dueRows, approveRows] = await Promise.all([
    db.execute(sql.raw(`SELECT DISTINCT product_type FROM debt_target_cache WHERE section = '${section}' AND product_type IS NOT NULL ORDER BY 1`)),
    db.execute(sql.raw(`SELECT DISTINCT TO_CHAR(paid_at::date, 'YYYY-MM') AS m FROM debt_collected_cache WHERE section = '${section}' AND paid_at IS NOT NULL ORDER BY 1`)),
    db.execute(sql.raw(`SELECT DISTINCT TO_CHAR(due_date::date, 'YYYY-MM') AS m FROM debt_target_cache WHERE section = '${section}' AND due_date IS NOT NULL ORDER BY 1`)),
    db.execute(sql.raw(`SELECT DISTINCT TO_CHAR(approve_date::date, 'YYYY-MM') AS m FROM debt_target_cache WHERE section = '${section}' AND approve_date IS NOT NULL ORDER BY 1`)),
  ]);

  const productTypes: Array<string | null> = [null, ...pgRows(ptRows).map((r: any) => String(r.product_type))];
  const deviceFamilies: Array<"iOS" | "Android" | null> = [null, "iOS", "Android"];
  const paidAtMonths: Array<string | null> = [null, ...pgRows(paidRows).map((r: any) => String(r.m))];
  const dueMonths: Array<string | null> = [null, ...pgRows(dueRows).map((r: any) => String(r.m))];
  const approveMonths: Array<string | null> = [null, ...pgRows(approveRows).map((r: any) => String(r.m))];

  return { productTypes, deviceFamilies, paidAtMonths, dueMonths, approveMonths };
}

/**
 * Upsert rows เข้า monthly_summary_cache
 * ใช้ INSERT ... ON CONFLICT DO UPDATE เพื่อ idempotent
 */
async function upsertMonthlySummaryRows(
  section: SectionKey,
  queryType: string,
  rows: Array<{
    approve_month: string;
    bucket: string;
    productType: string | null;
    deviceFamily: string | null;
    dateMonth: string | null;
    contractCount: number;
    principal: number;
    interest: number;
    fee: number;
    penalty: number;
    unlockFee: number;
    discount: number;
    overpaid: number;
    badDebt: number;
    badDebtInstallment: number;
    totalAmount: number;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb(section);
  if (!db) return;

  // Batch insert 500 rows ต่อครั้ง
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map((r) => {
      const pt = r.productType ? `'${r.productType.replace(/'/g, "''")}'` : "NULL";
      const df = r.deviceFamily ? `'${r.deviceFamily}'` : "NULL";
      const dm = r.dateMonth ? `'${r.dateMonth}'` : "NULL";
      return `('${section}','${queryType}','${r.approve_month}','${r.bucket}',${pt},${df},${dm},${r.contractCount},${r.principal},${r.interest},${r.fee},${r.penalty},${r.unlockFee},${r.discount},${r.overpaid},${r.badDebt},${r.badDebtInstallment},${r.totalAmount},NOW())`;
    }).join(",\n");

    const upsertSql = `
      INSERT INTO monthly_summary_cache
        (section, query_type, approve_month, bucket, product_type, device_family, date_month,
         contract_count, principal, interest, fee, penalty, unlock_fee, discount, overpaid,
         bad_debt, bad_debt_installment, total_amount, updated_at)
      VALUES ${values}
      ON CONFLICT (section, query_type, approve_month, bucket,
                   COALESCE(product_type,''), COALESCE(device_family,''), COALESCE(date_month,''))
      DO UPDATE SET
        contract_count       = EXCLUDED.contract_count,
        principal            = EXCLUDED.principal,
        interest             = EXCLUDED.interest,
        fee                  = EXCLUDED.fee,
        penalty              = EXCLUDED.penalty,
        unlock_fee           = EXCLUDED.unlock_fee,
        discount             = EXCLUDED.discount,
        overpaid             = EXCLUDED.overpaid,
        bad_debt             = EXCLUDED.bad_debt,
        bad_debt_installment = EXCLUDED.bad_debt_installment,
        total_amount         = EXCLUDED.total_amount,
        updated_at           = NOW()
    `;
    await db.execute(sql.raw(upsertSql));
  }
}

/**
 * populateMonthlySummaryCache — เรียกตอน Sync หลัง populateDebtCache
 * รัน 6 queries สำหรับทุก combination ของ productType × deviceFamily × dateMonth
 * แล้วเขียนลง monthly_summary_cache
 */
export async function populateMonthlySummaryCache(section: SectionKey): Promise<number> {
  const dims = await getFilterDimensions(section);
  let totalRows = 0;

  // ── Query 1: count ────────────────────────────────────────────────────────
  for (const pt of dims.productTypes) {
    for (const df of dims.deviceFamilies) {
      const rows = await queryCount(section, { productType: pt ?? undefined, deviceFamily: df ?? undefined });
      const mapped = rows.map((r) => ({
        approve_month: r.approve_month,
        bucket: r.bucket,
        productType: pt,
        deviceFamily: df,
        dateMonth: null,
        contractCount: r.contract_count,
        principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0,
        discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
        totalAmount: 0,
      }));
      await upsertMonthlySummaryRows(section, "count", mapped);
      totalRows += mapped.length;
    }
  }

  // ── Query 2: target ───────────────────────────────────────────────────────
  // dateMonth = dueMonth (filter ตาม due_date month)
  for (const pt of dims.productTypes) {
    for (const df of dims.deviceFamilies) {
      for (const dm of dims.dueMonths) {
        const rows = await queryTarget(section, {
          productType: pt ?? undefined,
          deviceFamily: df ?? undefined,
          dueMonths: dm ? [dm] : undefined,
        });
        const mapped = rows.map((r) => ({
          approve_month: r.approve_month,
          bucket: r.bucket,
          productType: pt,
          deviceFamily: df,
          dateMonth: dm,
          contractCount: r.contract_count,
          principal: r.principal_target, interest: r.interest_target, fee: r.fee_target,
          penalty: r.penalty_target, unlockFee: r.unlock_fee_target,
          discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
          totalAmount: r.total_target,
        }));
        await upsertMonthlySummaryRows(section, "target", mapped);
        totalRows += mapped.length;
      }
    }
  }

  // ── Query 3: paid ─────────────────────────────────────────────────────────
  // dateMonth = paidAtMonth (filter ตาม paid_at month)
  for (const pt of dims.productTypes) {
    for (const df of dims.deviceFamilies) {
      for (const dm of dims.paidAtMonths) {
        const rows = await queryPaid(section, {
          productType: pt ?? undefined,
          deviceFamily: df ?? undefined,
          paidAtMonths: dm ? [dm] : undefined,
        });
        const mapped = rows.map((r) => ({
          approve_month: r.approve_month,
          bucket: r.bucket,
          productType: pt,
          deviceFamily: df,
          dateMonth: dm,
          contractCount: r.contract_count,
          principal: r.principal_paid, interest: r.interest_paid, fee: r.fee_paid,
          penalty: r.penalty_paid, unlockFee: r.unlock_fee_paid,
          discount: r.discount_amount, overpaid: r.overpaid_amount,
          badDebt: r.device_sale_amount, badDebtInstallment: r.installment_paid,
          totalAmount: r.total_paid,
        }));
        await upsertMonthlySummaryRows(section, "paid", mapped);
        totalRows += mapped.length;
      }
    }
  }

  // ── Query 4: due ──────────────────────────────────────────────────────────
  // dateMonth = dueAtMonth (filter ตาม due_date month)
  for (const pt of dims.productTypes) {
    for (const df of dims.deviceFamilies) {
      for (const dm of dims.dueMonths) {
        const rows = await queryDue(section, {
          productType: pt ?? undefined,
          deviceFamily: df ?? undefined,
          dueAtMonths: dm ? [dm] : undefined,
        });
        const mapped = rows.map((r) => ({
          approve_month: r.approve_month,
          bucket: r.bucket,
          productType: pt,
          deviceFamily: df,
          dateMonth: dm,
          contractCount: r.contract_count,
          principal: r.principal_due, interest: r.interest_due, fee: r.fee_due,
          penalty: r.penalty_due, unlockFee: r.unlock_fee_due,
          discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
          totalAmount: r.total_due,
        }));
        await upsertMonthlySummaryRows(section, "due", mapped);
        totalRows += mapped.length;
      }
    }
  }

  // ── Query 5: notYetDue ────────────────────────────────────────────────────
  // dateMonth = dueMonth (filter ตาม due_date month)
  for (const pt of dims.productTypes) {
    for (const df of dims.deviceFamilies) {
      for (const dm of dims.dueMonths) {
        const rows = await queryNotYetDue(section, {
          productType: pt ?? undefined,
          deviceFamily: df ?? undefined,
          dueMonths: dm ? [dm] : undefined,
        });
        const mapped = rows.map((r) => ({
          approve_month: r.approve_month,
          bucket: r.bucket,
          productType: pt,
          deviceFamily: df,
          dateMonth: dm,
          contractCount: r.contract_count,
          principal: r.principal_notyet, interest: r.interest_notyet, fee: r.fee_notyet,
          penalty: r.penalty_notyet, unlockFee: r.unlock_fee_notyet,
          discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
          totalAmount: r.total_notyet,
        }));
        await upsertMonthlySummaryRows(section, "notYetDue", mapped);
        totalRows += mapped.length;
      }
    }
  }

  // ── Query 6: installTotal ─────────────────────────────────────────────────
  // ไม่มี dateMonth filter (installTotal ไม่มี due/paid filter)
  for (const pt of dims.productTypes) {
    for (const df of dims.deviceFamilies) {
      const rows = await queryInstallTotal(section, {
        productType: pt ?? undefined,
        deviceFamily: df ?? undefined,
      });
      const mapped = rows.map((r) => ({
        approve_month: r.approve_month,
        bucket: r.bucket,
        productType: pt,
        deviceFamily: df,
        dateMonth: null,
        contractCount: r.contract_count,
        principal: r.principal_install, interest: r.interest_install, fee: r.fee_install,
        penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
        totalAmount: r.total_install,
      }));
      await upsertMonthlySummaryRows(section, "installTotal", mapped);
      totalRows += mapped.length;
    }
  }

  return totalRows;
}

// ---------------------------------------------------------------------------
// getMonthlySummaryFromCache — Fast path: ดึงจาก monthly_summary_cache
// ใช้เมื่อไม่มี search filter
// ---------------------------------------------------------------------------
async function getMonthlySummaryFromCache(
  params: MonthlySummaryParams,
): Promise<MonthlySummaryRow[] | null> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return null;

  // ตรวจว่า cache มีข้อมูลไหม
  const checkRows = await db.execute(sql.raw(
    `SELECT COUNT(*) AS cnt FROM monthly_summary_cache WHERE section = '${section}'`
  ));
  const cnt = parseInt(String((pgRows(checkRows)[0] as any)?.cnt ?? "0"), 10);
  if (cnt === 0) return null; // cache ว่าง → fallback

  // Helper: แปลง filter param เป็น SQL condition สำหรับ date_month
  function dateMonthCond(months: string[] | undefined, singleDate: string | undefined): string {
    if (singleDate) {
      // exact date → ดึง YYYY-MM แล้วเทียบ
      const m = singleDate.substring(0, 7);
      return `date_month = '${m}'`;
    }
    if (months && months.length > 0) {
      const list = months.map((m) => `'${m}'`).join(",");
      return `date_month IN (${list})`;
    }
    return `date_month IS NULL`;
  }

  function productTypeCond(pt: string | undefined): string {
    if (pt) return `product_type = '${pt.replace(/'/g, "''")}'`;
    return `product_type IS NULL`;
  }

  function deviceFamilyCond(df: string | undefined): string {
    if (df) return `device_family = '${df}'`;
    return `device_family IS NULL`;
  }

  // ดึงแต่ละ query_type พร้อมกัน
  const [countRows, targetRows, paidRows, dueRows, notYetDueRows, installTotalRows] = await Promise.all([
    // count: ไม่มี dateMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'count'
        AND ${productTypeCond(params.countProductType)}
        AND ${deviceFamilyCond(params.countDeviceFamily)}
        AND date_month IS NULL
      ORDER BY approve_month DESC
    `)),
    // target: dueMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_target, interest AS interest_target,
             fee AS fee_target, penalty AS penalty_target,
             unlock_fee AS unlock_fee_target, total_amount AS total_target
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'target'
        AND ${productTypeCond(params.targetProductType)}
        AND ${deviceFamilyCond(params.targetDeviceFamily)}
        AND ${dateMonthCond(params.targetDueMonths, params.targetDueDate)}
      ORDER BY approve_month DESC
    `)),
    // paid: paidAtMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_paid, interest AS interest_paid,
             fee AS fee_paid, penalty AS penalty_paid,
             unlock_fee AS unlock_fee_paid, discount AS discount_amount,
             overpaid AS overpaid_amount, bad_debt AS device_sale_amount,
             bad_debt_installment AS installment_paid, total_amount AS total_paid
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'paid'
        AND ${productTypeCond(params.paidProductType)}
        AND ${deviceFamilyCond(params.paidDeviceFamily)}
        AND ${dateMonthCond(params.paidAtMonths, params.paidAtDate)}
      ORDER BY approve_month DESC
    `)),
    // due: dueAtMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_due, interest AS interest_due,
             fee AS fee_due, penalty AS penalty_due,
             unlock_fee AS unlock_fee_due, total_amount AS total_due
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'due'
        AND ${productTypeCond(params.dueProductType)}
        AND ${deviceFamilyCond(params.dueDeviceFamily)}
        AND ${dateMonthCond(params.dueAtMonths, params.dueAtDate)}
      ORDER BY approve_month DESC
    `)),
    // notYetDue: dueMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_notyet, interest AS interest_notyet,
             fee AS fee_notyet, penalty AS penalty_notyet,
             unlock_fee AS unlock_fee_notyet, total_amount AS total_notyet
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'notYetDue'
        AND ${productTypeCond(params.notYetDueProductType)}
        AND ${deviceFamilyCond(params.notYetDueDeviceFamily)}
        AND ${dateMonthCond(params.notYetDueDueMonths, params.notYetDueDueDate)}
      ORDER BY approve_month DESC
    `)),
    // installTotal: ไม่มี dateMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_install, interest AS interest_install,
             fee AS fee_install, total_amount AS total_install
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'installTotal'
        AND ${productTypeCond(params.installTotalProductType)}
        AND ${deviceFamilyCond(params.installTotalDeviceFamily)}
        AND date_month IS NULL
      ORDER BY approve_month DESC
    `)),
  ]);

  // Re-use assembly logic เหมือน getMonthlySummary เดิม
  return assembleMonthlySummaryRows(
    pgRows(countRows) as any[],
    pgRows(targetRows) as any[],
    pgRows(paidRows) as any[],
    pgRows(dueRows) as any[],
    pgRows(notYetDueRows) as any[],
    pgRows(installTotalRows) as any[],
  );
}

// ---------------------------------------------------------------------------
// assembleMonthlySummaryRows — shared assembly logic
// ---------------------------------------------------------------------------
function assembleMonthlySummaryRows(
  countRows: any[],
  targetRows: any[],
  paidRows: any[],
  dueRows: any[],
  notYetDueRows: any[],
  installTotalRows: any[],
): MonthlySummaryRow[] {
  const monthSet = new Set<string>();
  for (const r of countRows)     monthSet.add(r.approve_month);
  for (const r of targetRows)    monthSet.add(r.approve_month);
  for (const r of paidRows)      monthSet.add(r.approve_month);
  for (const r of dueRows)       monthSet.add(r.approve_month);
  for (const r of notYetDueRows)    monthSet.add(r.approve_month);
  for (const r of installTotalRows) monthSet.add(r.approve_month);

  const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

  type CellKey = string;
  const countMap = new Map<CellKey, number>();
  for (const r of countRows) {
    countMap.set(`${r.approve_month}|${r.bucket}`, n(r.contract_count));
  }

  const targetMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of targetRows) {
    targetMap.set(`${r.approve_month}|${r.bucket}`, {
      principal: n(r.principal_target), interest: n(r.interest_target),
      fee: n(r.fee_target), penalty: n(r.penalty_target), unlockFee: n(r.unlock_fee_target),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_target),
    });
  }

  const paidMap = new Map<CellKey, MoneyBreakdown>();
  const paidTotalMap = new Map<string, MoneyBreakdown>();
  for (const r of paidRows) {
    const cell: MoneyBreakdown = {
      principal: n(r.principal_paid), interest: n(r.interest_paid),
      fee: n(r.fee_paid), penalty: n(r.penalty_paid), unlockFee: n(r.unlock_fee_paid),
      discount: n(r.discount_amount), overpaid: n(r.overpaid_amount),
      badDebt: n(r.device_sale_amount), badDebtInstallment: n(r.installment_paid),
      total: n(r.total_paid),
    };
    paidMap.set(`${r.approve_month}|${r.bucket}`, cell);
    const acc = paidTotalMap.get(r.approve_month) ?? emptyMoney();
    for (const k of Object.keys(acc) as (keyof MoneyBreakdown)[]) {
      (acc as any)[k] += (cell as any)[k];
    }
    paidTotalMap.set(r.approve_month, acc);
  }

  const dueMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of dueRows) {
    dueMap.set(`${r.approve_month}|${r.bucket}`, {
      principal: n(r.principal_due), interest: n(r.interest_due),
      fee: n(r.fee_due), penalty: n(r.penalty_due), unlockFee: n(r.unlock_fee_due),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_due),
    });
  }

  const notYetDueMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of notYetDueRows) {
    notYetDueMap.set(`${r.approve_month}|${r.bucket}`, {
      principal: n(r.principal_notyet), interest: n(r.interest_notyet),
      fee: n(r.fee_notyet), penalty: n(r.penalty_notyet), unlockFee: n(r.unlock_fee_notyet),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_notyet),
    });
  }

  const installTotalMap = new Map<CellKey, MoneyBreakdown>();
  for (const r of installTotalRows) {
    installTotalMap.set(`${r.approve_month}|${r.bucket}`, {
      principal: n(r.principal_install), interest: n(r.interest_install),
      fee: n(r.fee_install), penalty: 0, unlockFee: 0,
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_install),
    });
  }

  return months.map((month) => {
    const buckets: Record<string, MonthlySummaryCell> = {};
    let totalCount = 0;
    const totalPaid         = emptyMoney();
    const totalDue          = emptyMoney();
    const totalTarget       = emptyMoney();
    const totalNotYetDue    = emptyMoney();
    const totalInstallTotal = emptyMoney();

    const totalPaidDirect = paidTotalMap.get(month) ?? emptyMoney();
    for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
      (totalPaid as any)[k] = (totalPaidDirect as any)[k];
    }

    for (const bucket of DEBT_BUCKETS) {
      const key = `${month}|${bucket}`;
      const contractCount = countMap.get(key) ?? 0;
      const paid          = paidMap.get(key) ?? emptyMoney();
      const due           = dueMap.get(key) ?? emptyMoney();
      const target        = targetMap.get(key) ?? emptyMoney();
      const notYetDue     = notYetDueMap.get(key) ?? emptyMoney();
      const installTotal  = installTotalMap.get(key) ?? emptyMoney();

      buckets[bucket] = { contractCount, paid, due, target, notYetDue, installTotal };
      totalCount += contractCount;

      for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
        (totalDue          as any)[k] += due[k];
        (totalTarget       as any)[k] += target[k];
        (totalNotYetDue    as any)[k] += notYetDue[k];
        (totalInstallTotal as any)[k] += installTotal[k];
      }
    }

    return { approveMonth: month, buckets, totalCount, totalPaid, totalDue, totalTarget, totalNotYetDue, totalInstallTotal };
  });
}

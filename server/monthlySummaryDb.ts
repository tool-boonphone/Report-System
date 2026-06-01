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
  financeTotal: number;         // ยอดจัดฯ = SUM(finance_amount) ต่อสัญญา
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
  totalFinanceTotal: number;         // ยอดจัดฯ รวมทุก bucket
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
  paidAtMonths?: string[];         // multi YYYY-MM (paid_at) — ใช้ใน live query fallback เท่านั้น
  paidApproveMonths?: string[];    // multi YYYY-MM (approve_date) — ใช้ใน cache query
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
  return { contractCount: 0, paid: emptyMoney(), due: emptyMoney(), target: emptyMoney(), notYetDue: emptyMoney(), installTotal: emptyMoney(), financeTotal: 0 };
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
    // เพิ่มค้นหาเบอร์โทรศัพท์ (ค้นหาจากตาราง contracts ผ่าน subquery หรือ join)
    // แต่เนื่องจากเรา query จาก debt_target_cache (dtc) ซึ่งอาจจะไม่มีเบอร์โทรใน cache
    // เราสามารถ join กับ contracts เพื่อค้นหาเบอร์โทรได้
    w += `\n    AND (dtc.contract_no LIKE '%${s}%' OR dtc.customer_name LIKE '%${s}%' OR dtc.contract_external_id IN (SELECT c.external_id FROM contracts c WHERE c.phone LIKE '%${s}%'))`;
  }
  return w;
}

/** Build WHERE clause for debt_collected_cache */
function dccWhere(section: string, opts: {
  productType?: string;
  deviceFamily?: string;
  paidAtDate?: string;
  paidAtMonths?: string[];
  approveMonths?: string[];
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
  if (opts.approveMonths && opts.approveMonths.length > 0) {
    const list = opts.approveMonths.map((m) => `'${m}'`).join(",");
    w += `\n    AND TO_CHAR(dcc.approve_date, 'YYYY-MM') IN (${list})`;
  }
  if (opts.search) {
    const s = escapeLike(opts.search);
    w += `\n    AND (dcc.contract_no LIKE '%${s}%' OR dcc.customer_name LIKE '%${s}%' OR dcc.contract_external_id IN (SELECT c.external_id FROM contracts c WHERE c.phone LIKE '%${s}%'))`;
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
  // baseWhere ใช้ alias dtc. → แปลงเป็น base. สำหรับ outer query
  const baseWhereForOuter = baseWhere.replace(/\bdtc\./g, "base.");

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
   * Bug fix: outer query ต้องใช้ baseWhereForOuter (มี filter productType/deviceFamily/approveMonths)
   *          ไม่ใช่แค่ section filter เพียงอย่างเดียว
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
    WHERE ${baseWhereForOuter}
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
    approveMonths?: string[];
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
    WHERE ${dccWhere(section, { paidAtDate: opts.paidAtDate, paidAtMonths: opts.paidAtMonths, approveMonths: opts.approveMonths, productType: opts.productType, deviceFamily: opts.deviceFamily, search: opts.search })}
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
   * Phase 141-fix3: เปลี่ยน logic ให้ตรงกับ DebtOverview
   * DebtOverview ข้ามเฉพาะ installment ที่ isSuspended = true (ระดับงวด)
   * ไม่ตัดทั้งสัญญาออกเพราะ contract_status = ระงับ/สิ้นสุด/หนี้เสีย
   * เพราะสัญญาที่ระงับอาจยังมีงวดอนาคตที่ is_suspended = false อยู่
   *
   * penalty/unlockFee ดึงจากงวดล่าสุดของแต่ละสัญญา (MAX period WHERE due_date > CURRENT_DATE)
   * ยกเว้น ยกเลิกสัญญา ซึ่งไม่มีงวดอนาคตจริง
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
      -- ดึง max_period สำหรับ penalty/unlockFee
      -- ข้ามเฉพาะ installment ที่ is_suspended = true (ระดับงวด) เหมือน DebtOverview
      -- ไม่ตัดทั้งสัญญาออกเพราะ contract_status
      SELECT dtc.section, dtc.contract_external_id, MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.due_date > CURRENT_DATE
        AND dtc.is_closed IS NOT TRUE
        AND COALESCE(dtc.is_suspended, false) IS NOT TRUE
        AND COALESCE(dtc.contract_status, '') NOT IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา')
        ${dueDateFilter}
      GROUP BY dtc.section, dtc.contract_external_id
        ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
    WHERE ${baseWhere.replace(/dtc\./g, "base.")}
      AND base.due_date > CURRENT_DATE
      AND base.is_closed IS NOT TRUE
      AND COALESCE(base.is_suspended, false) IS NOT TRUE
      AND COALESCE(base.contract_status, '') NOT IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา')
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
  finance_total: number;
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
      SUM(COALESCE(l.baseline_amount, 0) * COALESCE(l.installment_count, 0)) AS total_install,
      -- finance_total = SUM(finance_amount) ต่อสัญญา (ยอดจัดฯ)
      SUM(COALESCE(l.finance_amount, 0)) AS finance_total
    FROM latest l
    WHERE l.rn = 1
      ${opts.search ? `AND (l.contract_external_id IN (SELECT c.external_id FROM contracts c WHERE c.contract_no LIKE '%${escapeLike(opts.search)}%' OR c.customer_name LIKE '%${escapeLike(opts.search)}%' OR c.phone LIKE '%${escapeLike(opts.search)}%'))` : ''}
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

  // NOTE: ใช้ live query เสมอ (cache disabled เพื่อความถูกต้องของข้อมูล)
  console.log(`[getMonthlySummary] LIVE QUERY — section=${section}`);

  // รัน 6 queries สด
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
      approveMonths: params.paidApproveMonths,
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
    financeTotal?: number;
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
      return `('${section}','${queryType}','${r.approve_month}','${r.bucket}',${pt},${df},${dm},${r.contractCount},${r.principal},${r.interest},${r.fee},${r.penalty},${r.unlockFee},${r.discount},${r.overpaid},${r.badDebt},${r.badDebtInstallment},${r.totalAmount},${r.financeTotal ?? 0},NOW())`;
    }).join(",\n");

    const upsertSql = `
      INSERT INTO monthly_summary_cache
        (section, query_type, approve_month, bucket, product_type, device_family, date_month,
         contract_count, principal, interest, fee, penalty, unlock_fee, discount, overpaid,
         bad_debt, bad_debt_installment, total_amount, finance_total, updated_at)
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
        finance_total        = EXCLUDED.finance_total,
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
/**
 * buildMscBatchCombinations — แปลง batch query rows (มี product_type + device_family + date_month)
 * ให้เป็น upsert rows ที่ครอบคลุมทุก combination:
 * 1. (productType=actual, deviceFamily=actual) — ตรงตาม row จริง
 * 2. (productType=actual, deviceFamily=null) — รวม df ทุกตัวของ pt นั้น
 * 3. (productType=null, deviceFamily=actual) — รวม pt ทุกตัวของ df นั้น
 * 4. (productType=null, deviceFamily=null) — รวมทั้งหมด
 * โดย aggregate ด้วย SUM ของ contractCount และ numeric fields
 */
function buildMscBatchCombinations(
  rawRows: Array<{
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
    financeTotal?: number;
  }>,
): typeof rawRows {
  type Row = (typeof rawRows)[0];
  const agg = new Map<string, Row>();

  function addToMap(key: string, row: Row) {
    const existing = agg.get(key);
    if (!existing) {
      agg.set(key, { ...row });
    } else {
      existing.contractCount += row.contractCount;
      existing.principal += row.principal;
      existing.interest += row.interest;
      existing.fee += row.fee;
      existing.penalty += row.penalty;
      existing.unlockFee += row.unlockFee;
      existing.discount += row.discount;
      existing.overpaid += row.overpaid;
      existing.badDebt += row.badDebt;
      existing.badDebtInstallment += row.badDebtInstallment;
      existing.totalAmount += row.totalAmount;
      if (row.financeTotal !== undefined) {
        existing.financeTotal = (existing.financeTotal ?? 0) + row.financeTotal;
      }
    }
  }

  for (const row of rawRows) {
    const am = row.approve_month;
    const bk = row.bucket;
    const dm = row.dateMonth ?? "null";
    const pt = row.productType ?? "null";
    const df = row.deviceFamily ?? "null";

    // Combination 1: actual pt + actual df
    addToMap(`${am}|${bk}|${dm}|${pt}|${df}`, { ...row, productType: row.productType, deviceFamily: row.deviceFamily });
    // Combination 2: actual pt + null df
    addToMap(`${am}|${bk}|${dm}|${pt}|null`, { ...row, productType: row.productType, deviceFamily: null });
    // Combination 3: null pt + actual df
    addToMap(`${am}|${bk}|${dm}|null|${df}`, { ...row, productType: null, deviceFamily: row.deviceFamily });
    // Combination 4: null pt + null df
    addToMap(`${am}|${bk}|${dm}|null|null`, { ...row, productType: null, deviceFamily: null });
  }

  return Array.from(agg.values());
}

/**
 * populateMonthlySummaryCache — เรียกตอน Sync หลัง populateDebtCache
 * BATCH version: ใช้ 6 queries แทน N×M×6 sequential queries
 * แต่ละ query เพิ่ม product_type + device + date_month เข้า GROUP BY
 * แล้ว aggregate combinations ใน JavaScript ด้วย buildMscBatchCombinations
 */
export async function populateMonthlySummaryCache(
  section: SectionKey,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;
  let totalRows = 0;
  const TOTAL_STEPS = 6;
  let doneSteps = 0;

  // ── Helper: map deviceFamily string to iOS/Android/null ──────────────────
  function toDeviceFamily(device: string | null): "iOS" | "Android" | null {
    if (!device) return null;
    if (device === "iOS") return "iOS";
    if (device === "Android") return "Android";
    return null;
  }

  // ── Query 1: count (BATCH) ────────────────────────────────────────────────
  {
    const baseWhere = `dtc.section = '${section}' AND dtc.approve_date IS NOT NULL`;
    const q = `
      SELECT
        TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
        ${BUCKET_CASE_DTC} AS bucket,
        dtc.product_type,
        CASE
          WHEN dtc.device IN ('iPhone', 'iPad') THEN 'iOS'
          WHEN dtc.device IS NOT NULL AND dtc.device != '' THEN 'Android'
          ELSE NULL
        END AS device_family,
        COUNT(DISTINCT dtc.contract_external_id) AS contract_count
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 DESC
    `;
    const rawRows = pgRows(await db.execute(sql.raw(q)));
    const mapped = rawRows.map((r: any) => ({
      approve_month: String(r.approve_month),
      bucket: String(r.bucket),
      productType: r.product_type ? String(r.product_type) : null,
      deviceFamily: toDeviceFamily(r.device_family),
      dateMonth: null as string | null,
      contractCount: Number(r.contract_count),
      principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0,
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: 0,
    }));
    const combined = buildMscBatchCombinations(mapped);
    await upsertMonthlySummaryRows(section, "count", combined);
    totalRows += combined.length;
    doneSteps++;
    onProgress?.(doneSteps, TOTAL_STEPS);
  }

  // ── Query 2: target (BATCH) ───────────────────────────────────────────────
  {
    const baseWhere = `dtc.section = '${section}' AND dtc.approve_date IS NOT NULL`;
    const q = `
      SELECT
        TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
        CASE
          WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
          WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
          WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
          WHEN base.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
          ELSE COALESCE(base.debt_range, 'ปกติ')
        END AS bucket,
        base.product_type,
        CASE
          WHEN base.device IN ('iPhone', 'iPad') THEN 'iOS'
          WHEN base.device IS NOT NULL AND base.device != '' THEN 'Android'
          ELSE NULL
        END AS device_family,
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
        GROUP BY dtc.section, dtc.contract_external_id
      ) latest ON latest.section = base.section
               AND latest.contract_external_id = base.contract_external_id
      WHERE base.section = '${section}'
        AND base.approve_date IS NOT NULL
        AND DATE(base.due_date) <= CURRENT_DATE
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1 DESC
    `;
    const rawRows = pgRows(await db.execute(sql.raw(q)));
    const mapped = rawRows.map((r: any) => ({
      approve_month: String(r.approve_month),
      bucket: String(r.bucket),
      productType: r.product_type ? String(r.product_type) : null,
      deviceFamily: toDeviceFamily(r.device_family),
      dateMonth: r.due_month ? String(r.due_month) : null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_target), interest: Number(r.interest_target), fee: Number(r.fee_target),
      penalty: Number(r.penalty_target), unlockFee: Number(r.unlock_fee_target),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_target),
    }));
    const combined = buildMscBatchCombinations(mapped);
    await upsertMonthlySummaryRows(section, "target", combined);
    totalRows += combined.length;
    doneSteps++;
    onProgress?.(doneSteps, TOTAL_STEPS);
  }

  // ── Query 3: paid (BATCH) ─────────────────────────────────────────────────
  {
    const baseWhere = `dcc.section = '${section}' AND dcc.approve_date IS NOT NULL`;
    const q = `
      SELECT
        TO_CHAR(dcc.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(dcc.approve_date, 'YYYY-MM') AS approve_month_key,
        CASE
          WHEN dcc.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
          WHEN dcc.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
          WHEN dcc.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
          WHEN dcc.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
          ELSE COALESCE(dcc.debt_range, 'ปกติ')
        END AS bucket,
        dcc.product_type,
        CASE
          WHEN dcc.device IN ('iPhone', 'iPad') THEN 'iOS'
          WHEN dcc.device IS NOT NULL AND dcc.device != '' THEN 'Android'
          ELSE NULL
        END AS device_family,
        COUNT(DISTINCT dcc.contract_external_id) AS contract_count,
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
        SUM(CASE WHEN dcc.is_bad_debt_row = false
                      AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                               AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
                 THEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) ELSE 0 END) AS installment_paid,
        SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2)) ELSE 0 END) AS device_sale_amount,
        SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2))
                 WHEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                      AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0 THEN 0
                 ELSE CAST(dcc.payment_tx_amount AS DECIMAL(18,2))
            END) AS total_paid
      FROM debt_collected_cache dcc
      WHERE ${baseWhere}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1 DESC
    `;
    const rawRows = pgRows(await db.execute(sql.raw(q)));
    const mapped = rawRows.map((r: any) => ({
      approve_month: String(r.approve_month),
      bucket: String(r.bucket),
      productType: r.product_type ? String(r.product_type) : null,
      deviceFamily: toDeviceFamily(r.device_family),
      dateMonth: r.approve_month_key ? String(r.approve_month_key) : null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_paid), interest: Number(r.interest_paid), fee: Number(r.fee_paid),
      penalty: Number(r.penalty_paid), unlockFee: Number(r.unlock_fee_paid),
      discount: Number(r.discount_amount), overpaid: Number(r.overpaid_amount),
      badDebt: Number(r.device_sale_amount), badDebtInstallment: Number(r.installment_paid),
      totalAmount: Number(r.total_paid),
    }));
    const combined = buildMscBatchCombinations(mapped);
    await upsertMonthlySummaryRows(section, "paid", combined);
    totalRows += combined.length;
    doneSteps++;
    onProgress?.(doneSteps, TOTAL_STEPS);
  }

  // ── Query 4: due (BATCH) ──────────────────────────────────────────────────
  {
    const baseWhere = `dtc.section = '${section}' AND dtc.approve_date IS NOT NULL`;
    const q = `
      SELECT
        TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
        CASE
          WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
          WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
          WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
          WHEN base.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
          ELSE COALESCE(base.debt_range, 'ปกติ')
        END AS bucket,
        base.product_type,
        CASE
          WHEN base.device IN ('iPhone', 'iPad') THEN 'iOS'
          WHEN base.device IS NOT NULL AND base.device != '' THEN 'Android'
          ELSE NULL
        END AS device_family,
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
        GROUP BY dtc.section, dtc.contract_external_id
      ) latest ON latest.section = base.section
               AND latest.contract_external_id = base.contract_external_id
      WHERE base.section = '${section}'
        AND base.approve_date IS NOT NULL
        AND base.is_arrears = true
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1 DESC
    `;
    const rawRows = pgRows(await db.execute(sql.raw(q)));
    const mapped = rawRows.map((r: any) => ({
      approve_month: String(r.approve_month),
      bucket: String(r.bucket),
      productType: r.product_type ? String(r.product_type) : null,
      deviceFamily: toDeviceFamily(r.device_family),
      dateMonth: r.due_month ? String(r.due_month) : null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_due), interest: Number(r.interest_due), fee: Number(r.fee_due),
      penalty: Number(r.penalty_due), unlockFee: Number(r.unlock_fee_due),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_due),
    }));
    const combined = buildMscBatchCombinations(mapped);
    await upsertMonthlySummaryRows(section, "due", combined);
    totalRows += combined.length;
    doneSteps++;
    onProgress?.(doneSteps, TOTAL_STEPS);
  }

  // ── Query 5: notYetDue (BATCH) ────────────────────────────────────────────
  {
    const baseWhere = `dtc.section = '${section}' AND dtc.approve_date IS NOT NULL`;
    const q = `
      SELECT
        TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
        CASE
          WHEN base.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
          WHEN base.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
          WHEN base.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
          WHEN base.contract_status = 'ยกเลิกสัญญา' THEN 'ยกเลิกสัญญา'
          ELSE COALESCE(base.debt_range, 'ปกติ')
        END AS bucket,
        base.product_type,
        CASE
          WHEN base.device IN ('iPhone', 'iPad') THEN 'iOS'
          WHEN base.device IS NOT NULL AND base.device != '' THEN 'Android'
          ELSE NULL
        END AS device_family,
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
          AND COALESCE(dtc.is_suspended, false) IS NOT TRUE
          AND COALESCE(dtc.contract_status, '') NOT IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา')
        GROUP BY dtc.section, dtc.contract_external_id
      ) latest ON latest.section = base.section
               AND latest.contract_external_id = base.contract_external_id
      WHERE base.section = '${section}'
        AND base.approve_date IS NOT NULL
        AND base.due_date > CURRENT_DATE
        AND base.is_closed IS NOT TRUE
        AND COALESCE(base.is_suspended, false) IS NOT TRUE
        AND COALESCE(base.contract_status, '') NOT IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา')
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1 DESC
    `;
    const rawRows = pgRows(await db.execute(sql.raw(q)));
    const mapped = rawRows.map((r: any) => ({
      approve_month: String(r.approve_month),
      bucket: String(r.bucket),
      productType: r.product_type ? String(r.product_type) : null,
      deviceFamily: toDeviceFamily(r.device_family),
      dateMonth: r.due_month ? String(r.due_month) : null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_notyet), interest: Number(r.interest_notyet), fee: Number(r.fee_notyet),
      penalty: Number(r.penalty_notyet), unlockFee: Number(r.unlock_fee_notyet),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_notyet),
    }));
    const combined = buildMscBatchCombinations(mapped);
    await upsertMonthlySummaryRows(section, "notYetDue", combined);
    totalRows += combined.length;
    doneSteps++;
    onProgress?.(doneSteps, TOTAL_STEPS);
  }

  // ── Query 6: installTotal (BATCH) ─────────────────────────────────────────
  {
    const baseWhere = `dtc.section = '${section}' AND dtc.approve_date IS NOT NULL`;
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
        l.product_type,
        CASE
          WHEN l.device IN ('iPhone', 'iPad') THEN 'iOS'
          WHEN l.device IS NOT NULL AND l.device != '' THEN 'Android'
          ELSE NULL
        END AS device_family,
        COUNT(DISTINCT l.contract_external_id) AS contract_count,
        SUM(
          CASE
            WHEN l.finance_amount > 0 AND l.installment_count > 0
            THEN CEIL(CAST(l.finance_amount AS DECIMAL(18,2)) / l.installment_count) * l.installment_count
            ELSE COALESCE(l.baseline_amount, 0) * COALESCE(l.installment_count, 0)
          END
        ) AS principal_install,
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
        SUM(
          CASE
            WHEN l.finance_amount > 0 AND l.installment_count > 0
            THEN 100 * l.installment_count
            ELSE 0
          END
        ) AS fee_install,
        SUM(COALESCE(l.baseline_amount, 0) * COALESCE(l.installment_count, 0)) AS total_install,
        SUM(COALESCE(l.finance_amount, 0)) AS finance_total
      FROM latest l
      WHERE l.rn = 1
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 DESC
    `;
    const rawRows = pgRows(await db.execute(sql.raw(q)));
    const mapped = rawRows.map((r: any) => ({
      approve_month: String(r.approve_month),
      bucket: String(r.bucket),
      productType: r.product_type ? String(r.product_type) : null,
      deviceFamily: toDeviceFamily(r.device_family),
      dateMonth: null as string | null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_install), interest: Number(r.interest_install), fee: Number(r.fee_install),
      penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_install),
      financeTotal: Number(r.finance_total),
    }));
    const combined = buildMscBatchCombinations(mapped);
    await upsertMonthlySummaryRows(section, "installTotal", combined);
    totalRows += combined.length;
    doneSteps++;
    onProgress?.(doneSteps, TOTAL_STEPS);
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

  // dateMonthCondAll: เหมือน dateMonthCond แต่เมื่อไม่มี filter จะดึงทุก date_month (1=1)
  // ใช้กับ paid/notYetDue ซึ่ง date_month มีค่าเสมอ (ไม่เคย NULL)
  function dateMonthCondAll(months: string[] | undefined, singleDate: string | undefined): string {
    if (singleDate) {
      const m = singleDate.substring(0, 7);
      return `date_month = '${m}'`;
    }
    if (months && months.length > 0) {
      const list = months.map((m) => `'${m}'`).join(",");
      return `date_month IN (${list})`;
    }
    return `1=1`; // ไม่มี filter → ดึงทุก date_month
  }

  function productTypeCond(pt: string | undefined): string {
    if (pt) return `product_type = '${pt.replace(/'/g, "''")}'`;
    return `product_type IS NULL`;
  }

  function deviceFamilyCond(df: string | undefined): string {
    if (df) return `device_family = '${df}'`;
    return `device_family IS NULL`;
  }

  // ตรวจว่า cache มีข้อมูลสำหรับ query_type หลัก (count) ไหม
  // และตรวจสอบเฉพาะเจาะจงตาม filter พื้นฐาน (productType, deviceFamily)
  const checkSql = `
    SELECT COUNT(*) AS cnt 
    FROM monthly_summary_cache 
    WHERE section = '${section}' 
      AND query_type = 'count'
      AND ${productTypeCond(params.countProductType)}
      AND ${deviceFamilyCond(params.countDeviceFamily)}
      AND date_month IS NULL
  `;
  const checkRows = await db.execute(sql.raw(checkSql));
  const cnt = parseInt(String((pgRows(checkRows)[0] as any)?.cnt ?? "0"), 10);
  if (cnt === 0) return null; // ไม่มีข้อมูลใน cache สำหรับ filter นี้ → fallback ไป live query

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
    // paid: approveMonth filter (populate เก็บ dateMonth = approveMonth)
    // ใช้ dateMonthCondAll เพราะ date_month มีค่าเสมอ (ไม่เคย NULL)
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_paid, interest AS interest_paid,
             fee AS fee_paid, penalty AS penalty_paid,
             unlock_fee AS unlock_fee_paid, discount AS discount_amount,
             overpaid AS overpaid_amount, bad_debt AS device_sale_amount,
             bad_debt_installment AS installment_paid, total_amount AS total_paid
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'paid'
        AND date_month IS NOT NULL
        AND ${productTypeCond(params.paidProductType)}
        AND ${deviceFamilyCond(params.paidDeviceFamily)}
        AND ${dateMonthCondAll(params.paidApproveMonths, params.paidAtDate)}
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
    // notYetDue: dueMonth filter (populate เก็บ dateMonth = dueMonth)
    // ใช้ dateMonthCondAll เพราะ date_month มีค่าเสมอ (ไม่เคย NULL)
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_notyet, interest AS interest_notyet,
             fee AS fee_notyet, penalty AS penalty_notyet,
             unlock_fee AS unlock_fee_notyet, total_amount AS total_notyet
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'notYetDue'
        AND date_month IS NOT NULL
        AND ${productTypeCond(params.notYetDueProductType)}
        AND ${deviceFamilyCond(params.notYetDueDeviceFamily)}
        AND ${dateMonthCondAll(params.notYetDueDueMonths, params.notYetDueDueDate)}
      ORDER BY approve_month DESC
    `)),
    // installTotal: ไม่มี dateMonth filter
    db.execute(sql.raw(`
      SELECT approve_month, bucket, contract_count,
             principal AS principal_install, interest AS interest_install,
             fee AS fee_install, total_amount AS total_install,
             finance_total
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
  const financeTotalMap = new Map<CellKey, number>();
  for (const r of installTotalRows) {
    installTotalMap.set(`${r.approve_month}|${r.bucket}`, {
      principal: n(r.principal_install), interest: n(r.interest_install),
      fee: n(r.fee_install), penalty: 0, unlockFee: 0,
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_install),
    });
    financeTotalMap.set(`${r.approve_month}|${r.bucket}`, n(r.finance_total));
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

    let totalFinanceTotal = 0;

    for (const bucket of DEBT_BUCKETS) {
      const key = `${month}|${bucket}`;
      const contractCount = countMap.get(key) ?? 0;
      const paid          = paidMap.get(key) ?? emptyMoney();
      const due           = dueMap.get(key) ?? emptyMoney();
      const target        = targetMap.get(key) ?? emptyMoney();
      const notYetDue     = notYetDueMap.get(key) ?? emptyMoney();
      const installTotal  = installTotalMap.get(key) ?? emptyMoney();
      const financeTotal  = financeTotalMap.get(key) ?? 0;

      buckets[bucket] = { contractCount, paid, due, target, notYetDue, installTotal, financeTotal };
      totalCount += contractCount;
      totalFinanceTotal += financeTotal;

      for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
        (totalDue          as any)[k] += due[k];
        (totalTarget       as any)[k] += target[k];
        (totalNotYetDue    as any)[k] += notYetDue[k];
        (totalInstallTotal as any)[k] += installTotal[k];
      }
    }

    return { approveMonth: month, buckets, totalCount, totalPaid, totalDue, totalTarget, totalNotYetDue, totalInstallTotal, totalFinanceTotal };
  });
}

// ---------------------------------------------------------------------------
// getDueMonthSummary — Mode "เดือนที่ต้องชำระ"
// Query ข้อมูลแบบ approve_month × due_month แทน approve_month × bucket
// ใช้สำหรับ Combined Tab เท่านั้น
// ---------------------------------------------------------------------------

/** โครงสร้างข้อมูลของแต่ละ Cell ใน DueMonth mode */
export type DueMonthCell = {
  contractCount: number;
  paid: MoneyBreakdown;
  due: MoneyBreakdown;
  target: MoneyBreakdown;
  notYetDue: MoneyBreakdown;
  installTotal: MoneyBreakdown;
  financeTotal: number;         // ยอดจัดฯ = SUM(finance_amount) ต่อสัญญา
};

/** แต่ละแถว approve_month ใน DueMonth mode */
export type DueMonthRow = {
  approveMonth: string; // YYYY-MM
  dueMonths: Record<string, DueMonthCell>; // key = YYYY-MM ของ due_date
  totalCount: number;      // sum ของ contractCount จากทุก due_month cell (สัญญาที่ถึงกำหนด)
  approvedCount: number;   // จำนวนสัญญาที่อนุมัติในเดือนนี้ (DISTINCT per approve_month)
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
  totalTarget: MoneyBreakdown;
  totalNotYetDue: MoneyBreakdown;
  totalInstallTotal: MoneyBreakdown;
  totalFinanceTotal: number;         // ยอดจัดฯ รวมทุก due_month
};

export type DueMonthParams = {
  section: SectionKey;
  approveMonths?: string[];
  productType?: string;
  deviceFamily?: string;
  search?: string;
};

/** Query Count แยกตาม approve_month × due_month */
async function queryDueMonthCount(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{ approve_month: string; due_month: string; contract_count: number }>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  const q = `
    SELECT
      TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
      TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month,
      COUNT(DISTINCT dtc.contract_external_id) AS contract_count
    FROM debt_target_cache dtc
    WHERE ${baseWhere}
      AND dtc.due_date IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/** Query Approved Count แยกตาม approve_month เท่านั้น (DISTINCT contract per approve month) */
async function queryDueMonthApprovedCount(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{ approve_month: string; approved_count: number }>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  const q = `
    SELECT
      TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
      COUNT(DISTINCT dtc.contract_external_id) AS approved_count
    FROM debt_target_cache dtc
    WHERE ${baseWhere}
    GROUP BY 1
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/** Query Target แยกตาม approve_month × due_month */
async function queryDueMonthTarget(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{
  approve_month: string; due_month: string; contract_count: number;
  principal_target: number; interest_target: number; fee_target: number;
  penalty_target: number; unlock_fee_target: number; total_target: number;
}>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  // Bug fix: outer query ต้องใช้ filter เดียวกับ subquery
  const baseWhereForOuter = baseWhere.replace(/\bdtc\./g, "base.");
  const q = `
    SELECT
      TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
      TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
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
      SELECT dtc.section, dtc.contract_external_id,
             TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month_grp,
             MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND DATE(dtc.due_date) <= CURRENT_DATE
        AND dtc.due_date IS NOT NULL
      GROUP BY dtc.section, dtc.contract_external_id, TO_CHAR(dtc.due_date, 'YYYY-MM')
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
             AND TO_CHAR(base.due_date, 'YYYY-MM') = latest.due_month_grp
    WHERE ${baseWhereForOuter}
      AND DATE(base.due_date) <= CURRENT_DATE
      AND base.due_date IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/** Query Due แยกตาม approve_month × due_month */
async function queryDueMonthDue(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{
  approve_month: string; due_month: string; contract_count: number;
  principal_due: number; interest_due: number; fee_due: number;
  penalty_due: number; unlock_fee_due: number; total_due: number;
}>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  // Bug fix: outer query ต้องใช้ filter เดียวกับ subquery
  const baseWhereForOuter = baseWhere.replace(/\bdtc\./g, "base.");
  const q = `
    SELECT
      TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
      TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
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
      SELECT dtc.section, dtc.contract_external_id,
             TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month_grp,
             MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.is_arrears = true
        AND dtc.due_date IS NOT NULL
      GROUP BY dtc.section, dtc.contract_external_id, TO_CHAR(dtc.due_date, 'YYYY-MM')
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
             AND TO_CHAR(base.due_date, 'YYYY-MM') = latest.due_month_grp
    WHERE ${baseWhereForOuter}
      AND base.is_arrears = true
      AND base.due_date IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/** Query NotYetDue แยกตาม approve_month × due_month */
async function queryDueMonthNotYetDue(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{
  approve_month: string; due_month: string; contract_count: number;
  principal_notyet: number; interest_notyet: number; fee_notyet: number;
  penalty_notyet: number; unlock_fee_notyet: number; total_notyet: number;
}>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  // Bug fix: outer query ต้องใช้ filter เดียวกับ subquery
  const baseWhereForOuter = baseWhere.replace(/\bdtc\./g, "base.");
  const q = `
    SELECT
      TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
      TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
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
      SELECT dtc.section, dtc.contract_external_id,
             TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month_grp,
             MAX(dtc.period) AS max_period
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.due_date > CURRENT_DATE
        AND dtc.is_closed IS NOT TRUE
        AND dtc.is_paid IS NOT TRUE
        AND COALESCE(dtc.is_suspended, false) IS NOT TRUE
        AND COALESCE(dtc.contract_status, '') NOT IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา')
      GROUP BY dtc.section, dtc.contract_external_id, TO_CHAR(dtc.due_date, 'YYYY-MM')
    ) latest ON latest.section = base.section
             AND latest.contract_external_id = base.contract_external_id
             AND TO_CHAR(base.due_date, 'YYYY-MM') = latest.due_month_grp
    WHERE ${baseWhereForOuter}
      AND base.due_date > CURRENT_DATE
      AND base.is_closed IS NOT TRUE
      AND base.is_paid IS NOT TRUE
      AND COALESCE(base.is_suspended, false) IS NOT TRUE
      AND COALESCE(base.contract_status, '') NOT IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา')
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/** Query InstallTotal แยกตาม approve_month × due_month (ใช้ due_date ของแต่ละงวด) */
async function queryDueMonthInstallTotal(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{
  approve_month: string; due_month: string; contract_count: number;
  principal_install: number; interest_install: number; fee_install: number; total_install: number;
  finance_total: number;
}>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  // finance_total logic:
  // - คอลัมน์รวม (__total__): แสดง finance_amount เต็ม (1 ครั้งต่อสัญญา)
  // - แต่ละ due_month: กระจายหารตามจำนวน due_month ทั้งหมดของสัญญา (finance_amount / due_month_count)
  const q = `
    WITH per_contract_due AS (
      -- ยอดผ่อน/งวด แยกตาม approve_month × due_month (ทุกงวด)
      SELECT
        dtc.section,
        dtc.contract_external_id,
        TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month,
        SUM(CAST(dtc.principal AS DECIMAL(18,2))) AS principal_install,
        SUM(CAST(dtc.interest  AS DECIMAL(18,2))) AS interest_install,
        SUM(CAST(dtc.fee       AS DECIMAL(18,2))) AS fee_install,
        SUM(CAST(dtc.baseline_amount AS DECIMAL(18,2))) AS total_install
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.due_date IS NOT NULL
      GROUP BY dtc.section, dtc.contract_external_id,
               TO_CHAR(dtc.approve_date, 'YYYY-MM'),
               TO_CHAR(dtc.due_date, 'YYYY-MM')
    ),
    finance_per_contract AS (
      -- ยอดจัดฯ + จำนวน due_month ทั้งหมดของสัญญา (สำหรับหาร)
      SELECT
        dtc.section,
        dtc.contract_external_id,
        TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
        MAX(CAST(COALESCE(dtc.finance_amount, '0') AS DECIMAL(18,2))) AS finance_amount,
        COUNT(DISTINCT TO_CHAR(dtc.due_date, 'YYYY-MM')) AS due_month_count
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.due_date IS NOT NULL
      GROUP BY dtc.section, dtc.contract_external_id,
               TO_CHAR(dtc.approve_date, 'YYYY-MM')
    )
    SELECT
      pcd.approve_month,
      pcd.due_month,
      COUNT(DISTINCT pcd.contract_external_id) AS contract_count,
      SUM(pcd.principal_install) AS principal_install,
      SUM(pcd.interest_install)  AS interest_install,
      SUM(pcd.fee_install)       AS fee_install,
      SUM(pcd.total_install)     AS total_install,
      -- finance_total: กระจาย finance_amount หารตามจำนวน due_month ของแต่ละสัญญา
      SUM(
        CASE WHEN fpc.due_month_count > 0
             THEN ROUND(fpc.finance_amount / fpc.due_month_count, 2)
             ELSE 0
        END
      ) AS finance_total
    FROM per_contract_due pcd
    LEFT JOIN finance_per_contract fpc
           ON fpc.section = pcd.section
          AND fpc.contract_external_id = pcd.contract_external_id
          AND fpc.approve_month = pcd.approve_month
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/**
 * Query Paid แยกตาม approve_month × due_month
 * JOIN debt_collected_cache กับ debt_target_cache ผ่าน contract_external_id + period
 * เพื่อดึง due_date (due_month) ของงวดที่ชำระ
 */
async function queryDueMonthPaid(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{
  approve_month: string; due_month: string; contract_count: number;
  principal_paid: number; interest_paid: number; fee_paid: number;
  penalty_paid: number; unlock_fee_paid: number; discount_amount: number;
  overpaid_amount: number; bad_debt_amount: number; bad_debt_installment: number;
  total_paid: number;
}>> {
  const db = await getDb(section);
  if (!db) return [];

  // Build WHERE clause สำหรับ dcc (ใช้ section + productType + deviceFamily + approveMonths + search)
  let dccFilter = `dcc.section = '${section}' AND dcc.approve_date IS NOT NULL`;
  if (opts.productType) {
    dccFilter += `\n    AND dcc.product_type = '${opts.productType.replace(/'/g, "''")}'`;
  }
  if (opts.deviceFamily === "iOS") {
    dccFilter += `\n    AND dcc.device IN ('iPhone', 'iPad')`;
  } else if (opts.deviceFamily === "Android") {
    dccFilter += `\n    AND dcc.device NOT IN ('iPhone', 'iPad') AND dcc.device IS NOT NULL AND dcc.device != ''`;
  }
  if (opts.approveMonths && opts.approveMonths.length > 0) {
    const list = opts.approveMonths.map((m) => `'${m}'`).join(",");
    dccFilter += `\n    AND TO_CHAR(dcc.approve_date, 'YYYY-MM') IN (${list})`;
  }
  if (opts.search) {
    const s = escapeLike(opts.search);
    dccFilter += `\n    AND (dcc.contract_no LIKE '%${s}%' OR dcc.customer_name LIKE '%${s}%')`;
  }

  // ยอดเก็บหนี้ลงตามเดือนที่ชำระจริง (paid_at) ไม่ใช่เดือนที่งวดถึงกำหนด (due_date)
  // approve_month = เดือนที่อนุมัติสัญญา (จาก dcc.approve_date)
  // due_month     = เดือนที่ชำระจริง (จาก dcc.paid_at) — ไม่สนใจว่างวดนั้น due เดือนไหน
  const q = `
    SELECT
      TO_CHAR(dcc.approve_date, 'YYYY-MM') AS approve_month,
      TO_CHAR(dcc.paid_at, 'YYYY-MM') AS due_month,
      COUNT(DISTINCT dcc.contract_external_id) AS contract_count,
      -- breakdown fields: ข้าม isExtraPenalty rows (payment_tx_amount=0 AND penalty>0 AND is_bad_debt_row=false)
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
      SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2)) ELSE 0 END) AS bad_debt_amount,
      SUM(CASE WHEN dcc.is_bad_debt_row = false
                    AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                             AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
               THEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) ELSE 0 END) AS bad_debt_installment,
      -- total_paid = SUM(payment_tx_amount + bad_debt) ยกเว้น isExtraPenalty
      SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2))
               WHEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                    AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0 THEN 0
               ELSE CAST(dcc.payment_tx_amount AS DECIMAL(18,2))
          END) AS total_paid
    FROM debt_collected_cache dcc
    WHERE ${dccFilter}
      AND dcc.paid_at IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `;
  const rows = await db.execute(sql.raw(q));
  return pgRows(rows) as any[];
}

/**
 * Query ยอดจัดฯ รวมต่อ approve_month (ไม่กระจายตาม due_month)
 * ใช้สำหรับ totalFinanceTotal ใน getDueMonthSummary เพื่อให้ตรงกับ mode สถานะหนี้
 * ดึง finance_amount 1 ครั้งต่อสัญญา (MAX per contract) แล้ว SUM ต่อ approve_month
 */
async function queryDueMonthFinanceTotal(
  section: SectionKey,
  opts: { approveMonths?: string[]; productType?: string; deviceFamily?: string; search?: string },
): Promise<Array<{ approve_month: string; finance_total: number }>> {
  const db = await getDb(section);
  if (!db) return [];
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
    approveMonths: opts.approveMonths,
    search: opts.search,
  });
  // ดึง finance_amount 1 ครั้งต่อสัญญา (MAX เพื่อ DISTINCT per contract)
  // แล้ว SUM รวมต่อ approve_month — เหมือน queryInstallTotal ใน mode สถานะหนี้
  const q = `
    WITH per_contract AS (
      SELECT
        TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
        dtc.contract_external_id,
        MAX(CAST(COALESCE(dtc.finance_amount, '0') AS DECIMAL(18,2))) AS finance_amount
      FROM debt_target_cache dtc
      WHERE ${baseWhere}
        AND dtc.due_date IS NOT NULL
      GROUP BY TO_CHAR(dtc.approve_date, 'YYYY-MM'), dtc.contract_external_id
    )
    SELECT
      approve_month,
      SUM(finance_amount) AS finance_total
    FROM per_contract
    GROUP BY 1
    ORDER BY 1 DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (pgRows(rows) as any[]).map((r: any) => ({
    approve_month: r.approve_month as string,
    finance_total: n(r.finance_total),
  }));
}

/**
 * Main export: getDueMonthSummary
 * ดึงข้อมูล approve_month × due_month สำหรับ Combined Tab Mode "เดือนที่ต้องชำระ"
 */
export async function getDueMonthSummary(
  params: DueMonthParams,
): Promise<DueMonthRow[]> {
  const { section } = params;
  const opts = {
    approveMonths: params.approveMonths,
    productType: params.productType,
    deviceFamily: params.deviceFamily,
    search: params.search,
  };

  // เรียก getMonthlySummary ด้วยเพื่อดึง totalInstallTotal และ totalNotYetDue ที่ถูกต้อง
  // (ใช้ logic เดียวกับ mode สถานะหนี้ — baseline_amount × installment_count)
  const monthlySummaryParams: MonthlySummaryParams = {
    section,
    countApproveMonths:          opts.approveMonths,
    countProductType:            opts.productType,
    countDeviceFamily:           opts.deviceFamily,
    targetApproveMonths:         opts.approveMonths,
    targetProductType:           opts.productType,
    targetDeviceFamily:          opts.deviceFamily,
    paidApproveMonths:           opts.approveMonths,
    paidProductType:             opts.productType,
    paidDeviceFamily:            opts.deviceFamily,
    dueProductType:              opts.productType,
    dueDeviceFamily:             opts.deviceFamily,
    notYetDueApproveMonths:      opts.approveMonths,
    notYetDueProductType:        opts.productType,
    notYetDueDeviceFamily:       opts.deviceFamily,
    installTotalApproveMonths:   opts.approveMonths,
    installTotalProductType:     opts.productType,
    installTotalDeviceFamily:    opts.deviceFamily,
    search:                      opts.search,
  };
  const [countRows, targetRows, dueRows, notYetDueRows, installTotalRows, paidRows, approvedCountRows, financeTotalRows, monthlySummaryRows] = await Promise.all([
    queryDueMonthCount(section, opts),
    queryDueMonthTarget(section, opts),
    queryDueMonthDue(section, opts),
    queryDueMonthNotYetDue(section, opts),
    queryDueMonthInstallTotal(section, opts),
    queryDueMonthPaid(section, opts),
    queryDueMonthApprovedCount(section, opts),
    queryDueMonthFinanceTotal(section, opts), // ยอดจัดฯรวมต่อ approve_month (ไม่กระจาย) เพื่อให้ตรงกับ mode สถานะหนี้
    getMonthlySummary(monthlySummaryParams),  // ดึง totalInstallTotal/totalNotYetDue ที่ถูกต้อง
  ]);
  // สร้าง Map จาก getMonthlySummary เพื่อ lookup ต่อ approveMonth
  const msInstallTotalMap = new Map<string, MoneyBreakdown>();
  const msNotYetDueMap    = new Map<string, MoneyBreakdown>();
  for (const r of monthlySummaryRows) {
    msInstallTotalMap.set(r.approveMonth, r.totalInstallTotal);
    msNotYetDueMap.set(r.approveMonth, r.totalNotYetDue);
  }

  // รวบรวม approve_months และ due_months ทั้งหมด
  const monthSet = new Set<string>();
  // แยก due_date-based queries ออกจาก paid_at query
  // paid_at อาจมีการชำระล่วงหน้าทำให้ max due_month ยาวเกินจริง
  // ใช้ due_date-based queries (count, target, due, notYetDue, installTotal) เป็น anchor ของ range
  const dueDateMonthSet = new Set<string>(); // due_month จาก due_date
  const paidMonthSet = new Set<string>();    // due_month จาก paid_at
  for (const r of [...countRows, ...targetRows, ...dueRows, ...notYetDueRows, ...installTotalRows]) {
    monthSet.add(r.approve_month);
    dueDateMonthSet.add(r.due_month);
  }
  for (const r of paidRows) {
    monthSet.add(r.approve_month);
    paidMonthSet.add(r.due_month);
  }
  const approveMonths = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

  // ── สร้าง allDueMonths เป็น continuous range ──────────────────────────────
  // min = เดือนแรกสุดจาก due_date-based queries (due_date เริ่มต้นสัญญา)
  // max = เดือนสุดท้ายจาก due_date-based queries (ไม่ใช้ paid_at เพราะอาจชำระล่วงหน้าทำให้ range ยาวเกิน)
  // paid_at ที่อยู่นอก range จะยังคงแสดงใน map และถูก skip โดย loop (cell ไม่อยู่ใน allDueMonths)
  const sortedDueDateMonths = Array.from(dueDateMonthSet).sort((a, b) => a.localeCompare(b));
  // รวม paid months ที่อยู่ใน range ของ due_date range ด้วย (เพื่อไม่ให้ช่องว่างใน range)
  // แต่ไม่ขยาย max ออกไปเกิน due_date max
  let allDueMonths: string[];
  if (sortedDueDateMonths.length === 0) {
    // ไม่มี due_date data เลย — ใช้ paid months แทน
    const sortedPaid = Array.from(paidMonthSet).sort((a, b) => a.localeCompare(b));
    allDueMonths = sortedPaid;
  } else {
    const minDm = sortedDueDateMonths[0];
    const maxDm = sortedDueDateMonths[sortedDueDateMonths.length - 1];
    // Generate continuous range from minDm to maxDm (anchor ที่ due_date range)
    allDueMonths = [];
    let [y, m] = minDm.split("-").map(Number);
    const [maxY, maxM] = maxDm.split("-").map(Number);
    while (y < maxY || (y === maxY && m <= maxM)) {
      allDueMonths.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    // เพิ่ม paid months ที่อยู่นอก range (paid ก่อน due_date min หรือหลัง max) เข้าไปด้วย
    // เพื่อให้ยอดชำระล่วงหน้าที่อยู่นอก range ยังแสดงได้
    const allDueMonthSet = new Set(allDueMonths);
    for (const pm of Array.from(paidMonthSet)) {
      if (!allDueMonthSet.has(pm)) allDueMonths.push(pm);
    }
    allDueMonths.sort((a, b) => a.localeCompare(b));
  }

  // สร้าง Maps สำหรับ lookup
  type Key = string; // "approve_month|due_month"
  const countMap = new Map<Key, number>();
  for (const r of countRows) countMap.set(`${r.approve_month}|${r.due_month}`, n(r.contract_count));

  // approvedCount per approve_month (ไม่แยกตาม due_month)
  const approvedCountMap = new Map<string, number>();
  for (const r of approvedCountRows) approvedCountMap.set(r.approve_month, n(r.approved_count));

  const targetMap = new Map<Key, MoneyBreakdown>();
  for (const r of targetRows) {
    targetMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal_target), interest: n(r.interest_target),
      fee: n(r.fee_target), penalty: n(r.penalty_target), unlockFee: n(r.unlock_fee_target),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_target),
    });
  }

  const dueMap = new Map<Key, MoneyBreakdown>();
  for (const r of dueRows) {
    dueMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal_due), interest: n(r.interest_due),
      fee: n(r.fee_due), penalty: n(r.penalty_due), unlockFee: n(r.unlock_fee_due),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_due),
    });
  }

  const notYetDueMap = new Map<Key, MoneyBreakdown>();
  for (const r of notYetDueRows) {
    notYetDueMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal_notyet), interest: n(r.interest_notyet),
      fee: n(r.fee_notyet), penalty: n(r.penalty_notyet), unlockFee: n(r.unlock_fee_notyet),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_notyet),
    });
  }

  const installTotalMap = new Map<Key, MoneyBreakdown>();
  const financeTotalDueMap = new Map<Key, number>();
  for (const r of installTotalRows) {
    installTotalMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal_install), interest: n(r.interest_install),
      fee: n(r.fee_install), penalty: 0, unlockFee: 0,
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_install),
    });
    financeTotalDueMap.set(`${r.approve_month}|${r.due_month}`, n(r.finance_total));
  }

  // Map ยอดจัดฯรวมต่อ approve_month (ไม่กระจาย) — ใช้แทน totalFinanceTotal จาก cell loop
  const financeTotalPerMonthMap = new Map<string, number>();
  for (const r of financeTotalRows) financeTotalPerMonthMap.set(r.approve_month, r.finance_total);

  const paidMap = new Map<Key, MoneyBreakdown>();
  for (const r of paidRows) {
    paidMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal_paid), interest: n(r.interest_paid),
      fee: n(r.fee_paid), penalty: n(r.penalty_paid), unlockFee: n(r.unlock_fee_paid),
      discount: n(r.discount_amount), overpaid: n(r.overpaid_amount),
      badDebt: n(r.bad_debt_amount), badDebtInstallment: n(r.bad_debt_installment),
      total: n(r.total_paid),
    });
  }

  return approveMonths.map((approveMonth) => {
    const dueMonths: Record<string, DueMonthCell> = {};
    let totalCount = 0;
    // ใช้ยอดจัดฯจาก query แยกโดยตรง ไม่บวกจาก cell loop — เพื่อให้ตรงกับ mode สถานะหนี้
    const totalFinanceTotal = financeTotalPerMonthMap.get(approveMonth) ?? 0;
    const totalPaid         = emptyMoney();
    const totalDue          = emptyMoney();
    const totalTarget       = emptyMoney();
    const totalNotYetDue    = emptyMoney();
    const totalInstallTotal = emptyMoney();

    for (const dueMonth of allDueMonths) {
      const key = `${approveMonth}|${dueMonth}`;
      const contractCount = countMap.get(key) ?? 0;
      const paid          = paidMap.get(key) ?? emptyMoney();
      const due           = dueMap.get(key) ?? emptyMoney();
      const target        = targetMap.get(key) ?? emptyMoney();
      const notYetDue     = notYetDueMap.get(key) ?? emptyMoney();
      const installTotal  = installTotalMap.get(key) ?? emptyMoney();
      const financeTotal  = financeTotalDueMap.get(key) ?? 0;

      // ข้ามเดือนที่ไม่มีข้อมูลเลย
      if (contractCount === 0 && target.total === 0 && due.total === 0 && notYetDue.total === 0 && installTotal.total === 0 && paid.total === 0) continue;

      dueMonths[dueMonth] = { contractCount, paid, due, target, notYetDue, installTotal, financeTotal };
      totalCount += contractCount;
      // totalFinanceTotal ใช้จาก financeTotalPerMonthMap แล้ว ไม่บวกจาก cell loop
      for (const k of Object.keys(totalDue) as (keyof MoneyBreakdown)[]) {
        (totalPaid         as any)[k] += paid[k];
        (totalDue          as any)[k] += due[k];
        (totalTarget       as any)[k] += target[k];
        (totalNotYetDue    as any)[k] += notYetDue[k];
        (totalInstallTotal as any)[k] += installTotal[k];
      }
    }

    const approvedCount = approvedCountMap.get(approveMonth) ?? 0;
    // Override totalInstallTotal และ totalNotYetDue ด้วยค่าจาก getMonthlySummary
    // เพื่อให้ใช้ logic เดียวกับ mode สถานะหนี้ (baseline_amount × installment_count)
    const correctInstallTotal = msInstallTotalMap.get(approveMonth) ?? totalInstallTotal;
    const correctNotYetDue    = msNotYetDueMap.get(approveMonth) ?? totalNotYetDue;
    return { approveMonth, dueMonths, totalCount, approvedCount, totalPaid, totalDue, totalTarget, totalNotYetDue: correctNotYetDue, totalInstallTotal: correctInstallTotal, totalFinanceTotal };
  });
}

// ---------------------------------------------------------------------------
// populateDueMonthCache — เรียกตอน Sync หลัง populateMonthlySummaryCache
// เขียนลง monthly_summary_due_month_cache
// ---------------------------------------------------------------------------

/** Upsert rows เข้า monthly_summary_due_month_cache */
async function upsertDueMonthRows(
  section: SectionKey,
  queryType: string,
  rows: Array<{
    approve_month: string;
    due_month: string;
    productType: string | null;
    deviceFamily: string | null;
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
    financeTotal?: number;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb(section);
  if (!db) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map((r) => {
      const pt = r.productType ? `'${r.productType.replace(/'/g, "''")}'` : "NULL";
      const df = r.deviceFamily ? `'${r.deviceFamily}'` : "NULL";
      const ft = r.financeTotal ?? 0;
      return `('${section}','${queryType}','${r.approve_month}','${r.due_month}',${pt},${df},${r.contractCount},${r.principal},${r.interest},${r.fee},${r.penalty},${r.unlockFee},${r.discount},${r.overpaid},${r.badDebt},${r.badDebtInstallment},${r.totalAmount},${ft},NOW())`;
    }).join(",\n");
    const upsertSql = `
      INSERT INTO monthly_summary_due_month_cache
        (section, query_type, approve_month, due_month, product_type, device_family,
         contract_count, principal, interest, fee, penalty, unlock_fee, discount, overpaid,
         bad_debt, bad_debt_installment, total_amount, finance_total, updated_at)
      VALUES ${values}
      ON CONFLICT (section, query_type, approve_month, due_month,
                   COALESCE(product_type,''), COALESCE(device_family,''))
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
        finance_total        = EXCLUDED.finance_total,
        updated_at           = NOW()
    `;
    await db.execute(sql.raw(upsertSql));
  }
}

/**
 * buildBatchCombinations — แปลง batch query rows (มี product_type + device_family)
 * ให้เป็น upsert rows ที่ครอบคลุมทุก combination:
 * 1. (productType=actual, deviceFamily=actual) — ตรงตาม row จริง
 * 2. (productType=actual, deviceFamily=null) — รวม df ทุกตัวของ pt นั้น
 * 3. (productType=null, deviceFamily=actual) — รวม pt ทุกตัวของ df นั้น
 * 4. (productType=null, deviceFamily=null) — รวมทั้งหมด
 * โดย aggregate ด้วย SUM ของ contractCount และ numeric fields
 */
function buildBatchCombinations<T extends {
  approve_month: string; due_month: string;
  productType: string | null; deviceFamily: string | null;
  contractCount: number;
  principal: number; interest: number; fee: number; penalty: number; unlockFee: number;
  discount: number; overpaid: number; badDebt: number; badDebtInstallment: number; totalAmount: number;
  financeTotal?: number;
}>(
  rawRows: any[],
  mapper: (r: any) => T,
): T[] {
  // Step 1: map raw rows to typed objects
  const base = rawRows.map(mapper);

  // Step 2: สร้าง aggregation map
  type Key = string;
  const agg = new Map<Key, T>();

  function addToMap(key: Key, row: T) {
    const existing = agg.get(key);
    if (!existing) {
      agg.set(key, { ...row });
    } else {
      existing.contractCount += row.contractCount;
      existing.principal += row.principal;
      existing.interest += row.interest;
      existing.fee += row.fee;
      existing.penalty += row.penalty;
      existing.unlockFee += row.unlockFee;
      existing.discount += row.discount;
      existing.overpaid += row.overpaid;
      existing.badDebt += row.badDebt;
      existing.badDebtInstallment += row.badDebtInstallment;
      existing.totalAmount += row.totalAmount;
      if (row.financeTotal !== undefined) {
        existing.financeTotal = (existing.financeTotal ?? 0) + row.financeTotal;
      }
    }
  }

  for (const row of base) {
    const am = row.approve_month;
    const dm = row.due_month;
    const pt = row.productType;
    const df = row.deviceFamily;

    // Combination 1: actual pt + actual df
    addToMap(`${am}|${dm}|${pt}|${df}`, { ...row, productType: pt, deviceFamily: df });
    // Combination 2: actual pt + null df (รวม df ทุกตัวของ pt นั้น)
    addToMap(`${am}|${dm}|${pt}|null`, { ...row, productType: pt, deviceFamily: null });
    // Combination 3: null pt + actual df (รวม pt ทุกตัวของ df นั้น)
    addToMap(`${am}|${dm}|null|${df}`, { ...row, productType: null, deviceFamily: df });
    // Combination 4: null pt + null df (รวมทั้งหมด)
    addToMap(`${am}|${dm}|null|null`, { ...row, productType: null, deviceFamily: null });
  }

  return Array.from(agg.values());
}

/**
 * populateDueMonthCache — เรียกตอน Sync หลัง populateMonthlySummaryCache
 * ใช้ BATCH queries (6 queries แทน N×M×6 sequential queries)
 * แต่ละ query ดึงข้อมูลทุก productType × deviceFamily ในครั้งเดียว โดยเพิ่มเป็น GROUP BY columns
 * แล้วเขียนลง monthly_summary_due_month_cache
 * หมายเหตุ: คอลัมน์รวม (approvedCount, installTotalSummary) ดึงจาก monthly_summary_cache โดยตรง
 * ไม่ต้องเก็บใน monthly_summary_due_month_cache อีกต่อไป
 */
export async function populateDueMonthCache(
  section: SectionKey,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;

  // Helper: สร้าง WHERE clause สำหรับ batch (ไม่ filter productType/deviceFamily)
  const batchBaseWhere = `dtc.section = '${section}' AND dtc.approve_date IS NOT NULL`;

  // Helper: สร้าง SELECT expressions สำหรับ productType และ deviceFamily
  const ptSelect = `dtc.product_type`;
  const dfSelect = `CASE WHEN dtc.device IN ('iPhone','iPad') THEN 'iOS'
                        WHEN dtc.device IS NOT NULL AND dtc.device != '' THEN 'Android'
                        ELSE NULL END`;

  // ── ลบ rows เก่าที่ใช้ sentinel values (จาก bug เก่า) ──────────────────────
  await db.execute(sql.raw(`
    DELETE FROM monthly_summary_due_month_cache
    WHERE section = '${section}'
      AND due_month IN ('__approved__', '__summary__', '__appr__', '_appr_', '__sum__')
  `));

  let totalRows = 0;
  onProgress?.(0, 6);

  // ── Query 1: count (batch) ────────────────────────────────────────────────
  {
    const q = `
      SELECT
        ${ptSelect} AS product_type,
        ${dfSelect} AS device_family,
        TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month,
        COUNT(DISTINCT dtc.contract_external_id) AS contract_count
      FROM debt_target_cache dtc
      WHERE ${batchBaseWhere}
        AND dtc.due_date IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ORDER BY 3 DESC, 4 ASC
    `;
    const rawRows = await db.execute(sql.raw(q));
    const rows = pgRows(rawRows) as any[];
    // รวม null combinations (ทุก pt, ทุก df, null pt, null df)
    const mapped = buildBatchCombinations(rows, (r) => ({
      approve_month: r.approve_month,
      due_month: r.due_month,
      productType: r.product_type ?? null,
      deviceFamily: r.device_family ?? null,
      contractCount: Number(r.contract_count),
      principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0,
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, totalAmount: 0,
    }));
    await upsertDueMonthRows(section, "count", mapped);
    totalRows += mapped.length;
    onProgress?.(1, 6);
  }

  // ── Query 2: target (batch) ───────────────────────────────────────────────
  {
    const q = `
      SELECT
        base.product_type,
        CASE WHEN base.device IN ('iPhone','iPad') THEN 'iOS'
             WHEN base.device IS NOT NULL AND base.device != '' THEN 'Android'
             ELSE NULL END AS device_family,
        TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
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
        SELECT dtc.section, dtc.contract_external_id,
               TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month_grp,
               MAX(dtc.period) AS max_period
        FROM debt_target_cache dtc
        WHERE ${batchBaseWhere}
          AND DATE(dtc.due_date) <= CURRENT_DATE
          AND dtc.due_date IS NOT NULL
        GROUP BY dtc.section, dtc.contract_external_id, TO_CHAR(dtc.due_date, 'YYYY-MM')
      ) latest ON latest.section = base.section
               AND latest.contract_external_id = base.contract_external_id
               AND TO_CHAR(base.due_date, 'YYYY-MM') = latest.due_month_grp
      WHERE base.section = '${section}'
        AND base.approve_date IS NOT NULL
        AND DATE(base.due_date) <= CURRENT_DATE
        AND base.due_date IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ORDER BY 3 DESC, 4 ASC
    `;
    const rawRows = await db.execute(sql.raw(q));
    const rows = pgRows(rawRows) as any[];
    const mapped = buildBatchCombinations(rows, (r) => ({
      approve_month: r.approve_month,
      due_month: r.due_month,
      productType: r.product_type ?? null,
      deviceFamily: r.device_family ?? null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_target), interest: Number(r.interest_target), fee: Number(r.fee_target),
      penalty: Number(r.penalty_target), unlockFee: Number(r.unlock_fee_target),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_target),
    }));
    await upsertDueMonthRows(section, "target", mapped);
    totalRows += mapped.length;
    onProgress?.(2, 6);
  }

  // ── Query 3: due (batch) ──────────────────────────────────────────────────
  {
    const q = `
      SELECT
        base.product_type,
        CASE WHEN base.device IN ('iPhone','iPad') THEN 'iOS'
             WHEN base.device IS NOT NULL AND base.device != '' THEN 'Android'
             ELSE NULL END AS device_family,
        TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
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
        SELECT dtc.section, dtc.contract_external_id,
               TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month_grp,
               MAX(dtc.period) AS max_period
        FROM debt_target_cache dtc
        WHERE ${batchBaseWhere}
          AND dtc.is_arrears = true
          AND dtc.due_date IS NOT NULL
        GROUP BY dtc.section, dtc.contract_external_id, TO_CHAR(dtc.due_date, 'YYYY-MM')
      ) latest ON latest.section = base.section
               AND latest.contract_external_id = base.contract_external_id
               AND TO_CHAR(base.due_date, 'YYYY-MM') = latest.due_month_grp
      WHERE base.section = '${section}'
        AND base.approve_date IS NOT NULL
        AND base.is_arrears = true
        AND base.due_date IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ORDER BY 3 DESC, 4 ASC
    `;
    const rawRows = await db.execute(sql.raw(q));
    const rows = pgRows(rawRows) as any[];
    const mapped = buildBatchCombinations(rows, (r) => ({
      approve_month: r.approve_month,
      due_month: r.due_month,
      productType: r.product_type ?? null,
      deviceFamily: r.device_family ?? null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_due), interest: Number(r.interest_due), fee: Number(r.fee_due),
      penalty: Number(r.penalty_due), unlockFee: Number(r.unlock_fee_due),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_due),
    }));
    await upsertDueMonthRows(section, "due", mapped);
    totalRows += mapped.length;
    onProgress?.(3, 6);
  }

  // ── Query 4: notYetDue (batch) ────────────────────────────────────────────
  {
    const q = `
      SELECT
        base.product_type,
        CASE WHEN base.device IN ('iPhone','iPad') THEN 'iOS'
             WHEN base.device IS NOT NULL AND base.device != '' THEN 'Android'
             ELSE NULL END AS device_family,
        TO_CHAR(base.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(base.due_date, 'YYYY-MM') AS due_month,
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
        SELECT dtc.section, dtc.contract_external_id,
               TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month_grp,
               MAX(dtc.period) AS max_period
        FROM debt_target_cache dtc
        WHERE ${batchBaseWhere}
          AND dtc.due_date > CURRENT_DATE
          AND dtc.is_closed IS NOT TRUE
          AND dtc.is_paid IS NOT TRUE
        GROUP BY dtc.section, dtc.contract_external_id, TO_CHAR(dtc.due_date, 'YYYY-MM')
      ) latest ON latest.section = base.section
               AND latest.contract_external_id = base.contract_external_id
               AND TO_CHAR(base.due_date, 'YYYY-MM') = latest.due_month_grp
      WHERE base.section = '${section}'
        AND base.approve_date IS NOT NULL
        AND base.due_date > CURRENT_DATE
        AND base.is_closed IS NOT TRUE
        AND base.is_paid IS NOT TRUE
      GROUP BY 1, 2, 3, 4
      ORDER BY 3 DESC, 4 ASC
    `;
    const rawRows = await db.execute(sql.raw(q));
    const rows = pgRows(rawRows) as any[];
    const mapped = buildBatchCombinations(rows, (r) => ({
      approve_month: r.approve_month,
      due_month: r.due_month,
      productType: r.product_type ?? null,
      deviceFamily: r.device_family ?? null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_notyet), interest: Number(r.interest_notyet), fee: Number(r.fee_notyet),
      penalty: Number(r.penalty_notyet), unlockFee: Number(r.unlock_fee_notyet),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_notyet),
    }));
    await upsertDueMonthRows(section, "notYetDue", mapped);
    totalRows += mapped.length;
    onProgress?.(4, 6);
  }

  // ── Query 5: installTotal (batch) ─────────────────────────────────────────
  {
    const q = `
      WITH per_contract_due AS (
        SELECT
          dtc.section,
          dtc.contract_external_id,
          dtc.product_type,
          CASE WHEN dtc.device IN ('iPhone','iPad') THEN 'iOS'
               WHEN dtc.device IS NOT NULL AND dtc.device != '' THEN 'Android'
               ELSE NULL END AS device_family,
          TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
          TO_CHAR(dtc.due_date, 'YYYY-MM') AS due_month,
          SUM(CAST(dtc.principal AS DECIMAL(18,2))) AS principal_install,
          SUM(CAST(dtc.interest  AS DECIMAL(18,2))) AS interest_install,
          SUM(CAST(dtc.fee       AS DECIMAL(18,2))) AS fee_install,
          SUM(CAST(dtc.baseline_amount AS DECIMAL(18,2))) AS total_install
        FROM debt_target_cache dtc
        WHERE ${batchBaseWhere}
          AND dtc.due_date IS NOT NULL
        GROUP BY dtc.section, dtc.contract_external_id, dtc.product_type,
                 CASE WHEN dtc.device IN ('iPhone','iPad') THEN 'iOS'
                      WHEN dtc.device IS NOT NULL AND dtc.device != '' THEN 'Android'
                      ELSE NULL END,
                 TO_CHAR(dtc.approve_date, 'YYYY-MM'),
                 TO_CHAR(dtc.due_date, 'YYYY-MM')
      ),
      finance_per_contract AS (
        SELECT
          dtc.section,
          dtc.contract_external_id,
          dtc.product_type,
          CASE WHEN dtc.device IN ('iPhone','iPad') THEN 'iOS'
               WHEN dtc.device IS NOT NULL AND dtc.device != '' THEN 'Android'
               ELSE NULL END AS device_family,
          TO_CHAR(dtc.approve_date, 'YYYY-MM') AS approve_month,
          MAX(CAST(COALESCE(dtc.finance_amount, '0') AS DECIMAL(18,2))) AS finance_amount,
          COUNT(DISTINCT TO_CHAR(dtc.due_date, 'YYYY-MM')) AS due_month_count
        FROM debt_target_cache dtc
        WHERE ${batchBaseWhere}
          AND dtc.due_date IS NOT NULL
        GROUP BY dtc.section, dtc.contract_external_id, dtc.product_type,
                 CASE WHEN dtc.device IN ('iPhone','iPad') THEN 'iOS'
                      WHEN dtc.device IS NOT NULL AND dtc.device != '' THEN 'Android'
                      ELSE NULL END,
                 TO_CHAR(dtc.approve_date, 'YYYY-MM')
      )
      SELECT
        pcd.product_type,
        pcd.device_family,
        pcd.approve_month,
        pcd.due_month,
        COUNT(DISTINCT pcd.contract_external_id) AS contract_count,
        SUM(pcd.principal_install) AS principal_install,
        SUM(pcd.interest_install)  AS interest_install,
        SUM(pcd.fee_install)       AS fee_install,
        SUM(pcd.total_install)     AS total_install,
        SUM(
          CASE WHEN fpc.due_month_count > 0
               THEN ROUND(fpc.finance_amount / fpc.due_month_count, 2)
               ELSE 0
          END
        ) AS finance_total
      FROM per_contract_due pcd
      LEFT JOIN finance_per_contract fpc
             ON fpc.section = pcd.section
            AND fpc.contract_external_id = pcd.contract_external_id
            AND fpc.approve_month = pcd.approve_month
      GROUP BY 1, 2, 3, 4
      ORDER BY 3 DESC, 4 ASC
    `;
    const rawRows = await db.execute(sql.raw(q));
    const rows = pgRows(rawRows) as any[];
    const mapped = buildBatchCombinations(rows, (r) => ({
      approve_month: r.approve_month,
      due_month: r.due_month,
      productType: r.product_type ?? null,
      deviceFamily: r.device_family ?? null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_install), interest: Number(r.interest_install), fee: Number(r.fee_install),
      penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      totalAmount: Number(r.total_install),
      financeTotal: Number(r.finance_total),
    }));
    await upsertDueMonthRows(section, "installTotal", mapped);
    totalRows += mapped.length;
    onProgress?.(5, 6);
  }

  // ── Query 6: paid (batch) ─────────────────────────────────────────────────
  // approve_month = approve_date (เดือนอนุมัติสัญญา) — เพื่อ join กับแถวอื่นในตาราง
  // due_month     = paid_at (เดือนที่เก็บเงินได้จริง) — แสดงในคอลัมน์เดือนที่ถูกต้อง
  // filter paid_at <= CURRENT_DATE เพื่อป้องกันการชำระล่วงหน้าทำให้มียอดเก็บหนี้ในเดือนอนาคต
  {
    let dccFilter = `dcc.section = '${section}' AND dcc.paid_at IS NOT NULL AND dcc.paid_at <= CURRENT_DATE`;
    const q = `
      SELECT
        dcc.product_type,
        CASE WHEN dcc.device IN ('iPhone','iPad') THEN 'iOS'
             WHEN dcc.device IS NOT NULL AND dcc.device != '' THEN 'Android'
             ELSE NULL END AS device_family,
        TO_CHAR(dcc.approve_date, 'YYYY-MM') AS approve_month,
        TO_CHAR(dcc.paid_at, 'YYYY-MM') AS due_month,
        COUNT(DISTINCT dcc.contract_external_id) AS contract_count,
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
        SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2)) ELSE 0 END) AS bad_debt_amount,
        SUM(CASE WHEN dcc.is_bad_debt_row = false
                      AND NOT (CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                               AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0)
                 THEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) ELSE 0 END) AS bad_debt_installment,
        SUM(CASE WHEN dcc.is_bad_debt_row = true THEN CAST(dcc.bad_debt AS DECIMAL(18,2))
                 WHEN CAST(dcc.payment_tx_amount AS DECIMAL(18,2)) = 0
                      AND CAST(dcc.penalty AS DECIMAL(18,2)) > 0 THEN 0
                 ELSE CAST(dcc.payment_tx_amount AS DECIMAL(18,2))
            END) AS total_paid
      FROM debt_collected_cache dcc
      WHERE ${dccFilter}
      GROUP BY 1, 2, 3, 4
      ORDER BY 3 DESC, 4 ASC
    `;
    const rawRows = await db.execute(sql.raw(q));
    const rows = pgRows(rawRows) as any[];
    const mapped = buildBatchCombinations(rows, (r) => ({
      approve_month: r.approve_month,
      due_month: r.due_month,
      productType: r.product_type ?? null,
      deviceFamily: r.device_family ?? null,
      contractCount: Number(r.contract_count),
      principal: Number(r.principal_paid), interest: Number(r.interest_paid), fee: Number(r.fee_paid),
      penalty: Number(r.penalty_paid), unlockFee: Number(r.unlock_fee_paid),
      discount: Number(r.discount_amount), overpaid: Number(r.overpaid_amount),
      badDebt: Number(r.bad_debt_amount), badDebtInstallment: Number(r.bad_debt_installment),
      totalAmount: Number(r.total_paid),
    }));
    await upsertDueMonthRows(section, "paid", mapped);
    totalRows += mapped.length;
    onProgress?.(6, 6);
  }

  // ── Query 7 และ 8 ถูกตัดออกแล้ว ─────────────────────────────────────────────
  // approvedCount และ installTotalSummary ดึงจาก monthly_summary_cache โดยตรงใน getDueMonthSummaryFromCache
  // ไม่ต้องเก็บใน monthly_summary_due_month_cache อีกต่อไป

  return totalRows;
}

// ---------------------------------------------------------------------------
// getDueMonthSummaryFromCache — Fast path: ดึงจาก monthly_summary_due_month_cache
// คอลัมน์รวม + Grand Total ดึงจาก monthly_summary_cache (เหมือน Mode สถานะหนี้)
// ---------------------------------------------------------------------------
export async function getDueMonthSummaryFromCache(
  params: DueMonthParams,
): Promise<{ rows: DueMonthRow[]; allDueMonths: string[] }> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return { rows: [], allDueMonths: [] };

  const ptFilter = params.productType
    ? `AND product_type = '${params.productType.replace(/'/g, "''")}'`
    : `AND product_type IS NULL`;
  const dfFilter = params.deviceFamily
    ? `AND device_family = '${params.deviceFamily}'`
    : `AND device_family IS NULL`;

  // ── ดึงข้อมูล due_month จาก monthly_summary_due_month_cache ──────────────
  const baseQ = `
    SELECT query_type, approve_month, due_month,
           contract_count,
           CAST(principal AS DECIMAL(18,2)) AS principal,
           CAST(interest  AS DECIMAL(18,2)) AS interest,
           CAST(fee       AS DECIMAL(18,2)) AS fee,
           CAST(penalty   AS DECIMAL(18,2)) AS penalty,
           CAST(unlock_fee AS DECIMAL(18,2)) AS unlock_fee,
           CAST(discount  AS DECIMAL(18,2)) AS discount,
           CAST(overpaid  AS DECIMAL(18,2)) AS overpaid,
           CAST(bad_debt  AS DECIMAL(18,2)) AS bad_debt,
           CAST(bad_debt_installment AS DECIMAL(18,2)) AS bad_debt_installment,
           CAST(total_amount AS DECIMAL(18,2)) AS total_amount,
           CAST(COALESCE(finance_total, 0) AS DECIMAL(18,2)) AS finance_total
    FROM monthly_summary_due_month_cache
    WHERE section = '${section}'
      ${ptFilter}
      ${dfFilter}
    ORDER BY approve_month DESC, due_month ASC
  `;
  let allDbRows: any[];
  try {
    allDbRows = pgRows(await db.execute(sql.raw(baseQ))) as any[];
  } catch (err: any) {
    console.warn(`[getDueMonthSummaryFromCache] Cache table not ready: ${err?.message ?? err}`);
    return { rows: [], allDueMonths: [] };
  }

  // ── ดึง approvedCount + installTotalSummary จาก monthly_summary_cache ────
  // (เหมือน Mode สถานะหนี้ — ให้คอลัมน์รวมตรงกัน)
  let summaryCountRows: any[] = [];
  let summaryInstallRows: any[] = [];
  try {
    const [cntResult, installResult] = await Promise.all([
      db.execute(sql.raw(`
        SELECT approve_month, SUM(contract_count) AS total_count
        FROM monthly_summary_cache
        WHERE section = '${section}'
          AND query_type = 'count'
          ${ptFilter}
          ${dfFilter}
          AND date_month IS NULL
        GROUP BY approve_month
        ORDER BY approve_month DESC
      `)),
      db.execute(sql.raw(`
        SELECT approve_month,
               SUM(CAST(principal AS DECIMAL(18,2))) AS principal,
               SUM(CAST(interest  AS DECIMAL(18,2))) AS interest,
               SUM(CAST(fee       AS DECIMAL(18,2))) AS fee,
               SUM(CAST(total_amount AS DECIMAL(18,2))) AS total_amount,
               SUM(CAST(COALESCE(finance_total, 0) AS DECIMAL(18,2))) AS finance_total
        FROM monthly_summary_cache
        WHERE section = '${section}'
          AND query_type = 'installTotal'
          ${ptFilter}
          ${dfFilter}
          AND date_month IS NULL
        GROUP BY approve_month
        ORDER BY approve_month DESC
      `)),
    ]);
    summaryCountRows   = pgRows(cntResult) as any[];
    summaryInstallRows = pgRows(installResult) as any[];
  } catch (_err) {
    // ถ้า monthly_summary_cache ยังไม่มีข้อมูล ใช้ fallback จาก due_month rows แทน
  }

  // แยกตาม query_type
  const countRows        = allDbRows.filter((r) => r.query_type === "count");
  const targetRows       = allDbRows.filter((r) => r.query_type === "target");
  const dueRows          = allDbRows.filter((r) => r.query_type === "due");
  const notYetDueRows    = allDbRows.filter((r) => r.query_type === "notYetDue");
  const installTotalRows = allDbRows.filter((r) => r.query_type === "installTotal");
  const paidRows         = allDbRows.filter((r) => r.query_type === "paid");

  // รวบรวม approve_months และ due_months ทั้งหมด
  // แยก due_date-based queries ออกจาก paid_at query เหมือน getDueMonthSummary (direct query)
  // เพื่อป้องกันเดือนอนาคตจาก paid_at ล่วงหน้าขยาย allDueMonths range
  const monthSet        = new Set<string>();
  const dueDateMonthSet = new Set<string>(); // due_month จาก due_date-based queries
  const paidMonthSet    = new Set<string>(); // due_month จาก paid_at
  for (const r of [...countRows, ...targetRows, ...dueRows, ...notYetDueRows, ...installTotalRows]) {
    monthSet.add(r.approve_month);
    dueDateMonthSet.add(r.due_month);
  }
  for (const r of paidRows) {
    monthSet.add(r.approve_month);
    paidMonthSet.add(r.due_month);
  }
  // เพิ่ม approve_months จาก monthly_summary_cache ด้วย (กรณีที่ due_month cache ยังว่าง)
  for (const r of summaryCountRows) monthSet.add(r.approve_month);

  const approveMonths = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

  // สร้าง allDueMonths เป็น continuous range โดยยึด max จาก due_date-based queries
  // ไม่ใช้ paid_at เป็น max เพราะอาจชำระล่วงหน้าทำให้ range ยาวเกินจริง (มีเดือนอนาคต)
  let allDueMonths: string[];
  const sortedDueDateMonths = Array.from(dueDateMonthSet).sort((a, b) => a.localeCompare(b));
  if (sortedDueDateMonths.length === 0) {
    // ไม่มี due_date data เลย — ใช้ paid months แทน
    allDueMonths = Array.from(paidMonthSet).sort((a, b) => a.localeCompare(b));
  } else {
    const minDm = sortedDueDateMonths[0];
    const maxDm = sortedDueDateMonths[sortedDueDateMonths.length - 1];
    // Generate continuous range from minDm to maxDm (anchor ที่ due_date range)
    allDueMonths = [];
    let [y, m] = minDm.split("-").map(Number);
    const [maxY, maxM] = maxDm.split("-").map(Number);
    while (y < maxY || (y === maxY && m <= maxM)) {
      allDueMonths.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    // เพิ่ม paid months ที่อยู่นอก range เฉพาะที่ไม่เกิน max ของ due_date range
    // (paid ก่อน due_date min สามารถเพิ่มได้ แต่ paid หลัง max ไม่เพิ่ม เพราะเป็นอนาคต)
    const allDueMonthSet = new Set(allDueMonths);
    for (const pm of Array.from(paidMonthSet)) {
      if (!allDueMonthSet.has(pm) && pm <= maxDm) allDueMonths.push(pm);
    }
    allDueMonths.sort((a, b) => a.localeCompare(b));
  }

  // Filter ตาม approveMonths param ถ้ามี
  const filteredApproveMonths = params.approveMonths
    ? approveMonths.filter((m) => params.approveMonths!.includes(m))
    : approveMonths;

  type Key = string;
  const countMap = new Map<Key, number>();
  for (const r of countRows) countMap.set(`${r.approve_month}|${r.due_month}`, n(r.contract_count));

  // approvedCount จาก monthly_summary_cache (เหมือน Mode สถานะหนี้)
  const approvedCountMap = new Map<string, number>();
  for (const r of summaryCountRows) approvedCountMap.set(r.approve_month, n(r.total_count));

  // installTotalSummary จาก monthly_summary_cache (เหมือน Mode สถานะหนี้)
  const installTotalSummaryMap = new Map<string, MoneyBreakdown>();
  const financeTotalSummaryMap = new Map<string, number>();
  for (const r of summaryInstallRows) {
    installTotalSummaryMap.set(r.approve_month, {
      principal: n(r.principal), interest: n(r.interest), fee: n(r.fee),
      penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      total: n(r.total_amount),
    });
    financeTotalSummaryMap.set(r.approve_month, n(r.finance_total ?? 0));
  }

  const targetMap = new Map<Key, MoneyBreakdown>();
  for (const r of targetRows) {
    targetMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal), interest: n(r.interest), fee: n(r.fee),
      penalty: n(r.penalty), unlockFee: n(r.unlock_fee),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_amount),
    });
  }
  const dueMap = new Map<Key, MoneyBreakdown>();
  for (const r of dueRows) {
    dueMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal), interest: n(r.interest), fee: n(r.fee),
      penalty: n(r.penalty), unlockFee: n(r.unlock_fee),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_amount),
    });
  }
  const notYetDueMap = new Map<Key, MoneyBreakdown>();
  for (const r of notYetDueRows) {
    notYetDueMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal), interest: n(r.interest), fee: n(r.fee),
      penalty: n(r.penalty), unlockFee: n(r.unlock_fee),
      discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0, total: n(r.total_amount),
    });
  }
  const installTotalMap = new Map<Key, MoneyBreakdown>();
  const financeTotalDueMap = new Map<Key, number>();
  for (const r of installTotalRows) {
    installTotalMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal), interest: n(r.interest), fee: n(r.fee),
      penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0,
      total: n(r.total_amount),
    });
    financeTotalDueMap.set(`${r.approve_month}|${r.due_month}`, n(r.finance_total ?? 0));
  }
  const paidMap = new Map<Key, MoneyBreakdown>();
  for (const r of paidRows) {
    paidMap.set(`${r.approve_month}|${r.due_month}`, {
      principal: n(r.principal), interest: n(r.interest), fee: n(r.fee),
      penalty: n(r.penalty), unlockFee: n(r.unlock_fee),
      discount: n(r.discount), overpaid: n(r.overpaid),
      badDebt: n(r.bad_debt), badDebtInstallment: n(r.bad_debt_installment),
      total: n(r.total_amount),
    });
  }

  const rows = filteredApproveMonths.map((approveMonth) => {
    const dueMonths: Record<string, DueMonthCell> = {};
    let totalCount = 0;
    const totalPaid         = emptyMoney();
    const totalDue          = emptyMoney();
    const totalTarget       = emptyMoney();
    const totalNotYetDue    = emptyMoney();

    for (const dueMonth of allDueMonths) {
      const key           = `${approveMonth}|${dueMonth}`;
      const contractCount = countMap.get(key) ?? 0;
      const paid          = paidMap.get(key) ?? emptyMoney();
      const due           = dueMap.get(key) ?? emptyMoney();
      const target        = targetMap.get(key) ?? emptyMoney();
      const notYetDue     = notYetDueMap.get(key) ?? emptyMoney();
      const installTotal  = installTotalMap.get(key) ?? emptyMoney();
      const financeTotal  = financeTotalDueMap.get(key) ?? 0;
      if (contractCount === 0 && target.total === 0 && due.total === 0 && notYetDue.total === 0 && installTotal.total === 0 && paid.total === 0) continue;
      dueMonths[dueMonth] = { contractCount, paid, due, target, notYetDue, installTotal, financeTotal };
      totalCount += contractCount;
      for (const k of Object.keys(totalDue) as (keyof MoneyBreakdown)[]) {
        (totalPaid         as any)[k] += paid[k];
        (totalDue          as any)[k] += due[k];
        (totalTarget       as any)[k] += target[k];
        (totalNotYetDue    as any)[k] += notYetDue[k];
      }
    }

    // คอลัมน์รวม: ดึงจาก monthly_summary_cache (เหมือน Mode สถานะหนี้)
    // Fallback: ถ้า monthly_summary_cache ยังไม่มีข้อมูล ใช้ sum ข้าม due_month แทน
    const summaryInstall = installTotalSummaryMap.get(approveMonth);
    const summaryFinance = financeTotalSummaryMap.get(approveMonth);
    let totalInstallTotal: MoneyBreakdown;
    let totalFinanceTotal: number;
    if (summaryInstall !== undefined) {
      totalInstallTotal = summaryInstall;
      totalFinanceTotal = summaryFinance ?? 0;
    } else {
      // Fallback: sum ข้าม due_month
      totalInstallTotal = emptyMoney();
      totalFinanceTotal = 0;
      for (const cell of Object.values(dueMonths)) {
        totalFinanceTotal += cell.financeTotal;
        for (const k of Object.keys(totalInstallTotal) as (keyof MoneyBreakdown)[]) {
          (totalInstallTotal as any)[k] += cell.installTotal[k];
        }
      }
    }
    // approvedCount จาก monthly_summary_cache
    const approvedCount = approvedCountMap.get(approveMonth) ?? totalCount;
    return { approveMonth, dueMonths, totalCount, approvedCount, totalPaid, totalDue, totalTarget, totalNotYetDue, totalInstallTotal, totalFinanceTotal };
  });
  return { rows, allDueMonths };
}

// ---------------------------------------------------------------------------
// getMonthlySummaryTotalsOnly — คอลัมน์รวมที่ถูกต้อง (Phase Rewrite)
// รัน 7 queries โดยตรง ทุก query group by approve_date ของสัญญา
// ไม่ผ่าน cache เพื่อความถูกต้อง
// ---------------------------------------------------------------------------

export type MonthlySummaryTotalsRow = {
  approveMonth: string;           // YYYY-MM
  contractCount: number;          // จำนวนสัญญาทั้งหมดที่อนุมัติในเดือนนั้น
  financeTotal: number;           // ยอดจัดฯ = SUM(finance_amount) ต่อสัญญา
  // ยอดผ่อนรวม breakdown
  installTotal: number;           // ยอดผ่อนรวม = SUM(baseline_amount × installment_count)
  installPrincipal: number;       // เงินต้นรวม
  installInterest: number;        // ดอกเบี้ยรวม
  installFee: number;             // ค่าดำเนินการรวม
  // เป้าเก็บหนี้ breakdown
  targetTotal: number;            // เป้าเก็บหนี้ = SUM(principal+interest+fee WHERE due_date ≤ today)
  targetPrincipal: number;
  targetInterest: number;
  targetFee: number;
  targetPenalty: number;
  targetUnlockFee: number;
  // ยอดเก็บหนี้ breakdown
  paidTotal: number;              // ยอดเก็บหนี้ = SUM(bad_debt_installment) = ptTotal ไม่รวมยอดขายเครื่อง
  paidPrincipal: number;
  paidInterest: number;
  paidFee: number;
  paidPenalty: number;
  paidUnlockFee: number;
  paidDiscount: number;
  paidOverpaid: number;
  paidBadDebt: number;
  paidBadDebtInstallment: number;
  // หนี้ค้างชำระ breakdown
  dueTotal: number;               // หนี้ค้างชำระ = SUM(total_amount - paid_amount WHERE is_arrears)
  duePrincipal: number;
  dueInterest: number;
  dueFee: number;
  duePenalty: number;
  dueUnlockFee: number;
  // ยังไม่ถึงกำหนด breakdown
  notYetDueTotal: number;         // ยังไม่ถึงกำหนด = SUM(total_amount WHERE due_date > today)
  notYetDuePrincipal: number;
  notYetDueInterest: number;
  notYetDueFee: number;
  notYetDuePenalty: number;
  notYetDueUnlockFee: number;
};

export async function getMonthlySummaryTotalsOnly(
  section: SectionKey,
  params: MonthlySummaryParams,
): Promise<MonthlySummaryTotalsRow | null> {
  // NOTE: ดึงตรงจาก DB โดยเรียก getMonthlySummary แล้ว SUM ผลลัพธ์
  // วิธีนี้รับประกันว่าใช้ logic เดียวกับ live query 100% — ไม่ผ่าน cache
  const rows = await getMonthlySummary(params);
  if (!rows || rows.length === 0) return null;

  // SUM ทุก row เป็น grand total
  let contractCount = 0;
  let financeTotal = 0;
  const installTotal = { total: 0, principal: 0, interest: 0, fee: 0 };
  const target = { total: 0, principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0 };
  const paid = { total: 0, principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, badDebtInstallment: 0 };
  const due = { total: 0, principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0 };
  const notYetDue = { total: 0, principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0 };

  for (const row of rows) {
    contractCount      += row.totalCount;
    financeTotal       += row.totalFinanceTotal;
    installTotal.total     += row.totalInstallTotal.total;
    installTotal.principal += row.totalInstallTotal.principal;
    installTotal.interest  += row.totalInstallTotal.interest;
    installTotal.fee       += row.totalInstallTotal.fee;
    target.total     += row.totalTarget.total;
    target.principal += row.totalTarget.principal;
    target.interest  += row.totalTarget.interest;
    target.fee       += row.totalTarget.fee;
    target.penalty   += row.totalTarget.penalty;
    target.unlockFee += row.totalTarget.unlockFee;
    paid.total              += row.totalPaid.total;
    paid.principal          += row.totalPaid.principal;
    paid.interest           += row.totalPaid.interest;
    paid.fee                += row.totalPaid.fee;
    paid.penalty            += row.totalPaid.penalty;
    paid.unlockFee          += row.totalPaid.unlockFee;
    paid.discount           += row.totalPaid.discount;
    paid.overpaid           += row.totalPaid.overpaid;
    paid.badDebt            += row.totalPaid.badDebt;
    paid.badDebtInstallment += row.totalPaid.badDebtInstallment;
    due.total     += row.totalDue.total;
    due.principal += row.totalDue.principal;
    due.interest  += row.totalDue.interest;
    due.fee       += row.totalDue.fee;
    due.penalty   += row.totalDue.penalty;
    due.unlockFee += row.totalDue.unlockFee;
    notYetDue.total     += row.totalNotYetDue.total;
    notYetDue.principal += row.totalNotYetDue.principal;
    notYetDue.interest  += row.totalNotYetDue.interest;
    notYetDue.fee       += row.totalNotYetDue.fee;
    notYetDue.penalty   += row.totalNotYetDue.penalty;
    notYetDue.unlockFee += row.totalNotYetDue.unlockFee;
  }

  return {
    approveMonth:           '__grand__',
    contractCount,
    financeTotal,
    installTotal:           installTotal.total,
    installPrincipal:       installTotal.principal,
    installInterest:        installTotal.interest,
    installFee:             installTotal.fee,
    targetTotal:            target.total,
    targetPrincipal:        target.principal,
    targetInterest:         target.interest,
    targetFee:              target.fee,
    targetPenalty:          0,  // ตัด penalty ออก ตรงกับ DebtOverview
    targetUnlockFee:        0,  // ตัด unlockFee ออก ตรงกับ DebtOverview
    paidTotal:              paid.total,
    paidPrincipal:          paid.principal,
    paidInterest:           paid.interest,
    paidFee:                paid.fee,
    paidPenalty:            paid.penalty,
    paidUnlockFee:          paid.unlockFee,
    paidDiscount:           paid.discount,
    paidOverpaid:           paid.overpaid,
    paidBadDebt:            paid.badDebt,
    paidBadDebtInstallment: paid.badDebtInstallment,
    dueTotal:               due.total,
    duePrincipal:           due.principal,
    dueInterest:            due.interest,
    dueFee:                 due.fee,
    duePenalty:             due.penalty,
    dueUnlockFee:           due.unlockFee,
    notYetDueTotal:         notYetDue.total,
    notYetDuePrincipal:     notYetDue.principal,
    notYetDueInterest:      notYetDue.interest,
    notYetDueFee:           notYetDue.fee,
    notYetDuePenalty:       notYetDue.penalty,
    notYetDueUnlockFee:     notYetDue.unlockFee,
  };

  // ── DEAD CODE BELOW (cache path — ถูก bypass แล้ว) ──────────────────────────
  const db = await getDb(section);
  if (!db) return null;

  // ── Helper functions (เหมือน getMonthlySummaryFromCache) ──────────────────
  function dateMonthCond(months: string[] | undefined, singleDate: string | undefined): string {
    if (singleDate) {
      const m = singleDate.substring(0, 7);
      return `date_month = '${m}'`;
    }
    if (months && months.length > 0) {
      const list = months.map((m) => `'${m}'`).join(",");
      return `date_month IN (${list})`;
    }
    return `date_month IS NULL`;
  }
  // dateMonthCondAll: เหมือน dateMonthCond แต่เมื่อไม่มี filter จะดึงทุก date_month (1=1)
  // ใช้กับ paid/due/notYetDue ซึ่ง date_month มีค่าเสมอ (ไม่เคย NULL)
  function dateMonthCondAll(months: string[] | undefined, singleDate: string | undefined): string {
    if (singleDate) {
      const m = singleDate.substring(0, 7);
      return `date_month = '${m}'`;
    }
    if (months && months.length > 0) {
      const list = months.map((m) => `'${m}'`).join(",");
      return `date_month IN (${list})`;
    }
    return `1=1`; // ไม่มี filter → ดึงทุก date_month
  }
  // dateMonthCondPaid: ใช้สำหรับ paid tab ที่รองรับทั้ง paidAtMonths และ approveMonths
  function dateMonthCondPaid(paidAtMonths: string[] | undefined, approveMonths: string[] | undefined, singleDate: string | undefined): string {
    // ถ้ามี approveMonths filter (เพราะ paid group ตาม approve_month แล้วใน cache)
    if (approveMonths && approveMonths.length > 0) {
      const list = approveMonths.map((m) => `'${m}'`).join(",");
      return `date_month IN (${list})`;
    }
    return dateMonthCondAll(paidAtMonths, singleDate);
  }
  function productTypeCond(pt: string | undefined): string {
    if (pt) return `product_type = '${pt.replace(/'/g, "''")}'`;
    return `product_type IS NULL`;
  }
  function deviceFamilyCond(df: string | undefined): string {
    if (df) return `device_family = '${df}'`;
    return `device_family IS NULL`;
  }

  // ── ดึงข้อมูลจาก monthly_summary_cache (SUM across all buckets) ──────────
  const [countRows, targetRows, paidRows, dueRows, notYetDueRows, installTotalRows] = await Promise.all([
    // count: ไม่มี dateMonth filter — SUM ทั้งหมดเป็น grand total
    db.execute(sql.raw(`
      SELECT SUM(contract_count) AS contract_count
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'count'
        AND ${productTypeCond(params.countProductType)}
        AND ${deviceFamilyCond(params.countDeviceFamily)}
        AND date_month IS NULL
    `)),
    // target: dueMonth filter — SUM ทั้งหมดเป็น grand total
    db.execute(sql.raw(`
      SELECT SUM(principal) AS target_principal,
             SUM(interest)  AS target_interest,
             SUM(fee)       AS target_fee,
             SUM(penalty)   AS target_penalty,
             SUM(unlock_fee) AS target_unlock_fee,
             SUM(total_amount) AS target_total
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'target'
        AND ${productTypeCond(params.targetProductType)}
        AND ${deviceFamilyCond(params.targetDeviceFamily)}
        AND ${dateMonthCond(params.targetDueMonths, params.targetDueDate)}
    `)),
    // paid: paidAtMonth filter — SUM ทั้งหมดเป็น grand total (ไม่แยก approve_month เพราะ paid.approve_month = paid_at month)
    db.execute(sql.raw(`
      SELECT SUM(principal)            AS paid_principal,
             SUM(interest)             AS paid_interest,
             SUM(fee)                  AS paid_fee,
             SUM(penalty)              AS paid_penalty,
             SUM(unlock_fee)           AS paid_unlock_fee,
             SUM(discount)             AS paid_discount,
             SUM(overpaid)             AS paid_overpaid,
             SUM(bad_debt)             AS paid_bad_debt,
             SUM(bad_debt_installment) AS paid_bad_debt_installment,
             SUM(bad_debt_installment) AS paid_total
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'paid'
        AND ${productTypeCond(params.paidProductType)}
        AND ${deviceFamilyCond(params.paidDeviceFamily)}
        AND ${dateMonthCondPaid(params.paidAtMonths, params.paidApproveMonths, params.paidAtDate)}
    `)),
    // due: dueAtMonth filter — SUM ทั้งหมดเป็น grand total
    db.execute(sql.raw(`
      SELECT SUM(principal) AS due_principal,
             SUM(interest)  AS due_interest,
             SUM(fee)       AS due_fee,
             SUM(penalty)   AS due_penalty,
             SUM(unlock_fee) AS due_unlock_fee,
             SUM(total_amount) AS due_total
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'due'
        AND ${productTypeCond(params.dueProductType)}
        AND ${deviceFamilyCond(params.dueDeviceFamily)}
        AND ${dateMonthCondAll(params.dueAtMonths, params.dueAtDate)}
    `)),
    // notYetDue: dueMonth filter — SUM ทั้งหมดเป็น grand total
    db.execute(sql.raw(`
      SELECT SUM(principal) AS not_yet_due_principal,
             SUM(interest)  AS not_yet_due_interest,
             SUM(fee)       AS not_yet_due_fee,
             SUM(penalty)   AS not_yet_due_penalty,
             SUM(unlock_fee) AS not_yet_due_unlock_fee,
             SUM(total_amount) AS not_yet_due_total
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'notYetDue'
        AND ${productTypeCond(params.notYetDueProductType)}
        AND ${deviceFamilyCond(params.notYetDueDeviceFamily)}
        AND ${dateMonthCondAll(params.notYetDueDueMonths, params.notYetDueDueDate)}
    `)),
    // installTotal: ไม่มี dateMonth filter — SUM ทั้งหมดเป็น grand total
    db.execute(sql.raw(`
      SELECT SUM(principal)    AS install_principal,
             SUM(interest)     AS install_interest,
             SUM(fee)          AS install_fee,
             SUM(total_amount) AS install_total,
             SUM(finance_total) AS finance_total
      FROM monthly_summary_cache
      WHERE section = '${section}' AND query_type = 'installTotal'
        AND ${productTypeCond(params.installTotalProductType)}
        AND ${deviceFamilyCond(params.installTotalDeviceFamily)}
        AND date_month IS NULL
    `)),
  ]);

  // ── Assemble grand total (single row) ──────────────────────────────────────
  // ไม่แยกตาม approve_month เพราะ paid.approve_month = paid_at month (ไม่ใช่ approve_date)
  const r1 = pgRows(countRows)[0] as any;
  const r2 = pgRows(targetRows)[0] as any;
  const r3 = pgRows(paidRows)[0] as any;
  const r4 = pgRows(dueRows)[0] as any;
  const r5 = pgRows(notYetDueRows)[0] as any;
  const r6 = pgRows(installTotalRows)[0] as any;

  return {
    approveMonth:       '__grand__',
    contractCount:      n(r1?.contract_count ?? 0),
    financeTotal:       n(r6?.finance_total ?? 0),
    // ยอดผ่อนรวม breakdown
    installTotal:       n(r6?.install_total ?? 0),
    installPrincipal:   n(r6?.install_principal ?? 0),
    installInterest:    n(r6?.install_interest ?? 0),
    installFee:         n(r6?.install_fee ?? 0),
    // เป้าเก็บหนี้ breakdown (ตัด penalty/unlockFee ออก ตรงกับ DebtOverview)
    targetTotal:        n(r2?.target_total ?? 0),
    targetPrincipal:    n(r2?.target_principal ?? 0),
    targetInterest:     n(r2?.target_interest ?? 0),
    targetFee:          n(r2?.target_fee ?? 0),
    targetPenalty:      0,  // ตัด penalty ออก
    targetUnlockFee:    0,  // ตัด unlockFee ออก
    // ยอดเก็บหนี้ breakdown
    paidTotal:              n(r3?.paid_total ?? 0),
    paidPrincipal:          n(r3?.paid_principal ?? 0),
    paidInterest:           n(r3?.paid_interest ?? 0),
    paidFee:                n(r3?.paid_fee ?? 0),
    paidPenalty:            n(r3?.paid_penalty ?? 0),
    paidUnlockFee:          n(r3?.paid_unlock_fee ?? 0),
    paidDiscount:           n(r3?.paid_discount ?? 0),
    paidOverpaid:           n(r3?.paid_overpaid ?? 0),
    paidBadDebt:            n(r3?.paid_bad_debt ?? 0),
    paidBadDebtInstallment: n(r3?.paid_bad_debt_installment ?? 0),
    // หนี้ค้างชำระ breakdown
    dueTotal:           n(r4?.due_total ?? 0),
    duePrincipal:       n(r4?.due_principal ?? 0),
    dueInterest:        n(r4?.due_interest ?? 0),
    dueFee:             n(r4?.due_fee ?? 0),
    duePenalty:         n(r4?.due_penalty ?? 0),
    dueUnlockFee:       n(r4?.due_unlock_fee ?? 0),
    // ยังไม่ถึงกำหนด breakdown
    notYetDueTotal:     n(r5?.not_yet_due_total ?? 0),
    notYetDuePrincipal: n(r5?.not_yet_due_principal ?? 0),
    notYetDueInterest:  n(r5?.not_yet_due_interest ?? 0),
    notYetDueFee:       n(r5?.not_yet_due_fee ?? 0),
    notYetDuePenalty:   n(r5?.not_yet_due_penalty ?? 0),
    notYetDueUnlockFee: n(r5?.not_yet_due_unlock_fee ?? 0),
  };
}

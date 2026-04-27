/**
 * Monthly Summary DB helpers — SQL-aggregate version (Phase 83).
 *
 * 3 แถบ (tab):
 *   1. จำนวนสัญญา    — filter: approveDate (exact), approveMonths (multi), countProductType, countDeviceFamily (iOS/Android)
 *   2. ยอดที่ชำระแล้ว — filter: paidAtDate (exact), paidAtMonths (multi), paidProductType, paidDeviceFamily
 *   3. ยอดที่ค้างชำระ  — filter: dueAtDate (exact), dueAtMonths (multi), dueProductType, dueDeviceFamily
 *
 * Bucket (debt_status) ใช้ logic เดียวกับ DebtReport:
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
  unlockFee: number;   // paid side เท่านั้น
  discount: number;    // paid side เท่านั้น
  overpaid: number;    // paid side เท่านั้น
  badDebt: number;     // paid side เท่านั้น — ยอดขายเครื่อง (bad_debt_amount)
  badDebtInstallment: number; // paid side — ยอดค่างวดหนี้เสีย (total_paid สำหรับ bucket หนี้เสีย)
  total: number;
};

export type MonthlySummaryCell = {
  contractCount: number;
  paid: MoneyBreakdown;
  due: MoneyBreakdown;
};

export type MonthlySummaryRow = {
  approveMonth: string; // YYYY-MM
  buckets: Record<string, MonthlySummaryCell>;
  totalCount: number;
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
};

export type MonthlySummaryParams = {
  section: SectionKey;
  // Tab 1: จำนวนสัญญา
  countApproveDate?: string;       // exact date YYYY-MM-DD
  countApproveMonths?: string[];   // multi YYYY-MM
  countProductType?: string;
  countDeviceFamily?: string;      // "iOS" | "Android"
  // Tab 2: ยอดชำระแล้ว
  paidAtDate?: string;             // exact date YYYY-MM-DD
  paidAtMonths?: string[];         // multi YYYY-MM
  paidProductType?: string;
  paidDeviceFamily?: string;
  // Tab 3: ยอดค้างชำระ
  dueAtDate?: string;              // exact date YYYY-MM-DD
  dueAtMonths?: string[];          // multi YYYY-MM
  dueProductType?: string;
  dueDeviceFamily?: string;
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
  return { contractCount: 0, paid: emptyMoney(), due: emptyMoney() };
}
function n(v: unknown): number {
  const x = parseFloat(String(v ?? 0));
  return isNaN(x) ? 0 : x;
}

/**
 * SQL CASE WHEN สำหรับ derive bucket จาก contract status + max overdue days
 */
const BUCKET_CASE = `
  CASE
    WHEN c.status = 'หนี้เสีย'      THEN 'หนี้เสีย'
    WHEN c.status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
    WHEN c.status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
    ELSE CASE
      WHEN COALESCE(max_overdue.max_days, 0) <= 0  THEN 'ปกติ'
      WHEN COALESCE(max_overdue.max_days, 0) <= 7  THEN 'เกิน 1-7'
      WHEN COALESCE(max_overdue.max_days, 0) <= 14 THEN 'เกิน 8-14'
      WHEN COALESCE(max_overdue.max_days, 0) <= 30 THEN 'เกิน 15-30'
      WHEN COALESCE(max_overdue.max_days, 0) <= 60 THEN 'เกิน 31-60'
      WHEN COALESCE(max_overdue.max_days, 0) <= 90 THEN 'เกิน 61-90'
      ELSE 'เกิน >90'
    END
  END
`;

function maxOverdueSubquery(section: string): string {
  return `(
    SELECT i.contract_external_id,
           MAX(DATEDIFF(CURDATE(), i.due_date)) AS max_days
    FROM   installments i
    WHERE  i.section = '${section}'
      AND  i.due_date <= CURDATE()
      AND  COALESCE(i.paid_amount, 0) < COALESCE(i.amount, 0)
      AND  COALESCE(i.amount, 0) > 0
    GROUP BY i.contract_external_id
  ) max_overdue`;
}

/** Build WHERE clause for contracts table */
function contractWhere(section: string, opts: {
  productType?: string;
  deviceFamily?: string;
  approveDate?: string;
  approveMonths?: string[];
}): string {
  let w = `c.section = '${section}'
    AND c.approve_date IS NOT NULL
    AND COALESCE(c.status, '') != 'ยกเลิกสัญญา'`;

  if (opts.productType) {
    w += `\n    AND c.product_type = '${opts.productType.replace(/'/g, "''")}'`;
  }
  if (opts.deviceFamily === "iOS") {
    w += `\n    AND c.device IN ('iPhone', 'iPad')`;
  } else if (opts.deviceFamily === "Android") {
    w += `\n    AND c.device NOT IN ('iPhone', 'iPad') AND c.device IS NOT NULL AND c.device != ''`;
  }
  if (opts.approveDate) {
    w += `\n    AND DATE(c.approve_date) = '${opts.approveDate}'`;
  } else if (opts.approveMonths && opts.approveMonths.length > 0) {
    const list = opts.approveMonths.map((m) => `'${m}'`).join(",");
    w += `\n    AND DATE_FORMAT(c.approve_date, '%Y-%m') IN (${list})`;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Query 1: Count tab
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
      DATE_FORMAT(c.approve_date, '%Y-%m') AS approve_month,
      ${BUCKET_CASE} AS bucket,
      COUNT(DISTINCT c.external_id)        AS contract_count
    FROM contracts c
    LEFT JOIN ${maxOverdueSubquery(section)}
           ON max_overdue.contract_external_id = c.external_id
    WHERE ${contractWhere(section, opts)}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 2: Paid tab
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
  // ค่างวด = total_paid_amount (payment_transactions) - ยอดขายเครื่อง
  installment_paid: number;
  // ขายเครื่อง = contracts.bad_debt_amount (กรองตาม bad_debt_date ถ้ามี date filter)
  device_sale_amount: number;
  total_paid: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  // Build paid_at filter สำหรับ payment_transactions
  let paidFilter = `pt.section = '${section}'`;
  if (opts.paidAtDate) {
    paidFilter += `\n      AND DATE(pt.paid_at) = '${opts.paidAtDate}'`;
  } else if (opts.paidAtMonths && opts.paidAtMonths.length > 0) {
    const list = opts.paidAtMonths.map((m) => `'${m}'`).join(",");
    paidFilter += `\n      AND DATE_FORMAT(pt.paid_at, '%Y-%m') IN (${list})`;
  }

  // Build bad_debt_date filter สำหรับ ยอดขายเครื่อง
  // ถ้ากรองเดือน/วัน ให้กรอง bad_debt_date ด้วย
  let badDebtDateFilter = ``;
  if (opts.paidAtDate) {
    badDebtDateFilter = `AND DATE(c2.bad_debt_date) = '${opts.paidAtDate}'`;
  } else if (opts.paidAtMonths && opts.paidAtMonths.length > 0) {
    const list = opts.paidAtMonths.map((m) => `'${m}'`).join(",");
    badDebtDateFilter = `AND DATE_FORMAT(c2.bad_debt_date, '%Y-%m') IN (${list})`;
  }

  const q = `
    SELECT
      DATE_FORMAT(c.approve_date, '%Y-%m') AS approve_month,
      ${BUCKET_CASE} AS bucket,
      COUNT(DISTINCT c.external_id)        AS contract_count,
      SUM(COALESCE(paid_agg.principal_paid,  0)) AS principal_paid,
      SUM(COALESCE(paid_agg.interest_paid,   0)) AS interest_paid,
      SUM(COALESCE(paid_agg.fee_paid,        0)) AS fee_paid,
      SUM(COALESCE(paid_agg.penalty_paid,    0)) AS penalty_paid,
      SUM(COALESCE(paid_agg.unlock_fee_paid, 0)) AS unlock_fee_paid,
      SUM(COALESCE(paid_agg.discount_amount, 0)) AS discount_amount,
      SUM(COALESCE(paid_agg.overpaid_amount, 0)) AS overpaid_amount,
      -- ค่างวด = total_paid - ยอดขายเครื่อง (bad_debt_amount ที่ตรงกับ date filter)
      SUM(GREATEST(COALESCE(paid_agg.total_paid, 0) - COALESCE(bda.device_sale_amount, 0), 0)) AS installment_paid,
      -- ขายเครื่อง = bad_debt_amount จาก contracts กรองตาม bad_debt_date
      SUM(COALESCE(bda.device_sale_amount, 0)) AS device_sale_amount,
      SUM(COALESCE(paid_agg.total_paid,    0)) AS total_paid
    FROM contracts c
    LEFT JOIN ${maxOverdueSubquery(section)}
           ON max_overdue.contract_external_id = c.external_id
    LEFT JOIN (
      SELECT
        pt.contract_external_id,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.principal_paid')  AS DECIMAL(18,2))) AS principal_paid,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.interest_paid')   AS DECIMAL(18,2))) AS interest_paid,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.fee_paid')        AS DECIMAL(18,2))) AS fee_paid,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.penalty_paid')    AS DECIMAL(18,2))) AS penalty_paid,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.unlock_fee_paid') AS DECIMAL(18,2))) AS unlock_fee_paid,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.discount_amount') AS DECIMAL(18,2))) AS discount_amount,
        SUM(CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') AS DECIMAL(18,2))) AS overpaid_amount,
        SUM(CAST(pt.amount AS DECIMAL(18,2)))                                       AS total_paid
      FROM payment_transactions pt
      WHERE ${paidFilter}
        AND (JSON_EXTRACT(pt.raw_json, '$.source') IS NULL OR JSON_EXTRACT(pt.raw_json, '$.source') != '"installment"')
        AND JSON_EXTRACT(pt.raw_json, '$.receipt_no') IS NOT NULL
      GROUP BY pt.contract_external_id
    ) paid_agg ON paid_agg.contract_external_id = c.external_id
    -- ยอดขายเครื่อง: ดึงจาก contracts โดยตรง กรองตาม bad_debt_date
    LEFT JOIN (
      SELECT c2.external_id,
             CAST(c2.bad_debt_amount AS DECIMAL(18,2)) AS device_sale_amount
      FROM contracts c2
      WHERE c2.section = '${section}'
        AND c2.bad_debt_amount > 0
        AND c2.bad_debt_date IS NOT NULL
        ${badDebtDateFilter}
    ) bda ON bda.external_id = c.external_id
    WHERE ${contractWhere(section, { productType: opts.productType, deviceFamily: opts.deviceFamily })}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 3: Due tab
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
  total_due: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  let dueFilter = `i2.section = '${section}'
      AND COALESCE(i2.paid_amount, 0) < COALESCE(i2.amount, 0)
      AND COALESCE(i2.amount, 0) > 0`;
  if (opts.dueAtDate) {
    dueFilter += `\n      AND DATE(i2.due_date) = '${opts.dueAtDate}'`;
  } else if (opts.dueAtMonths && opts.dueAtMonths.length > 0) {
    const list = opts.dueAtMonths.map((m) => `'${m}'`).join(",");
    dueFilter += `\n      AND DATE_FORMAT(i2.due_date, '%Y-%m') IN (${list})`;
  }

  const q = `
    SELECT
      DATE_FORMAT(c.approve_date, '%Y-%m') AS approve_month,
      ${BUCKET_CASE} AS bucket,
      COUNT(DISTINCT c.external_id)        AS contract_count,
      SUM(COALESCE(due_agg.principal_due, 0)) AS principal_due,
      SUM(COALESCE(due_agg.interest_due,  0)) AS interest_due,
      SUM(COALESCE(due_agg.fee_due,       0)) AS fee_due,
      SUM(COALESCE(due_agg.penalty_due,   0)) AS penalty_due,
      SUM(COALESCE(due_agg.total_due,     0)) AS total_due
    FROM contracts c
    LEFT JOIN ${maxOverdueSubquery(section)}
           ON max_overdue.contract_external_id = c.external_id
    LEFT JOIN (
      SELECT
        i2.contract_external_id,
        SUM(CAST(JSON_EXTRACT(i2.raw_json, '$.principal_due')    AS DECIMAL(18,2))) AS principal_due,
        SUM(CAST(JSON_EXTRACT(i2.raw_json, '$.interest_due')     AS DECIMAL(18,2))) AS interest_due,
        SUM(CAST(JSON_EXTRACT(i2.raw_json, '$.fee_due')          AS DECIMAL(18,2))) AS fee_due,
        SUM(CAST(JSON_EXTRACT(i2.raw_json, '$.penalty_due')      AS DECIMAL(18,2))) AS penalty_due,
        SUM(CAST(JSON_EXTRACT(i2.raw_json, '$.total_due_amount') AS DECIMAL(18,2))) AS total_due
      FROM installments i2
      WHERE ${dueFilter}
      GROUP BY i2.contract_external_id
    ) due_agg ON due_agg.contract_external_id = c.external_id
    WHERE ${contractWhere(section, { productType: opts.productType, deviceFamily: opts.deviceFamily })}
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

  // Run 3 queries in parallel
  const [countRows, paidRows, dueRows] = await Promise.all([
    queryCount(section, {
      productType:    params.countProductType,
      deviceFamily:   params.countDeviceFamily,
      approveDate:    params.countApproveDate,
      approveMonths:  params.countApproveMonths,
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
  ]);

  // Collect all approve_months
  const monthSet = new Set<string>();
  for (const r of countRows) monthSet.add(r.approve_month);
  for (const r of paidRows)  monthSet.add(r.approve_month);
  for (const r of dueRows)   monthSet.add(r.approve_month);

  const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

  // Build lookup maps
  type CellKey = string;
  const countMap = new Map<CellKey, number>();
  for (const r of countRows) {
    countMap.set(`${r.approve_month}|${r.bucket}`, n(r.contract_count));
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
      badDebt:            n(r.device_sale_amount),     // ยอดขายเครื่อง (contracts.bad_debt_amount กรองตาม bad_debt_date)
      badDebtInstallment: n(r.installment_paid),       // ค่างวด = total_paid - ยอดขายเครื่อง
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
      unlockFee:          0,
      discount:           0,
      overpaid:           0,
      badDebt:            0,
      badDebtInstallment: 0,
      total:              n(r.total_due),
    });
  }

  // Assemble MonthlySummaryRow[]
  return months.map((month) => {
    const buckets: Record<string, MonthlySummaryCell> = {};
    let totalCount = 0;
    const totalPaid = emptyMoney();
    const totalDue  = emptyMoney();

    for (const bucket of DEBT_BUCKETS) {
      const key = `${month}|${bucket}`;
      const contractCount = countMap.get(key) ?? 0;
      const paid  = paidMap.get(key)  ?? emptyMoney();
      const due   = dueMap.get(key)   ?? emptyMoney();

      buckets[bucket] = { contractCount, paid, due };
      totalCount += contractCount;

      for (const k of Object.keys(totalPaid) as (keyof MoneyBreakdown)[]) {
        (totalPaid as any)[k] += paid[k];
        (totalDue  as any)[k] += due[k];
      }
    }

    return { approveMonth: month, buckets, totalCount, totalPaid, totalDue };
  });
}

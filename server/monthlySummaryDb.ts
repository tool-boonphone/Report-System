/**
 * Monthly Summary DB helpers — Phase 127 (rewritten to use cache tables).
 *
 * Primary sources:
 *   - debt_target_cache  → Count tab (จำนวนสัญญา) + Due tab (ยอดค้างชำระ)
 *   - debt_collected_cache → Paid tab (ยอดที่ชำระแล้ว)
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
  unlockFee: number;   // paid side เท่านั้น
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
  paidAtDate?: string;             // exact date YYYY-MM-DD (paid_at)
  paidAtMonths?: string[];         // multi YYYY-MM
  paidProductType?: string;
  paidDeviceFamily?: string;
  // Tab 3: ยอดค้างชำระ
  dueAtDate?: string;              // exact date YYYY-MM-DD (due_date)
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

/** Build WHERE clause for debt_target_cache */
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

  // Use a subquery to get one row per contract (latest period determines bucket)
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
// Query 2: Paid tab — from debt_collected_cache
// bucket derived from contract_status + debt_range stored in cache
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
  installment_paid: number;  // ยอดค่างวดปกติ (is_bad_debt_row = 0)
  device_sale_amount: number; // ยอดขายเครื่อง (is_bad_debt_row = 1, SUM bad_debt)
  total_paid: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  // Bucket for collected cache uses contract_status + debt_range from dcc
  const BUCKET_CASE_DCC = `
    CASE
      WHEN dcc.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
      WHEN dcc.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
      WHEN dcc.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
      ELSE COALESCE(dcc.debt_range, 'ปกติ')
    END
  `;

  // Check if debt_collected_cache has debt_range column
  // (it was added in Phase 127 — if not present, fall back to contract_status only)
  const q = `
    SELECT
      DATE_FORMAT(dcc.approve_date, '%Y-%m') AS approve_month,
      CASE
        WHEN dcc.contract_status = 'หนี้เสีย'      THEN 'หนี้เสีย'
        WHEN dcc.contract_status = 'ระงับสัญญา'   THEN 'ระงับสัญญา'
        WHEN dcc.contract_status = 'สิ้นสุดสัญญา' THEN 'สิ้นสุดสัญญา'
        ELSE 'ปกติ'
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
    WHERE ${dccWhere(section, opts)}
    GROUP BY approve_month, bucket
    ORDER BY approve_month DESC
  `;
  const rows = await db.execute(sql.raw(q));
  return (rows as any)[0] ?? [];
}

// ---------------------------------------------------------------------------
// Query 3: Due tab — from debt_target_cache
// ยอดค้างชำระ = SUM(total_amount - paid_amount) WHERE is_arrears = 1
// กรองตาม due_date
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

  // Build due_date filter
  let dueDateFilter = "";
  if (opts.dueAtDate) {
    dueDateFilter = `\n    AND DATE(dtc.due_date) = '${opts.dueAtDate}'`;
  } else if (opts.dueAtMonths && opts.dueAtMonths.length > 0) {
    const list = opts.dueAtMonths.map((m) => `'${m}'`).join(",");
    dueDateFilter = `\n    AND DATE_FORMAT(dtc.due_date, '%Y-%m') IN (${list})`;
  }

  // Build product/device filter (reuse dtcWhere base but add due_date)
  const baseWhere = dtcWhere(section, {
    productType: opts.productType,
    deviceFamily: opts.deviceFamily,
  });

  const q = `
    SELECT
      DATE_FORMAT(dtc.approve_date, '%Y-%m') AS approve_month,
      ${BUCKET_CASE_DTC} AS bucket,
      COUNT(DISTINCT dtc.contract_external_id) AS contract_count,
      SUM(GREATEST(CAST(dtc.principal  AS DECIMAL(18,2)) - CAST(dtc.paid_amount AS DECIMAL(18,2)), 0)) AS principal_due,
      SUM(CAST(dtc.interest  AS DECIMAL(18,2))) AS interest_due,
      SUM(CAST(dtc.fee       AS DECIMAL(18,2))) AS fee_due,
      SUM(CAST(dtc.penalty   AS DECIMAL(18,2))) AS penalty_due,
      SUM(GREATEST(CAST(dtc.total_amount AS DECIMAL(18,2)) - CAST(dtc.paid_amount AS DECIMAL(18,2)), 0)) AS total_due
    FROM debt_target_cache dtc
    WHERE ${baseWhere}
      AND dtc.is_arrears = 1
      ${dueDateFilter}
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
      badDebt:            n(r.device_sale_amount),     // ยอดขายเครื่อง (bad_debt WHERE is_bad_debt_row=1)
      badDebtInstallment: n(r.installment_paid),       // ค่างวด (total_amount WHERE is_bad_debt_row=0)
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

/**
 * Monthly Summary DB helpers.
 *
 * หน้าสรุปรายเดือน: group by เดือนที่อนุมัติสัญญา (approve_date) + debt_status bucket
 *
 * 3 แถบ (tab) — แต่ละแถบมี filter ของตัวเอง:
 *   1. จำนวนสัญญา    — filter: productType
 *   2. ยอดที่ชำระแล้ว — filter: paidAtFrom/paidAtTo + paidAtMonth (YYYY-MM) + productType
 *   3. ยอดที่ค้างชำระ  — filter: dueAtFrom/dueAtTo + dueAtMonth (YYYY-MM) + productType
 *
 * Bucket (debt_status) ใช้ logic เดียวกับ DebtReport:
 *   ปกติ / เกิน 1-7 / เกิน 8-14 / เกิน 15-30 / เกิน 31-60 /
 *   เกิน 61-90 / เกิน >90 / ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย
 */

import { sql } from "drizzle-orm";
import {
  contracts,
  installments,
  paymentTransactions,
} from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** ยอดเงินแยก 9 รายการ (ใช้ทั้ง paid และ due side) */
export type MoneyBreakdown = {
  principal: number;   // เงินต้น
  interest: number;    // ดอกเบี้ย
  fee: number;         // ค่าดำเนินการ
  penalty: number;     // ค่าปรับ
  unlockFee: number;   // ค่าปลดล็อก (paid side เท่านั้น)
  discount: number;    // ส่วนลด (paid side เท่านั้น)
  overpaid: number;    // ชำระเกิน (paid side เท่านั้น)
  badDebt: number;     // หนี้เสีย — ยอดขายเครื่อง (paid side เท่านั้น)
  total: number;       // ยอดรวม
};

/** แถวสรุปต่อ (เดือน × bucket) */
export type MonthlySummaryCell = {
  contractCount: number;
  paid: MoneyBreakdown;
  due: MoneyBreakdown;
};

/** แถวสรุปต่อเดือน */
export type MonthlySummaryRow = {
  approveMonth: string; // YYYY-MM
  buckets: Record<string, MonthlySummaryCell>;
  totalCount: number;
  totalPaid: MoneyBreakdown;
  totalDue: MoneyBreakdown;
};

/** Filter params แยกตาม tab */
export type MonthlySummaryParams = {
  section: SectionKey;

  // --- แถบจำนวนสัญญา ---
  countProductType?: string;

  // --- แถบยอดชำระแล้ว ---
  /** วันที่รับชำระ from (YYYY-MM-DD) */
  paidAtFrom?: string;
  /** วันที่รับชำระ to (YYYY-MM-DD) */
  paidAtTo?: string;
  /** เดือน-ปีที่ชำระ (YYYY-MM) — ถ้าระบุจะ override paidAtFrom/paidAtTo */
  paidAtMonth?: string;
  paidProductType?: string;

  // --- แถบยอดค้างชำระ ---
  /** วันที่ต้องชำระ from (YYYY-MM-DD) */
  dueAtFrom?: string;
  /** วันที่ต้องชำระ to (YYYY-MM-DD) */
  dueAtTo?: string;
  /** เดือน-ปีที่ต้องชำระ (YYYY-MM) — ถ้าระบุจะ override dueAtFrom/dueAtTo */
  dueAtMonth?: string;
  dueProductType?: string;
};

// ---------------------------------------------------------------------------
// Bucket helpers (เหมือน debtDb.ts)
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

const SUSPEND_CODES = ["SUSPEND", "TERMINATE", "CANCEL", "BADDEBT"];

function bucketFromDays(days: number): DebtBucket {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

function emptyMoney(): MoneyBreakdown {
  return { principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0, discount: 0, overpaid: 0, badDebt: 0, total: 0 };
}

function emptyCell(): MonthlySummaryCell {
  return { contractCount: 0, paid: emptyMoney(), due: emptyMoney() };
}

function addMoney(a: MoneyBreakdown, b: MoneyBreakdown): MoneyBreakdown {
  return {
    principal: a.principal + b.principal,
    interest:  a.interest  + b.interest,
    fee:       a.fee       + b.fee,
    penalty:   a.penalty   + b.penalty,
    unlockFee: a.unlockFee + b.unlockFee,
    discount:  a.discount  + b.discount,
    overpaid:  a.overpaid  + b.overpaid,
    badDebt:   a.badDebt   + b.badDebt,
    total:     a.total     + b.total,
  };
}

// ---------------------------------------------------------------------------
// Helper: load contracts for a given section + optional productType filter
// ---------------------------------------------------------------------------
async function loadContracts(
  section: SectionKey,
  productType?: string,
) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [
    sql`${contracts.section} = ${section}`,
    sql`${contracts.approveDate} IS NOT NULL`,
  ];
  if (productType) {
    conditions.push(sql`${contracts.productType} = ${productType}`);
  }
  const where = conditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`));

  const raw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           DATE_FORMAT(approve_date,'%Y-%m') AS approve_month,
           status,
           product_type,
           suspended_from_period,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           installment_count,
           CAST(installment_amount AS DECIMAL(18,2)) AS installment_amount
      FROM ${contracts}
     WHERE ${where}
     ORDER BY approve_date
  `);
  return ((raw as any)[0] ?? raw) as Array<{
    external_id: string;
    contract_no: string | null;
    approve_month: string | null;
    status: string | null;
    product_type: string | null;
    suspended_from_period: number | null;
    bad_debt_amount: number | null;
    bad_debt_date: string | null;
    finance_amount: number | null;
    installment_count: number | null;
    installment_amount: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helper: load installments for contract IDs + optional due-date filter
// ---------------------------------------------------------------------------
async function loadInstallments(
  section: SectionKey,
  contractIds: string[],
  dueAtFrom?: string,
  dueAtTo?: string,
  dueAtMonth?: string,
) {
  if (contractIds.length === 0) return [];
  const db = await getDb();
  if (!db) return [];

  // Resolve effective date range
  let effectiveDueFrom = dueAtFrom;
  let effectiveDueTo   = dueAtTo;
  if (dueAtMonth) {
    // YYYY-MM → first/last day of month
    effectiveDueFrom = `${dueAtMonth}-01`;
    const [y, m] = dueAtMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    effectiveDueTo = `${dueAtMonth}-${String(lastDay).padStart(2, "0")}`;
  }

  const conditions = [
    sql`${installments.section} = ${section}`,
    sql`${installments.contractExternalId} IN (${sql.join(contractIds.map((id) => sql`${id}`), sql`, `)})`,
  ];
  if (effectiveDueFrom) {
    conditions.push(sql`DATE(${installments.dueDate}) >= ${effectiveDueFrom}`);
  }
  if (effectiveDueTo) {
    conditions.push(sql`DATE(${installments.dueDate}) <= ${effectiveDueTo}`);
  }
  const where = conditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`));

  const raw = await db.execute(sql`
    SELECT contract_external_id,
           period,
           due_date,
           CAST(amount AS DECIMAL(18,2))       AS amount,
           CAST(paid_amount AS DECIMAL(18,2))  AS paid_amount,
           status AS inst_status,
           CAST(JSON_EXTRACT(raw_json, '$.principal_due')  AS DECIMAL(18,2)) AS principal_due,
           CAST(JSON_EXTRACT(raw_json, '$.interest_due')   AS DECIMAL(18,2)) AS interest_due,
           CAST(JSON_EXTRACT(raw_json, '$.fee_due')        AS DECIMAL(18,2)) AS fee_due,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_due')    AS DECIMAL(18,2)) AS penalty_due,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_due') AS DECIMAL(18,2)) AS unlock_fee_due,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS installment_status_code
      FROM ${installments}
     WHERE ${where}
     ORDER BY contract_external_id, period
  `);
  return ((raw as any)[0] ?? raw) as Array<{
    contract_external_id: string;
    period: number | null;
    due_date: string | null;
    amount: number | null;
    paid_amount: number | null;
    inst_status: string | null;
    principal_due: number | null;
    interest_due: number | null;
    fee_due: number | null;
    penalty_due: number | null;
    unlock_fee_due: number | null;
    installment_status_code: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helper: load payments for contract IDs + optional paid-at filter
// ---------------------------------------------------------------------------
async function loadPayments(
  section: SectionKey,
  contractIds: string[],
  paidAtFrom?: string,
  paidAtTo?: string,
  paidAtMonth?: string,
) {
  if (contractIds.length === 0) return [];
  const db = await getDb();
  if (!db) return [];

  // Resolve effective date range
  let effectivePaidFrom = paidAtFrom;
  let effectivePaidTo   = paidAtTo;
  if (paidAtMonth) {
    effectivePaidFrom = `${paidAtMonth}-01`;
    const [y, m] = paidAtMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    effectivePaidTo = `${paidAtMonth}-${String(lastDay).padStart(2, "0")}`;
  }

  const conditions = [
    sql`${paymentTransactions.section} = ${section}`,
    sql`${paymentTransactions.contractExternalId} IN (${sql.join(contractIds.map((id) => sql`${id}`), sql`, `)})`,
  ];
  if (effectivePaidFrom) {
    conditions.push(sql`DATE(${paymentTransactions.paidAt}) >= ${effectivePaidFrom}`);
  }
  if (effectivePaidTo) {
    conditions.push(sql`DATE(${paymentTransactions.paidAt}) <= ${effectivePaidTo}`);
  }
  const where = conditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`));

  const raw = await db.execute(sql`
    SELECT contract_external_id,
           paid_at,
           CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.principal_paid')    AS DECIMAL(18,2)) AS principal_paid,
           CAST(JSON_EXTRACT(raw_json, '$.interest_paid')     AS DECIMAL(18,2)) AS interest_paid,
           CAST(JSON_EXTRACT(raw_json, '$.fee_paid')          AS DECIMAL(18,2)) AS fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_paid')      AS DECIMAL(18,2)) AS penalty_paid,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')   AS DECIMAL(18,2)) AS unlock_fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.discount_amount')   AS DECIMAL(18,2)) AS discount_amount,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')   AS DECIMAL(18,2)) AS overpaid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')   AS DECIMAL(18,2)) AS bad_debt_amount
      FROM ${paymentTransactions}
     WHERE ${where}
     ORDER BY contract_external_id, paid_at
  `);
  return ((raw as any)[0] ?? raw) as Array<{
    contract_external_id: string;
    paid_at: string | null;
    total_paid_amount: number | null;
    principal_paid: number | null;
    interest_paid: number | null;
    fee_paid: number | null;
    penalty_paid: number | null;
    unlock_fee_paid: number | null;
    discount_amount: number | null;
    overpaid_amount: number | null;
    bad_debt_amount: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helper: derive debt_status bucket per contract
// ---------------------------------------------------------------------------
function deriveContractBucket(
  c: { external_id: string; status: string | null },
  instByContract: Map<string, Array<{ due_date: string | null; amount: number | null; paid_amount: number | null }>>,
  today: Date,
): DebtBucket {
  const contractStatus = c.status ?? "";
  if (contractStatus === "หนี้เสีย") return "หนี้เสีย";
  if (contractStatus === "ระงับสัญญา") return "ระงับสัญญา";
  if (contractStatus === "สิ้นสุดสัญญา") return "สิ้นสุดสัญญา";
  if (contractStatus === "ยกเลิกสัญญา") return "หนี้เสีย";

  const insts = instByContract.get(c.external_id) ?? [];
  let maxDays = 0;
  for (const inst of insts) {
    if (!inst.due_date) continue;
    const paidAmt = Number(inst.paid_amount ?? 0);
    const dueAmt  = Number(inst.amount ?? 0);
    if (paidAmt >= dueAmt && dueAmt > 0) continue;
    const due = new Date(inst.due_date);
    if (due > today) continue;
    const days = Math.floor((today.getTime() - due.getTime()) / 86400000);
    if (days > maxDays) maxDays = days;
  }
  return bucketFromDays(maxDays);
}

// ---------------------------------------------------------------------------
// Helper: aggregate month×bucket grid from contracts + data maps
// ---------------------------------------------------------------------------
function buildGrid(
  cRows: Array<{ external_id: string; approve_month: string | null; status: string | null }>,
  instByContract: Map<string, Array<{ due_date: string | null; amount: number | null; paid_amount: number | null; principal_due: number | null; interest_due: number | null; fee_due: number | null; penalty_due: number | null; unlock_fee_due: number | null; installment_status_code: string | null }>>,
  payByContract: Map<string, Array<{ total_paid_amount: number | null; principal_paid: number | null; interest_paid: number | null; fee_paid: number | null; penalty_paid: number | null; unlock_fee_paid: number | null; discount_amount: number | null; overpaid_amount: number | null; bad_debt_amount: number | null }>>,
  today: Date,
  computePaidFn: (contractId: string) => MoneyBreakdown,
  computeDueFn: (contractId: string, status: string | null) => MoneyBreakdown,
): MonthlySummaryRow[] {
  const monthMap = new Map<string, Map<string, MonthlySummaryCell>>();

  for (const c of cRows) {
    const month = c.approve_month;
    if (!month) continue;

    const bucket = deriveContractBucket(c, instByContract, today);
    const paid   = computePaidFn(c.external_id);
    const due    = computeDueFn(c.external_id, c.status);

    if (!monthMap.has(month)) monthMap.set(month, new Map());
    const bucketMap = monthMap.get(month)!;
    if (!bucketMap.has(bucket)) bucketMap.set(bucket, emptyCell());
    const cell = bucketMap.get(bucket)!;

    cell.contractCount += 1;
    cell.paid = addMoney(cell.paid, paid);
    cell.due  = addMoney(cell.due, due);
  }

  const rows: MonthlySummaryRow[] = [];
  const sortedMonths = Array.from(monthMap.keys()).sort((a, b) => b.localeCompare(a));

  for (const month of sortedMonths) {
    const bucketMap = monthMap.get(month)!;
    const bucketsObj: Record<string, MonthlySummaryCell> = {};
    let totalCount = 0;
    let totalPaid = emptyMoney();
    let totalDue  = emptyMoney();

    for (const bucket of DEBT_BUCKETS) {
      const cell = bucketMap.get(bucket) ?? emptyCell();
      bucketsObj[bucket] = cell;
      totalCount += cell.contractCount;
      totalPaid = addMoney(totalPaid, cell.paid);
      totalDue  = addMoney(totalDue, cell.due);
    }

    rows.push({ approveMonth: month, buckets: bucketsObj, totalCount, totalPaid, totalDue });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Main export: getMonthlySummary
// ---------------------------------------------------------------------------

export async function getMonthlySummary(params: MonthlySummaryParams): Promise<{
  countRows: MonthlySummaryRow[];
  paidRows: MonthlySummaryRow[];
  dueRows: MonthlySummaryRow[];
  productTypes: string[];
}> {
  const today = new Date();

  // -----------------------------------------------------------------------
  // Load 3 sets of contracts (each with its own productType filter)
  // -----------------------------------------------------------------------
  const [countContracts, paidContracts, dueContracts] = await Promise.all([
    loadContracts(params.section, params.countProductType),
    loadContracts(params.section, params.paidProductType),
    loadContracts(params.section, params.dueProductType),
  ]);

  // Collect all unique contract IDs across all tabs (for installment loading)
  const allContractIds = Array.from(
    new Set([
      ...countContracts.map((c) => c.external_id),
      ...paidContracts.map((c) => c.external_id),
      ...dueContracts.map((c) => c.external_id),
    ])
  );

  if (allContractIds.length === 0) {
    return { countRows: [], paidRows: [], dueRows: [], productTypes: [] };
  }

  // -----------------------------------------------------------------------
  // Load installments (for bucket derivation — no date filter needed for bucket)
  // and filtered installments for due tab
  // -----------------------------------------------------------------------
  const [allInstallments, dueInstallments, paidPayments] = await Promise.all([
    // All installments for bucket derivation (no date filter)
    loadInstallments(params.section, allContractIds),
    // Filtered installments for due tab
    loadInstallments(
      params.section,
      dueContracts.map((c) => c.external_id),
      params.dueAtFrom,
      params.dueAtTo,
      params.dueAtMonth,
    ),
    // Filtered payments for paid tab
    loadPayments(
      params.section,
      paidContracts.map((c) => c.external_id),
      params.paidAtFrom,
      params.paidAtTo,
      params.paidAtMonth,
    ),
  ]);

  // -----------------------------------------------------------------------
  // Build lookup maps
  // -----------------------------------------------------------------------
  // All installments map (for bucket derivation — used by all 3 tabs)
  const allInstByContract = new Map<string, typeof allInstallments>();
  for (const inst of allInstallments) {
    const key = String(inst.contract_external_id);
    const arr = allInstByContract.get(key) ?? [];
    arr.push(inst);
    allInstByContract.set(key, arr);
  }

  // Filtered installments map (for due tab)
  const dueInstByContract = new Map<string, typeof dueInstallments>();
  for (const inst of dueInstallments) {
    const key = String(inst.contract_external_id);
    const arr = dueInstByContract.get(key) ?? [];
    arr.push(inst);
    dueInstByContract.set(key, arr);
  }

  // Filtered payments map (for paid tab)
  const payByContract = new Map<string, typeof paidPayments>();
  for (const pay of paidPayments) {
    const key = String(pay.contract_external_id);
    const arr = payByContract.get(key) ?? [];
    arr.push(pay);
    payByContract.set(key, arr);
  }

  // -----------------------------------------------------------------------
  // Compute functions
  // -----------------------------------------------------------------------
  function computePaid(contractId: string): MoneyBreakdown {
    const pays = payByContract.get(contractId) ?? [];
    const result = emptyMoney();
    for (const p of pays) {
      result.principal += Number(p.principal_paid  ?? 0);
      result.interest  += Number(p.interest_paid   ?? 0);
      result.fee       += Number(p.fee_paid        ?? 0);
      result.penalty   += Number(p.penalty_paid    ?? 0);
      result.unlockFee += Number(p.unlock_fee_paid ?? 0);
      result.discount  += Number(p.discount_amount ?? 0);
      result.overpaid  += Number(p.overpaid_amount ?? 0);
      result.badDebt   += Number(p.bad_debt_amount ?? 0);
      result.total     += Number(p.total_paid_amount ?? 0);
    }
    return result;
  }

  function computeDue(contractId: string, contractStatus: string | null): MoneyBreakdown {
    const insts = dueInstByContract.get(contractId) ?? [];
    const status = contractStatus ?? "";
    const isSpecial = ["หนี้เสีย", "ระงับสัญญา", "ยกเลิกสัญญา", "สิ้นสุดสัญญา"].includes(status);

    const result = emptyMoney();
    for (const inst of insts) {
      if (!inst.due_date) continue;
      // When due-date filter is active, we trust the filtered set
      // Still skip future installments when no filter is set
      if (!params.dueAtFrom && !params.dueAtTo && !params.dueAtMonth) {
        const due = new Date(inst.due_date);
        if (due > today) continue;
      }

      const paidAmt = Number(inst.paid_amount ?? 0);
      const dueAmt  = Number(inst.amount ?? 0);
      if (paidAmt >= dueAmt && dueAmt > 0) continue;

      if (isSpecial) {
        const suspendCode = inst.installment_status_code ?? "";
        if (SUSPEND_CODES.includes(suspendCode)) continue;
      }

      result.principal += Number(inst.principal_due ?? 0);
      result.interest  += Number(inst.interest_due  ?? 0);
      result.fee       += Number(inst.fee_due       ?? 0);
      result.penalty   += Number(inst.penalty_due   ?? 0);
      result.unlockFee += Number(inst.unlock_fee_due ?? 0);
    }
    result.total = result.principal + result.interest + result.fee + result.penalty + result.unlockFee;
    return result;
  }

  // For count tab: no paid/due data needed (zeros)
  const zeroPaid = (_: string) => emptyMoney();
  const zeroDue  = (_: string, __: string | null) => emptyMoney();

  // -----------------------------------------------------------------------
  // Build 3 grids
  // -----------------------------------------------------------------------
  const countRows = buildGrid(countContracts, allInstByContract, new Map(), today, zeroPaid, zeroDue);
  const paidRows  = buildGrid(paidContracts,  allInstByContract, payByContract, today, computePaid, zeroDue);
  const dueRows   = buildGrid(dueContracts,   allInstByContract, new Map(), today, zeroPaid, computeDue);

  // -----------------------------------------------------------------------
  // Collect distinct product types (union of all 3 sets)
  // -----------------------------------------------------------------------
  const productTypeSet = new Set<string>();
  for (const c of [...countContracts, ...paidContracts, ...dueContracts]) {
    if (c.product_type) productTypeSet.add(c.product_type);
  }
  const productTypes = Array.from(productTypeSet).sort();

  return { countRows, paidRows, dueRows, productTypes };
}

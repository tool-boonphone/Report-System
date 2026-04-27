/**
 * Monthly Summary DB helpers.
 *
 * หน้าสรุปรายเดือน: group by เดือนที่อนุมัติสัญญา (approve_date) + debt_status bucket
 *
 * 3 แถบ (tab):
 *   1. จำนวนสัญญา    — นับ contract ต่อ bucket ต่อเดือน
 *   2. ยอดที่ชำระแล้ว — SUM payment fields (principal/interest/fee/penalty/unlock/discount/overpaid/badDebt)
 *   3. ยอดที่ค้างชำระ  — SUM installment due fields ที่ยังไม่ชำระ
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
  unlockFee: number;   // ค่าปลดล็อก
  discount: number;    // ส่วนลด
  overpaid: number;    // ชำระเกิน
  badDebt: number;     // หนี้เสีย (ยอดขายเครื่อง)
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

/** Filter params */
export type MonthlySummaryParams = {
  section: SectionKey;
  /** กรองตามวันที่รับชำระ (paid_at) YYYY-MM-DD */
  paidAtFrom?: string;
  paidAtTo?: string;
  productType?: string;
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
// Main query
// ---------------------------------------------------------------------------

export async function getMonthlySummary(params: MonthlySummaryParams): Promise<{
  rows: MonthlySummaryRow[];
  productTypes: string[];
}> {
  const db = await getDb();
  if (!db) return { rows: [], productTypes: [] };

  const today = new Date();

  // -----------------------------------------------------------------------
  // Step 1: Load contracts (filtered)
  // -----------------------------------------------------------------------
  // Build WHERE conditions using Drizzle sql template (safe parameterized)
  const contractConditions = [
    sql`${contracts.section} = ${params.section}`,
    sql`${contracts.approveDate} IS NOT NULL`,
  ];
  if (params.productType) {
    contractConditions.push(sql`${contracts.productType} = ${params.productType}`);
  }

  // Combine conditions with AND
  const contractWhere = contractConditions.reduce(
    (acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`)
  );

  const contractRowsRaw = await db.execute(sql`
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
     WHERE ${contractWhere}
     ORDER BY approve_date
  `);
  const cRows: Array<{
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
  }> = (contractRowsRaw as any)[0] ?? contractRowsRaw;

  if (cRows.length === 0) return { rows: [], productTypes: [] };

  const contractIds = cRows.map((c) => c.external_id);

  // -----------------------------------------------------------------------
  // Step 2: Load installments for these contracts
  // -----------------------------------------------------------------------
  const instConditions = [
    sql`${installments.section} = ${params.section}`,
    sql`${installments.contractExternalId} IN (${sql.join(contractIds.map((id) => sql`${id}`), sql`, `)})`,
  ];
  const instWhere = instConditions.reduce(
    (acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`)
  );

  const instRowsRaw = await db.execute(sql`
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
     WHERE ${instWhere}
     ORDER BY contract_external_id, period
  `);
  const iRows: Array<{
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
  }> = (instRowsRaw as any)[0] ?? instRowsRaw;

  // -----------------------------------------------------------------------
  // Step 3: Load payments for these contracts (filtered by paid_at range)
  // -----------------------------------------------------------------------
  // Build payment WHERE
  const payConditions = [
    sql`${paymentTransactions.section} = ${params.section}`,
    sql`${paymentTransactions.contractExternalId} IN (${sql.join(contractIds.map((id) => sql`${id}`), sql`, `)})`,
  ];
  if (params.paidAtFrom) {
    payConditions.push(sql`${paymentTransactions.paidAt} >= ${params.paidAtFrom}`);
  }
  if (params.paidAtTo) {
    payConditions.push(sql`${paymentTransactions.paidAt} <= ${params.paidAtTo + " 23:59:59"}`);
  }
  const payWhere = payConditions.reduce(
    (acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`)
  );

  const payRowsRaw = await db.execute(sql`
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
     WHERE ${payWhere}
     ORDER BY contract_external_id, paid_at
  `);
  const pRows: Array<{
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
  }> = (payRowsRaw as any)[0] ?? payRowsRaw;

  // -----------------------------------------------------------------------
  // Step 4: Build lookup maps
  // -----------------------------------------------------------------------
  const instByContract = new Map<string, typeof iRows>();
  for (const inst of iRows) {
    const key = String(inst.contract_external_id);
    const arr = instByContract.get(key) ?? [];
    arr.push(inst);
    instByContract.set(key, arr);
  }

  const payByContract = new Map<string, typeof pRows>();
  for (const pay of pRows) {
    const key = String(pay.contract_external_id);
    const arr = payByContract.get(key) ?? [];
    arr.push(pay);
    payByContract.set(key, arr);
  }

  // -----------------------------------------------------------------------
  // Step 5: Compute debt_status bucket per contract
  // -----------------------------------------------------------------------
  const SUSPEND_CODES = ["ระงับสัญญา", "หนี้เสีย", "ยกเลิกสัญญา"];

  function deriveContractBucket(c: typeof cRows[0]): DebtBucket {
    const contractStatus = c.status ?? "";
    if (contractStatus === "หนี้เสีย") return "หนี้เสีย";
    if (contractStatus === "ระงับสัญญา") return "ระงับสัญญา";
    if (contractStatus === "สิ้นสุดสัญญา") return "สิ้นสุดสัญญา";
    if (contractStatus === "ยกเลิกสัญญา") return "หนี้เสีย";

    // Normal: find worst unpaid overdue installment
    const insts = instByContract.get(c.external_id) ?? [];
    let maxDays = 0;
    for (const inst of insts) {
      if (!inst.due_date) continue;
      const paidAmt = Number(inst.paid_amount ?? 0);
      const dueAmt  = Number(inst.amount ?? 0);
      if (paidAmt >= dueAmt && dueAmt > 0) continue; // fully paid
      const due = new Date(inst.due_date);
      if (due > today) continue; // future installment
      const days = Math.floor((today.getTime() - due.getTime()) / 86400000);
      if (days > maxDays) maxDays = days;
    }
    return bucketFromDays(maxDays);
  }

  // -----------------------------------------------------------------------
  // Step 6: Compute due amounts per contract
  // -----------------------------------------------------------------------
  function computeDue(c: typeof cRows[0]): MoneyBreakdown {
    const insts = instByContract.get(c.external_id) ?? [];
    const contractStatus = c.status ?? "";
    const isSpecial = ["หนี้เสีย", "ระงับสัญญา", "ยกเลิกสัญญา", "สิ้นสุดสัญญา"].includes(contractStatus);

    const result = emptyMoney();
    for (const inst of insts) {
      if (!inst.due_date) continue;
      const due = new Date(inst.due_date);
      if (due > today) continue; // future — not yet due

      const paidAmt = Number(inst.paid_amount ?? 0);
      const dueAmt  = Number(inst.amount ?? 0);
      if (paidAmt >= dueAmt && dueAmt > 0) continue; // fully paid

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

  // -----------------------------------------------------------------------
  // Step 7: Compute paid amounts per contract
  // -----------------------------------------------------------------------
  function computePaid(c: typeof cRows[0]): MoneyBreakdown {
    const pays = payByContract.get(c.external_id) ?? [];
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

  // -----------------------------------------------------------------------
  // Step 8: Aggregate into month × bucket grid
  // -----------------------------------------------------------------------
  const monthMap = new Map<string, Map<string, MonthlySummaryCell>>();

  for (const c of cRows) {
    const month = c.approve_month;
    if (!month) continue;

    const bucket = deriveContractBucket(c);
    const paid   = computePaid(c);
    const due    = computeDue(c);

    if (!monthMap.has(month)) monthMap.set(month, new Map());
    const bucketMap = monthMap.get(month)!;
    if (!bucketMap.has(bucket)) bucketMap.set(bucket, emptyCell());
    const cell = bucketMap.get(bucket)!;

    cell.contractCount += 1;
    cell.paid = addMoney(cell.paid, paid);
    cell.due  = addMoney(cell.due, due);
  }

  // -----------------------------------------------------------------------
  // Step 9: Build final rows (sorted by month desc)
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // Step 10: Collect distinct product types for filter dropdown
  // -----------------------------------------------------------------------
  const productTypeSet = new Set<string>();
  for (const c of cRows) {
    if (c.product_type) productTypeSet.add(c.product_type);
  }
  const productTypes = Array.from(productTypeSet).sort();

  return { rows, productTypes };
}

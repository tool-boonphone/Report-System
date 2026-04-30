/**
 * populateCache.ts — Populate Engine for debt_target_cache & debt_collected_cache
 *
 * Strategy:
 *   1. Query contracts + installments + payment_transactions directly from DB
 *      (same source-of-truth as listDebtTarget / listDebtCollected in debtDb.ts)
 *   2. Re-use the same business logic (deriveDebtStatus, bucketFromDays, isClosed, isSuspended, etc.)
 *   3. Upsert rows into debt_target_cache (1 row per installment period per contract)
 *      and debt_collected_cache (1 row per payment transaction)
 *   4. Called from doSync() in runner.ts after bad_debt stage
 *
 * NOTE: This file intentionally duplicates some logic from debtDb.ts to avoid
 * circular imports and keep the cache population self-contained.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { debtTargetCache, debtCollectedCache } from "../../drizzle/schema";
import type { SectionKey } from "../../shared/const";

// ─── Helpers (mirrors debtDb.ts) ─────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["ระงับสัญญา", "สิ้นสุดสัญญา", "หนี้เสีย"]);

function bucketFromDays(days: number): string {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

function deriveDebtStatus(
  contractStatus: string | null,
  installments: Array<{ due_date: string | null; amount: number | null; paid_amount: number | null; balance: number | null }>,
  today: Date,
): { label: string; daysOverdue: number } {
  if (contractStatus && TERMINAL_STATUSES.has(contractStatus)) {
    return { label: contractStatus, daysOverdue: 0 };
  }
  let maxDays = 0;
  for (const it of installments) {
    if (!it.due_date) continue;
    const dueMs = Date.parse(`${it.due_date}T00:00:00`);
    if (Number.isNaN(dueMs)) continue;
    const paid = Number(it.paid_amount ?? 0);
    const amt = Number(it.amount ?? 0);
    if (amt <= 0.001) continue;
    if (paid >= amt - 0.001) continue;
    const outstanding = (it.balance !== null && it.balance !== undefined)
      ? Number(it.balance)
      : amt - paid;
    if (outstanding <= 0.001) continue;
    const days = Math.floor((today.getTime() - dueMs) / (1000 * 60 * 60 * 24));
    if (days > maxDays) maxDays = days;
  }
  return { label: bucketFromDays(maxDays), daysOverdue: maxDays };
}

const SUSPEND_CODES = [
  "ระงับสัญญา",
  "ยกเลิกสัญญา",
  "หนี้เสีย",
  "suspend",
  "cancelled",
  "bad_debt",
];

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Populate debt_target_cache and debt_collected_cache for a given section.
 * Deletes existing rows for the section first, then inserts fresh data.
 *
 * @returns { targetRows, collectedRows } — number of rows inserted into each cache
 */
export async function populateDebtCache(
  section: SectionKey,
): Promise<{ targetRows: number; collectedRows: number }> {
  const db = await getDb();
  if (!db) throw new Error("[populateCache] DB not available");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ─── 1. Load contracts ────────────────────────────────────────────────────
  const contractsRaw = await db.execute(sql`
    SELECT
      external_id,
      contract_no,
      approve_date,
      customer_name,
      phone,
      status,
      product_type,
      partner_code,
      partner_name,
      device,
      model,
      CAST(finance_amount AS DECIMAL(18,2))   AS finance_amount,
      installment_count,
      CAST(bad_debt_amount AS DECIMAL(18,2))  AS bad_debt_amount,
      bad_debt_date,
      bad_debt_updated_by,
      bad_debt_updated_at
    FROM contracts
    WHERE section = ${section}
  `);
  const cRows: any[] = (contractsRaw as any)[0] ?? contractsRaw;

  // ─── 2. Load installments ─────────────────────────────────────────────────
  const instRaw = await db.execute(sql`
    SELECT
      contract_external_id,
      external_id,
      period,
      due_date,
      CAST(amount AS DECIMAL(18,2))                                                 AS amount,
      CAST(paid_amount AS DECIMAL(18,2))                                            AS paid_amount,
      status                                                                         AS inst_status,
      CAST(JSON_EXTRACT(raw_json, '$.principal_due')  AS DECIMAL(18,2))            AS principal_due,
      CAST(JSON_EXTRACT(raw_json, '$.interest_due')   AS DECIMAL(18,2))            AS interest_due,
      CAST(JSON_EXTRACT(raw_json, '$.fee_due')        AS DECIMAL(18,2))            AS fee_due,
      CAST(COALESCE(JSON_EXTRACT(raw_json, '$.penalty_due'), JSON_EXTRACT(raw_json, '$.mulct'), 0) AS DECIMAL(18,2)) AS penalty_due,
      CAST(COALESCE(JSON_EXTRACT(raw_json, '$.unlock_fee_due'), 0) AS DECIMAL(18,2)) AS unlock_fee_due,
      JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code'))             AS installment_status_code,
      CAST(JSON_EXTRACT(raw_json, '$.balance') AS DECIMAL(18,2))                   AS balance
    FROM installments
    WHERE section = ${section}
    ORDER BY contract_external_id, period
  `);
  const iRows: any[] = (instRaw as any)[0] ?? instRaw;

  // Group installments by contract
  const instByContract = new Map<string, any[]>();
  for (const r of iRows) {
    const key = String(r.contract_external_id);
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key)!.push(r);
  }

  // ─── 3. Load payment_transactions ─────────────────────────────────────────
  const payRaw = await db.execute(sql`
    SELECT
      contract_external_id,
      external_id                                                                    AS payment_external_id,
      paid_at,
      CAST(amount AS DECIMAL(18,2))                                                 AS total_paid_amount,
      CAST(JSON_EXTRACT(raw_json, '$.principal_paid')           AS DECIMAL(18,2))  AS principal_paid,
      CAST(JSON_EXTRACT(raw_json, '$.interest_paid')            AS DECIMAL(18,2))  AS interest_paid,
      CAST(JSON_EXTRACT(raw_json, '$.fee_paid')                 AS DECIMAL(18,2))  AS fee_paid,
      CAST(JSON_EXTRACT(raw_json, '$.penalty_paid')             AS DECIMAL(18,2))  AS penalty_paid,
      CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')          AS DECIMAL(18,2))  AS unlock_fee_paid,
      CAST(JSON_EXTRACT(raw_json, '$.discount_amount')          AS DECIMAL(18,2))  AS discount_amount,
      CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')          AS DECIMAL(18,2))  AS overpaid_amount,
      CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')          AS DECIMAL(18,2))  AS bad_debt_amount,
      JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no'))                         AS receipt_no,
      period,
      JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.updated_at'))                         AS updated_at,
      JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.updated_by'))                         AS updated_by
    FROM payment_transactions
    WHERE section = ${section}
    ORDER BY contract_external_id, paid_at
  `);
  const pRows: any[] = (payRaw as any)[0] ?? payRaw;

  // Group payments by contract
  const payByContract = new Map<string, any[]>();
  for (const r of pRows) {
    const key = String(r.contract_external_id);
    if (!payByContract.has(key)) payByContract.set(key, []);
    payByContract.get(key)!.push(r);
  }

  // ─── 4. Detect TXRTC close contracts (mirrors debtDb.ts closedByContract) ─
  const closedByContract = new Set<string>();
  const maxClosedPeriodByContract = new Map<string, number>();
  for (const r of pRows) {
    const receiptNo = (r.receipt_no ?? "") as string;
    if (!receiptNo.startsWith("TXRTC")) continue;
    const extId = String(r.contract_external_id);
    closedByContract.add(extId);
    const period = r.period != null ? Number(r.period) : 0;
    const prev = maxClosedPeriodByContract.get(extId) ?? 0;
    if (period > prev) maxClosedPeriodByContract.set(extId, period);
  }

  // ─── 5. Build target cache rows ───────────────────────────────────────────
  const targetInserts: (typeof debtTargetCache.$inferInsert)[] = [];

  for (const c of cRows) {
    const extId = String(c.external_id);
    const contractStatus = c.status ?? null;
    const isContractBadDebt = contractStatus === "หนี้เสีย";
    const isContractSuspended = contractStatus === "ระงับสัญญา";

    const insts = instByContract.get(extId) ?? [];
    const payments = payByContract.get(extId) ?? [];

    // Derive debt status + debtRange for the contract
    const { label: debtStatusLabel, daysOverdue } = deriveDebtStatus(
      contractStatus,
      insts.map((r) => ({
        due_date: r.due_date ?? null,
        amount: r.amount != null ? Number(r.amount) : null,
        paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
        balance: r.balance != null ? Number(r.balance) : null,
      })),
      today,
    );
    const debtRange = bucketFromDays(daysOverdue);

    // Compute suspendedFromPeriod (mirrors debtDb.ts logic)
    let suspendedFromPeriod = 0;
    if (isContractSuspended || isContractBadDebt) {
      const badDebtDate = c.bad_debt_date ?? null;
      if (badDebtDate) {
        // Find the first installment with due_date >= bad_debt_date
        const sortedInsts = [...insts].sort((a, b) => (a.period ?? 0) - (b.period ?? 0));
        for (const inst of sortedInsts) {
          if (inst.due_date && inst.due_date >= badDebtDate) {
            suspendedFromPeriod = inst.period != null ? Number(inst.period) : 0;
            break;
          }
        }
        if (suspendedFromPeriod === 0 && sortedInsts.length > 0) {
          // Fallback: use last period
          const lastInst = sortedInsts[sortedInsts.length - 1];
          suspendedFromPeriod = lastInst.period != null ? Number(lastInst.period) : 0;
        }
      }
    }

    // Detect TXRTC close pattern for this contract
    const isClosed_contract = closedByContract.has(extId);
    const maxClosedPeriod = maxClosedPeriodByContract.get(extId) ?? 0;

    // Compute current period (highest past/current non-closed/non-suspended period)
    const todayMs = today.getTime();
    const instsSorted = [...insts].sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    // Find current period for isCurrentPeriod flag
    let currentPeriodNo: number | null = null;
    {
      const pastInsts = instsSorted.filter((inst) => {
        const instStatus = inst.inst_status ?? inst.installment_status_code ?? "";
        const isSusp = SUSPEND_CODES.includes(instStatus);
        const isCl = isClosed_contract
          && maxClosedPeriod !== -1
          && (inst.period ?? 0) > 1
          && (inst.period ?? 0) > maxClosedPeriod;
        if (isSusp || isCl) return false;
        if (!inst.due_date) return false;
        const dueMs = Date.parse(`${inst.due_date}T00:00:00`);
        return dueMs <= todayMs;
      });
      if (pastInsts.length > 0) {
        const latest = pastInsts.reduce((a, b) => (a.period ?? 0) >= (b.period ?? 0) ? a : b);
        currentPeriodNo = latest.period != null ? Number(latest.period) : null;
      }
    }

    // Per-installment rows
    for (const r of instsSorted) {
      const periodNo = r.period != null ? Number(r.period) : 0;
      const rawAmount = r.amount != null ? Number(r.amount) : 0;
      const rawPaid = r.paid_amount != null ? Number(r.paid_amount) : 0;
      const dueDate = r.due_date ?? null;

      // isFuturePeriod
      const isFuturePeriod = dueDate != null && Date.parse(`${dueDate}T00:00:00`) > todayMs;

      // isClosed / isSuspended
      let isClosed = false;
      let isSuspended = false;

      if (isContractBadDebt) {
        isSuspended = suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod;
      } else if (isContractSuspended) {
        const instStatusCode = r.installment_status_code ?? r.inst_status ?? "";
        const instStatusIsSuspend = SUSPEND_CODES.includes(instStatusCode);
        isSuspended = suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod &&
          (instStatusIsSuspend || rawPaid <= 0);
      } else {
        isClosed = isClosed_contract
          && maxClosedPeriod !== -1
          && periodNo > 1
          && periodNo > maxClosedPeriod;
      }

      // isPaid
      const isPaid = !isClosed && !isSuspended && (
        (rawAmount <= 0.009 && rawPaid > 0.009) ||
        (rawAmount > 0.009 && rawPaid >= rawAmount - 0.5)
      );

      // isPartialPaid
      const isPartialPaid = !isClosed && !isSuspended && !isPaid &&
        rawPaid > 0.009 && rawAmount > 0.009 && rawPaid < rawAmount - 0.5;

      // isArrears (only for past/current periods with penalty/unlockFee)
      const rawPenalty = r.penalty_due != null ? Number(r.penalty_due) : 0;
      const rawUnlockFee = r.unlock_fee_due != null ? Number(r.unlock_fee_due) : 0;
      const isPastOrCurrent = dueDate != null && Date.parse(`${dueDate}T00:00:00`) <= todayMs;
      const isArrears = isPastOrCurrent && (rawPenalty > 0.005 || rawUnlockFee > 0.005);

      // isCurrentPeriod
      const isCurrentPeriod = currentPeriodNo !== null && periodNo === currentPeriodNo;

      // isBadDebt: period is in bad-debt zone
      const isBadDebt = isContractBadDebt && isSuspended;

      // Compute display amounts
      const principal = r.principal_due != null ? Number(r.principal_due) : 0;
      const interest = r.interest_due != null ? Number(r.interest_due) : 0;
      const fee = r.fee_due != null ? Number(r.fee_due) : 0;
      const penalty = isFuturePeriod ? 0 : rawPenalty;
      const unlockFee = isFuturePeriod ? 0 : rawUnlockFee;
      const netAmount = principal + interest + fee;
      const totalAmount = rawAmount;
      const paidAmount = rawPaid;

      targetInserts.push({
        section,
        contractExternalId: extId,
        contractNo: c.contract_no ?? "",
        customerName: c.customer_name ?? null,
        approveDate: c.approve_date ?? null,
        contractStatus: contractStatus,
        partnerCode: c.partner_code ?? null,
        partnerName: c.partner_name ?? null,
        productType: c.product_type ?? null,
        device: c.device ?? null,
        model: c.model ?? null,
        financeAmount: c.finance_amount != null ? String(Number(c.finance_amount)) : null,
        installmentCount: c.installment_count != null ? Number(c.installment_count) : null,
        period: periodNo,
        dueDate: dueDate,
        principal: String(principal),
        interest: String(interest),
        fee: String(fee),
        penalty: String(penalty),
        unlockFee: String(unlockFee),
        netAmount: String(netAmount),
        totalAmount: String(totalAmount),
        paidAmount: String(paidAmount),
        overpaidApplied: "0",
        baselineAmount: "0",
        isPaid,
        isPartialPaid,
        isClosed,
        isSuspended,
        isCurrentPeriod,
        isFuturePeriod,
        isArrears,
        isBadDebt,
        debtRange,
      });
    }
  }

  // ─── 6. Build collected cache rows ────────────────────────────────────────
  const collectedInserts: (typeof debtCollectedCache.$inferInsert)[] = [];

  // Build contract lookup map
  const contractMap = new Map<string, any>();
  for (const c of cRows) {
    contractMap.set(String(c.external_id), c);
  }

  for (const p of pRows) {
    const extId = String(p.contract_external_id);
    const c = contractMap.get(extId);
    if (!c) continue;

    const payExtId = String(p.payment_external_id ?? "");
    if (!payExtId) continue;

    // Only include real payments (numeric external_id or TXRT receipt pattern)
    const isNumericPayExt = /^\d+$/.test(payExtId);
    const receiptNo = (p.receipt_no ?? "") as string;
    const isTXRTReceipt = /^TXRT[^C]/.test(receiptNo) || /^TXRT\d/.test(receiptNo);
    const isSynthetic = payExtId.startsWith("pay-");
    if (isSynthetic) continue;
    if (!isNumericPayExt && !isTXRTReceipt) continue;

    const isBadDebtRow = (p.bad_debt_amount != null && Number(p.bad_debt_amount) > 0);

    collectedInserts.push({
      section,
      contractExternalId: extId,
      contractNo: c.contract_no ?? "",
      customerName: c.customer_name ?? null,
      approveDate: c.approve_date ?? null,
      contractStatus: c.status ?? null,
      partnerCode: c.partner_code ?? null,
      partnerName: c.partner_name ?? null,
      productType: c.product_type ?? null,
      device: c.device ?? null,
      model: c.model ?? null,
      financeAmount: c.finance_amount != null ? String(Number(c.finance_amount)) : null,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : null,
      paymentExternalId: payExtId,
      period: p.period != null ? Number(p.period) : null,
      paidAt: p.paid_at ?? null,
      principal: String(p.principal_paid != null ? Number(p.principal_paid) : 0),
      interest: String(p.interest_paid != null ? Number(p.interest_paid) : 0),
      fee: String(p.fee_paid != null ? Number(p.fee_paid) : 0),
      penalty: String(p.penalty_paid != null ? Number(p.penalty_paid) : 0),
      unlockFee: String(p.unlock_fee_paid != null ? Number(p.unlock_fee_paid) : 0),
      discount: String(p.discount_amount != null ? Number(p.discount_amount) : 0),
      overpaid: String(p.overpaid_amount != null ? Number(p.overpaid_amount) : 0),
      badDebt: String(p.bad_debt_amount != null ? Number(p.bad_debt_amount) : 0),
      totalAmount: String(p.total_paid_amount != null ? Number(p.total_paid_amount) : 0),
      updatedBy: p.updated_by ?? null,
      isBadDebtRow,
    });
  }

  // ─── 7. Delete existing rows and insert fresh data ─────────────────────────
  // Delete existing rows for this section
  await db.execute(sql`DELETE FROM debt_target_cache WHERE section = ${section}`);
  await db.execute(sql`DELETE FROM debt_collected_cache WHERE section = ${section}`);

  // Batch insert (500 rows at a time to avoid packet size limits)
  const BATCH = 500;

  let targetCount = 0;
  for (let i = 0; i < targetInserts.length; i += BATCH) {
    const batch = targetInserts.slice(i, i + BATCH);
    if (batch.length > 0) {
      await db.insert(debtTargetCache).values(batch);
      targetCount += batch.length;
    }
  }

  let collectedCount = 0;
  for (let i = 0; i < collectedInserts.length; i += BATCH) {
    const batch = collectedInserts.slice(i, i + BATCH);
    if (batch.length > 0) {
      await db.insert(debtCollectedCache).values(batch);
      collectedCount += batch.length;
    }
  }

  console.log(
    `[populateCache] ${section}: inserted ${targetCount} target rows, ${collectedCount} collected rows`,
  );

  return { targetRows: targetCount, collectedRows: collectedCount };
}

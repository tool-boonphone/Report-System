/**
 * Debt report helpers.
 *
 * เป้าเก็บหนี้   : SUM(installments.amount)              GROUP BY month(due_date)
 * ยอดเก็บหนี้    : SUM(payment_transactions.amount)      GROUP BY month(paid_at)
 *
 * We compute per (section, month) and also return the running counts so the
 * UI can render a table + chart without additional queries.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  contracts,
  installments,
  paymentTransactions,
} from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

export type MonthlyRow = {
  month: string; // YYYY-MM
  target: number; // เป้าเก็บหนี้ (บาท)
  targetCount: number; // งวดที่ครบกำหนดในเดือนนี้
  collected: number; // ยอดเก็บหนี้ (บาท)
  collectedCount: number; // จำนวนธุรกรรมจ่ายในเดือนนี้
  gap: number; // target - collected (บาทที่ยังเก็บไม่ครบ)
  rate: number; // collected / target (0–1)
};

export type DebtSummary = {
  target: number;
  targetCount: number;
  collected: number;
  collectedCount: number;
  gap: number;
  rate: number;
};

/** Return { summary, monthly[] } for a section + date range. */
export async function getDebtReport(params: {
  section: SectionKey;
  /** YYYY-MM-DD inclusive */
  from: string;
  /** YYYY-MM-DD inclusive */
  to: string;
}): Promise<{ summary: DebtSummary; monthly: MonthlyRow[] }> {
  const db = await getDb();
  const empty: DebtSummary = {
    target: 0,
    targetCount: 0,
    collected: 0,
    collectedCount: 0,
    gap: 0,
    rate: 0,
  };
  if (!db) return { summary: empty, monthly: [] };

  // --- Target side (installments due in range) ---
  // MySQL SUBSTRING avoids per-row DATE parse overhead on our YYYY-MM-DD strings.
  // Note: only_full_group_by requires a deterministic grouping key. We
  // compute the month string once and GROUP BY the alias to avoid MySQL
  // complaining about the non-aggregated expression.
  const targetRowsRaw = await db.execute(sql`
    SELECT SUBSTRING(${installments.dueDate}, 1, 7) AS month,
           COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))), 0) AS target,
           COUNT(*) AS cnt
      FROM ${installments}
     WHERE ${installments.section} = ${params.section}
       AND ${installments.dueDate} >= ${params.from}
       AND ${installments.dueDate} <= ${params.to}
     GROUP BY month
  `);
  const targetRows: Array<{ month: string; target: unknown; cnt: unknown }> =
    (targetRowsRaw as any)[0] ?? (targetRowsRaw as any);

  // --- Collected side (payment transactions with paid_at in range) ---
  // Only count payments that are marked as paid/active — filters out
  // voided / refunded / pending transactions if the API ever adds them.
  const collectedRowsRaw = await db.execute(sql`
    SELECT SUBSTRING(${paymentTransactions.paidAt}, 1, 7) AS month,
           COALESCE(SUM(CAST(${paymentTransactions.amount} AS DECIMAL(18,2))), 0) AS collected,
           COUNT(*) AS cnt
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND ${paymentTransactions.paidAt} >= ${params.from}
       AND ${paymentTransactions.paidAt} <= ${`${params.to} 23:59:59`}
       AND (${paymentTransactions.status} IS NULL
            OR LOWER(${paymentTransactions.status}) IN ('active', 'paid', 'success', 'completed'))
     GROUP BY month
  `);
  const collectedRows: Array<{ month: string; collected: unknown; cnt: unknown }> =
    (collectedRowsRaw as any)[0] ?? (collectedRowsRaw as any);

  // --- Merge into a single month list ---
  const months = new Set<string>();
  const targetByMonth = new Map<string, { amount: number; count: number }>();
  const collectedByMonth = new Map<string, { amount: number; count: number }>();

  for (const r of targetRows) {
    if (!r.month) continue;
    months.add(r.month);
    targetByMonth.set(r.month, {
      amount: Number(r.target ?? 0),
      count: Number(r.cnt ?? 0),
    });
  }
  for (const r of collectedRows) {
    if (!r.month) continue;
    months.add(r.month);
    collectedByMonth.set(r.month, {
      amount: Number(r.collected ?? 0),
      count: Number(r.cnt ?? 0),
    });
  }

  const monthly: MonthlyRow[] = Array.from(months)
    .sort()
    .map((m) => {
      const t = targetByMonth.get(m) ?? { amount: 0, count: 0 };
      const c = collectedByMonth.get(m) ?? { amount: 0, count: 0 };
      const gap = t.amount - c.amount;
      const rate = t.amount > 0 ? c.amount / t.amount : 0;
      return {
        month: m,
        target: t.amount,
        targetCount: t.count,
        collected: c.amount,
        collectedCount: c.count,
        gap,
        rate,
      };
    });

  const summary: DebtSummary = monthly.reduce<DebtSummary>(
    (acc, r) => ({
      target: acc.target + r.target,
      targetCount: acc.targetCount + r.targetCount,
      collected: acc.collected + r.collected,
      collectedCount: acc.collectedCount + r.collectedCount,
      gap: acc.gap + r.gap,
      rate: 0,
    }),
    { ...empty },
  );
  summary.rate = summary.target > 0 ? summary.collected / summary.target : 0;

  return { summary, monthly };
}

/** Return a top-N list of contracts with the largest outstanding debt. */
export async function getOverdueTopList(params: {
  section: SectionKey;
  asOf: string; // YYYY-MM-DD
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const limit = params.limit ?? 20;

  // Outstanding = (installments due <= asOf .amount) - paid_amount (per row),
  // aggregated per contract.
  const rows = await db
    .select({
      contractExternalId: installments.contractExternalId,
      contractNo: installments.contractNo,
      dueAmount: sql<number>`COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))),0)`,
      paidAmount: sql<number>`COALESCE(SUM(CAST(${installments.paidAmount} AS DECIMAL(18,2))),0)`,
      overdueCount: sql<number>`COUNT(*)`,
    })
    .from(installments)
    .where(
      and(
        eq(installments.section, params.section),
        lte(installments.dueDate, params.asOf),
      ),
    )
    .groupBy(installments.contractExternalId, installments.contractNo)
    .having(
      sql`COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))),0) - COALESCE(SUM(CAST(${installments.paidAmount} AS DECIMAL(18,2))),0) > 0`,
    )
    .orderBy(
      sql`COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))),0) - COALESCE(SUM(CAST(${installments.paidAmount} AS DECIMAL(18,2))),0) DESC`,
    )
    .limit(limit);

  // Enrich with customer info for display.
  const externalIds = rows
    .map((r) => r.contractExternalId)
    .filter((x): x is string => !!x);
  const customerByExt = new Map<string, { name: string | null; phone: string | null }>();
  if (externalIds.length) {
    const cRows = await db
      .select({
        externalId: contracts.externalId,
        name: contracts.customerName,
        phone: contracts.phone,
      })
      .from(contracts)
      .where(
        and(
          eq(contracts.section, params.section),
          sql`${contracts.externalId} IN (${sql.join(
            externalIds.map((v) => sql`${v}`),
            sql`, `,
          )})`,
        ),
      );
    for (const r of cRows) {
      customerByExt.set(r.externalId, { name: r.name, phone: r.phone });
    }
  }

  return rows.map((r) => {
    const c = r.contractExternalId
      ? customerByExt.get(r.contractExternalId)
      : null;
    const outstanding = Number(r.dueAmount) - Number(r.paidAmount);
    return {
      contractExternalId: r.contractExternalId ?? null,
      contractNo: r.contractNo ?? null,
      customerName: c?.name ?? null,
      phone: c?.phone ?? null,
      dueAmount: Number(r.dueAmount),
      paidAmount: Number(r.paidAmount),
      outstanding,
      overdueCount: Number(r.overdueCount),
    };
  });
}

/* ============================================================================
 * Per-contract lists for the new two-tab debt report (target / collected).
 *
 * The UI mirrors boonphone.co.th/mm.html:
 *   - Each contract = 1 row (summary columns on the left)
 *   - Per-installment "groups" repeat horizontally (งวดที่ 1..N)
 *
 * Status label ("debt_status") is derived from the worst-overdue unpaid
 * installment of the contract as of today. If contract.status is a terminal
 * value (ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย), that wins.
 * ============================================================================ */

type ContractRowLite = {
  externalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  installmentCount: number | null;
  installmentAmount: number | null;
  contractStatus: string | null;
};

/**
 * Pure helper: derive the bad-debt date for a contract.
 *
 * Business rule (user, 2026-04-23):
 *   "วันที่รับยอดสุดท้ายตอนที่ยังเป็นระงับสัญญาอยู่นั่นแหละคือวันที่ถูกบันทึกว่าเป็นหนี้เสีย"
 *
 * Inputs:
 *   payments      — payments of the contract; each carries `paid_at`
 *   suspendedAt   — ISO date/datetime the contract became suspended
 *                   (first suspended installment's due_date)
 *
 * Rule:
 *   Pick the LATEST `paid_at` whose value is strictly greater than
 *   `suspendedAt`. If no payment qualifies, fall back to `suspendedAt`.
 *
 * Exported so it can be unit-tested without touching the DB.
 */
export function deriveBadDebtDate(
  payments: Array<{ paid_at: string | null }>,
  suspendedAt: string | null,
): string | null {
  if (!suspendedAt) return null;
  const threshold = suspendedAt;
  let latest: string | null = null;
  for (const p of payments) {
    const t = p.paid_at ?? null;
    if (!t) continue;
    // Compare as ISO strings. MySQL DATETIME and DATE strings are ISO-sortable.
    if (t > threshold && (latest == null || t > latest)) {
      latest = t;
    }
  }
  return latest ?? suspendedAt;
}

type InstRawRow = {
  contract_external_id: string;
  /** external_id of this installment row — numeric = payment-record row, "{id}-{period}" = installment base row */
  external_id: string | null;
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
  /** Per-period status code extracted from raw_json.installment_status_code. */
  installment_status_code: string | null;
  /** Remaining balance from raw_json.balance (0 = fully paid, includes discounts). Null when not fetched. */
  balance: number | null;
};

/**
 * Assign installment period + sub-row (splitIndex) + close/bad-debt flags
 * to each raw payment row. Exported for unit testing; consumers inside
 * listDebtCollected import it too.
 *
 * 1) Sorts payments by (paid_at, payment_id)
 * 2) Walks through scheduled installments in order; each payment
 *    "fills" the current installment by its principal+interest+fee
 *    (i.e. close_installment_amount when present).
 * 3) When the current installment is fully paid (or `close_installment_amount`
 *    is large enough to cover several installments), advance the cursor.
 * 4) `splitIndex` counts payments per period (0 = primary, 1 = 2nd, …)
 * 5) `isCloseRow` is true ONLY when receipt_no starts with "TXRTC"
 *    (Boonphone close-contract settlement). A positive
 *    `close_installment_amount` alone is NOT sufficient — every regular
 *    full-period payment also carries that field.
 * 6) `isBadDebtRow` is true when bad_debt_amount > 0; the payment is
 *    forced onto the LAST installment period.
 */
export function assignPayPeriods(
  payments: PayRawRow[],
  installmentList: Array<{ period: number | null; amount: number }>,
  contractNo?: string | null,
): Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> {
  if (!payments.length) return [];
  const schedule = installmentList
    .filter((i) => i.period != null)
    .map((i) => ({ period: i.period as number, amount: Number(i.amount) || 0 }))
    .sort((a, b) => a.period - b.period);

  let cursor = 0;
  let coveredCurrent = 0;
  const periodSeen = new Map<number, number>();
  const out: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> = [];

  // Phase 75C: Pre-check for duplicate TXRT suffixes.
  // If any TXRT suffix (the period-number segment) appears more than once,
  // it means the suffix is a receipt sequence number — NOT a period number.
  // In that case, skip Phase 75B (receipt-based cursor advancement) and
  // fall back to the original amount-based cursor walk.
  //
  // Phase 76 amendment: TXRT-N-M format (where M is a sub-payment index)
  // always uses N as the period number, regardless of duplicate N values.
  // Only TXRT-N (no M) receipts are checked for duplicates.
  // Example: TXRT-1-2 and TXRT-1-3 are both period 1 (not duplicates).
  let useSuffixPeriod = false;
  // hasNMFormat: true if ANY receipt uses N-M format (has sub-payment index)
  let hasNMFormat = false;
  if (contractNo) {
    const prefix75c = "TXRT" + contractNo.replace(/^CT/, "") + "-";
    const suffixCounts = new Map<string, number>(); // only for N-only receipts
    for (const p of payments) {
      const r = String(p.receipt_no ?? "");
      if (r.startsWith(prefix75c) && !r.startsWith("TXRTC")) {
        const suffix = r.slice(prefix75c.length);
        const parts = suffix.split("-");
        const firstSeg = parts[0];
        if (/^\d+$/.test(firstSeg)) {
          if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
            // N-M format: N is always the period, M is sub-payment index
            hasNMFormat = true;
          } else {
            // N-only format: check for duplicates
            suffixCounts.set(firstSeg, (suffixCounts.get(firstSeg) ?? 0) + 1);
          }
        }
      }
    }
    if (hasNMFormat) {
      // When N-M format exists, always use suffix-based period for N-M receipts.
      // For N-only receipts, still check duplicates.
      useSuffixPeriod = true; // will be applied selectively in Phase 75B
    } else {
      // No N-M format: use suffix-based period only when all N-only suffixes are unique
      const allUnique = Array.from(suffixCounts.values()).every((c) => c === 1);
      if (allUnique && suffixCounts.size > 0) {
        // Phase 79B: Validate that TXRT suffixes actually match the amount-based period walk.
        // If any suffix mismatches the amount-based cursor position, the suffix is a
        // receipt sequence number (not a period number) — fall back to amount-based walk.
        // This handles split-payment contracts where TXRT-2 and TXRT-3 both cover period 2
        // (TXRT-2 pays partial, TXRT-3 pays the remainder), causing suffix 3 ≠ period 2.
        const prefix79b = "TXRT" + contractNo.replace(/^CT/, "") + "-";
        const txrtNOnly = payments
          .filter((p) => {
            const r = String(p.receipt_no ?? "");
            if (!r.startsWith(prefix79b) || r.startsWith("TXRTC")) return false;
            const suffix = r.slice(prefix79b.length);
            const parts = suffix.split("-");
            return parts.length === 1 && /^\d+$/.test(parts[0]);
          })
          .sort((a, b) => {
            const getSuffix = (r: string) => parseInt(r.slice(prefix79b.length), 10);
            return getSuffix(String(a.receipt_no ?? "")) - getSuffix(String(b.receipt_no ?? ""));
          });
        // Simulate amount-based cursor walk to get expected period for each TXRT.
        // IMPORTANT: deduplicate installmentList by period first (take max amount per period)
        // because the DB may return 2 rows per period (paid-row + due-row split).
        // Using the raw list would cause the cursor to advance twice per period.
        const scheduleCheck79b: Array<{ period: number; amount: number }> = [];
        {
          const periodAmtMap = new Map<number, number>();
          for (const i of installmentList) {
            if (i.period == null) continue;
            const p = i.period as number;
            const a = Number(i.amount) || 0;
            periodAmtMap.set(p, Math.max(periodAmtMap.get(p) ?? 0, a));
          }
          for (const [p, a] of Array.from(periodAmtMap.entries()).sort((x, y) => x[0] - y[0])) {
            scheduleCheck79b.push({ period: p, amount: a });
          }
        }
        let cursorCheck = 0;
        let coveredCheck = 0;
        let suffixMatchesPeriod = true;
        for (const tp of txrtNOnly) {
          const r = String(tp.receipt_no ?? "");
          const suffix79b = r.slice(prefix79b.length);
          const suffixNum = parseInt(suffix79b, 10);
          const expectedPeriod = scheduleCheck79b[cursorCheck]?.period ?? null;
          if (expectedPeriod !== suffixNum) {
            suffixMatchesPeriod = false;
            break;
          }
          // Advance cursor using close_installment_amount (same as Phase 77)
          const closeAmt79b = Number(tp.close_installment_amount ?? 0);
          const pif79b =
            Number(tp.principal_paid ?? 0) +
            Number(tp.interest_paid ?? 0) +
            Number(tp.fee_paid ?? 0);
          const consumed79b = closeAmt79b > 0 ? closeAmt79b : pif79b > 0 ? pif79b : Number(tp.total_paid_amount ?? 0);
          coveredCheck += consumed79b;
          while (
            cursorCheck < scheduleCheck79b.length - 1 &&
            scheduleCheck79b[cursorCheck].amount > 0 &&
            coveredCheck >= scheduleCheck79b[cursorCheck].amount - 0.5
          ) {
            coveredCheck -= scheduleCheck79b[cursorCheck].amount;
            cursorCheck += 1;
          }
          if (coveredCheck < 0) coveredCheck = 0;
        }
        useSuffixPeriod = suffixMatchesPeriod;
      } else {
        useSuffixPeriod = allUnique;
      }
    }
  }

  // Phase 76: Extract numeric segments from TXRT receipt suffix for numeric sort.
  // TXRT-N-M receipts must sort N=1 before N=10 (not lexicographically).
  // TXRTC rows sort after TXRT rows (isClose=true → sortKey ends with large number).
  const getTxrtSortKey = (receiptNo: string | null): number[] => {
    if (!receiptNo) return [9999];
    if (receiptNo.startsWith("TXRTC")) return [99999]; // close rows always last
    // Match TXRT{contractSuffix}-N or TXRT{contractSuffix}-N-M
    const m = receiptNo.match(/-(\d+)(?:-(\d+))?$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const sub = m[2] != null ? parseInt(m[2], 10) : 0;
      return [n, sub];
    }
    return [9999];
  };

  const sorted = [...payments].sort((a, b) => {
    const at = a.paid_at ?? "";
    const bt = b.paid_at ?? "";
    if (at !== bt) return at.localeCompare(bt);
    // Phase 76: tie-break by TXRT numeric segments (N, then M) so TXRT-1-2 < TXRT-1-3 < TXRT-2-1 < TXRT-10
    // instead of alphabetical which would give TXRT-10 < TXRT-2 < TXRT-9.
    const ar = a.receipt_no ?? "";
    const br = b.receipt_no ?? "";
    if (ar !== br) {
      const ak = getTxrtSortKey(ar);
      const bk = getTxrtSortKey(br);
      for (let i = 0; i < Math.max(ak.length, bk.length); i++) {
        const av = ak[i] ?? 0;
        const bv = bk[i] ?? 0;
        if (av !== bv) return av - bv;
      }
    }
    return (a.payment_id ?? 0) - (b.payment_id ?? 0);
  });

  for (const p of sorted) {
    if ((p.bad_debt_amount ?? 0) > 0) {
      const lastPeriod = schedule.length
        ? schedule[schedule.length - 1].period
        : 1;
      const splitIdx = periodSeen.get(lastPeriod) ?? 0;
      periodSeen.set(lastPeriod, splitIdx + 1);
      out.push({ ...p, period: lastPeriod, splitIndex: splitIdx, isCloseRow: false, isBadDebtRow: true });
      continue;
    }

      const receipt = String(p.receipt_no ?? "");
    const isCloseRow = receipt.startsWith("TXRTC");

    // Phase 75B: If contractNo is provided and receipt is a TXRT (non-close) receipt,
    // parse the explicit period from the receipt_no suffix and advance cursor to that period.
    // This fixes cases where partial payments (e.g. TXRT-3-1 = 2.50 baht) don't advance
    // the cursor, causing subsequent receipts to be assigned to wrong periods.
    // Phase 75C: Only use suffix-based period when useSuffixPeriod=true (no duplicate suffixes).
    // Phase 76 amendment: When hasNMFormat=true, N-M receipts always use N as period;
    //   N-only receipts use suffix-based period only when useSuffixPeriod=true.
    if (contractNo && !isCloseRow && receipt.startsWith("TXRT") && useSuffixPeriod) {
      const prefix = "TXRT" + contractNo.replace(/^CT/, "") + "-";
      if (receipt.startsWith(prefix)) {
        const suffix = receipt.slice(prefix.length); // e.g. "2-1" or "4"
        const parts = suffix.split("-");
        const firstSegment = parts[0];
        const isNMFormat = parts.length >= 2 && /^\d+$/.test(parts[1]);
        // For N-only receipts when hasNMFormat is true, skip suffix-based period
        // (N-only receipts in a mixed contract may be sequence numbers)
        if (!isNMFormat && hasNMFormat) {
          // N-only receipt in a contract that also has N-M receipts:
          // use amount-based cursor walk (do not advance cursor here)
        } else {
          const explicitPeriod = Number(firstSegment);
          if (Number.isFinite(explicitPeriod) && explicitPeriod > 0) {
            // Advance cursor to the schedule index for this explicit period.
            // Phase 76: For N-M format receipts, allow cursor to move backward
            // to the explicit period (e.g. TXRT-1-3 after cursor advanced past period 1).
            // For N-only receipts, only advance forward (original Phase 75B behavior).
            const targetIdx = schedule.findIndex((s) => s.period === explicitPeriod);
            if (targetIdx >= 0) {
              if (isNMFormat) {
                // N-M: always set cursor to explicit period (allow backward).
                // Phase 76: always reset coveredCurrent for N-M receipts because
                // N-M format explicitly declares the period — any carry-over from
                // a previous receipt's partial payment should not affect this period.
                cursor = targetIdx;
                coveredCurrent = 0;
              } else if (targetIdx >= cursor) {
                // N-only: only advance forward
                cursor = targetIdx;
                coveredCurrent = 0;
              }
            }
          }
        }
      }
    }

    const period = schedule[cursor]?.period ?? null;
    const splitIdx = period != null ? (periodSeen.get(period) ?? 0) : 0;
    if (period != null) periodSeen.set(period, splitIdx + 1);
    out.push({ ...p, period, splitIndex: splitIdx, isCloseRow, isBadDebtRow: false });
    // Cursor advancement..
    //
    // Business rule (Phase 9M, 2026-04-23):
    //   TXRTC (close-contract) receipts — each receipt represents exactly
    //   ONE installment period (Boonphone API emits N receipts for N
    //   remaining periods, sometimes with the same paid_at). So we
    //   unconditionally advance the cursor by one per TXRTC receipt.
    //   This is the ONLY reliable rule because principal/interest/fee
    //   fields are often null on TXRTC close-out rows (and even
    //   `amount` is zero on the discount-only tail rows).
    //
    //   Regular TXRT payments — we still use the amount-based walk so
    //   that partial payments of the same period stay on that period.
    if (isCloseRow) {
      if (cursor < schedule.length - 1) {
        cursor += 1;
        coveredCurrent = 0;
      }
    } else {
      // Phase 77: Prefer close_installment_amount for cursor advancement because
      // it reflects exactly how much of the current installment was closed by this
      // payment in the source system. pif (principal+interest+fee) can differ from
      // the installment amount when there are rounding differences, partial payments,
      // or overpayments — using pif caused cursor to advance too early or too late.
      // Fall back to pif when close_installment_amount is absent, then raw total.
      const closeAmt = Number(p.close_installment_amount ?? 0);
      const pif =
        Number(p.principal_paid ?? 0) +
        Number(p.interest_paid ?? 0) +
        Number(p.fee_paid ?? 0);
      const consumed =
        closeAmt > 0
          ? closeAmt
          : pif > 0
            ? pif
            : Number(p.total_paid_amount ?? 0);
      coveredCurrent += consumed;
      while (
        cursor < schedule.length - 1 &&
        schedule[cursor].amount > 0 &&
        coveredCurrent >= schedule[cursor].amount - 0.5
      ) {
        coveredCurrent -= schedule[cursor].amount;
        cursor += 1;
      }
      // Phase 76: after cursor advance, if coveredCurrent is negative (payment was
      // slightly less than installment amount but still triggered advance due to -0.5
      // threshold), reset to 0 so the deficit does NOT carry forward to the next
      // period. This prevents TXRT-N-M partial payments from causing subsequent
      // N-only receipts to be assigned to the wrong period.
      if (coveredCurrent < 0) coveredCurrent = 0;
      // Phase 63: advance cursor เพิ่มตาม overpaid amount
      // ถ้าจ่ายเกิน (overpaid > 0) ให้ข้ามงวดที่ถูกครอบคลุมโดย overpaid pool
      const overpaidAmount = Number(p.overpaid_amount ?? 0);
      if (overpaidAmount > 0.009) {
        let overpaidRem = overpaidAmount;
        while (
          cursor < schedule.length - 1 &&
          schedule[cursor].amount > 0 &&
          overpaidRem >= schedule[cursor].amount - 0.5
        ) {
          overpaidRem -= schedule[cursor].amount;
          cursor += 1;
          coveredCurrent = 0;
        }
      }
    }
  }
  return out;
}

export type PayRawRow = {
  contract_external_id: string;
  period: number | null; // derived from receipt_no suffix or order
  paid_at: string | null;
  total_paid_amount: number | null;
  principal_paid: number | null;
  interest_paid: number | null;
  fee_paid: number | null;
  penalty_paid: number | null;
  unlock_fee_paid: number | null;
  discount_amount: number | null;
  overpaid_amount: number | null;
  close_installment_amount: number | null;
  bad_debt_amount: number | null;
  receipt_no: string | null;
  remark: string | null;
  payment_id: number | null;
};

/**
 * Determine if an installment row is a "payment-record" row (audit trail from
 * payment system) vs an "installment-base" row (scheduled installment from API).
 *
 * Pattern:
 *   INSTALLMENT_BASE: external_id = "{contractId}-{period}" (contains a dash)
 *   PAYMENT_RECORD:   external_id = numeric string only (e.g. "177695")
 *
 * When external_id is null or unknown, fall back to amount-based heuristic.
 */
function isPaymentRecordRow(row: InstRawRow): boolean {
  const extId = row.external_id;
  if (!extId) return false;
  // Numeric-only external_id = payment record from payment system
  return /^\d+$/.test(extId);
}

/**
 * Deduplicate installments per period — merge all rows for the same period.
 *
 * DB may have 2 rows per (contract_external_id, period) when the Boonphone/Fastfone365 API
 * returns a split representation:
 *   INSTALLMENT_BASE row (ext_id="{id}-{period}"): amount=X, paid_amount=? (scheduled installment)
 *   PAYMENT_RECORD row  (ext_id=numeric):           amount=0 or X, paid_amount=X (payment audit trail)
 *
 * Strategy:
 * 1. Identify rows by external_id pattern:
 *    - INSTALLMENT_BASE: ext_id contains a dash (e.g. "23223-3")
 *    - PAYMENT_RECORD:   ext_id is numeric only (e.g. "177695")
 * 2. isPaid = true if ANY PAYMENT_RECORD row for this period has status="ยืนยันการชำระ"
 *    OR if the INSTALLMENT_BASE row itself has status="ยืนยันการชำระ" AND no conflicting
 *    PAYMENT_RECORD row with status="ยังไม่ถึงกำหนด" exists.
 * 3. paid_amount = from the confirmed PAYMENT_RECORD row (if exists), else from INSTALLMENT_BASE.
 * 4. amount = from INSTALLMENT_BASE row (largest amount among base rows).
 * 5. due_date = EARLIEST due_date across all rows (payment records often carry the correct date).
 */
function dedupInstByPeriod(list: InstRawRow[]): InstRawRow[] {
  if (list.length === 0) return list;

  const byPeriod = new Map<number | null, { base: InstRawRow; minDueDate: Date | null; confirmedPaymentRecord: InstRawRow | null; anyPayRecSeen: boolean; maxPayRecPaid: number }>();

  for (const row of list) {
    const p = row.period;
    const rowAmt = Number(row.amount ?? 0);
    const rowDue = row.due_date ? new Date(row.due_date) : null;
    const isPayRec = isPaymentRecordRow(row);
    const isConfirmed = row.inst_status === 'ยืนยันการชำระ';
    const rowPaid = Number(row.paid_amount ?? 0);

    const existing = byPeriod.get(p);
    if (!existing) {
      byPeriod.set(p, {
        base: row,
        minDueDate: rowDue,
        confirmedPaymentRecord: (isPayRec && isConfirmed) ? row : null,
        anyPayRecSeen: isPayRec,
        maxPayRecPaid: isPayRec ? rowPaid : 0,
      });
    } else {
      // Track whether any PAY_REC row was seen for this period
      if (isPayRec) {
        existing.anyPayRecSeen = true;
        // Track max paid_amount from PAY_REC rows (for partial payment detection)
        if (rowPaid > existing.maxPayRecPaid) existing.maxPayRecPaid = rowPaid;
      }

      // Update confirmedPaymentRecord: prefer PAYMENT_RECORD with status=ยืนยันการชำระ
      if (isPayRec && isConfirmed && !existing.confirmedPaymentRecord) {
        existing.confirmedPaymentRecord = row;
      }

      // Update base row: prefer INSTALLMENT_BASE rows; among them pick largest amount
      const existIsPayRec = isPaymentRecordRow(existing.base);
      const existAmt = Number(existing.base.amount ?? 0);
      if (!isPayRec && existIsPayRec) {
        // Replace payment-record base with installment-base row
        existing.base = row;
      } else if (!isPayRec && !existIsPayRec && rowAmt > existAmt) {
        // Both are installment-base: pick larger amount
        existing.base = row;
      } else if (isPayRec && existIsPayRec && rowAmt > existAmt) {
        // Both are payment-records: pick larger amount
        existing.base = row;
      }

      // Track the earliest due_date across all rows for this period
      if (rowDue && (!existing.minDueDate || rowDue < existing.minDueDate)) {
        existing.minDueDate = rowDue;
      }
    }
  }

  // Build merged rows
  const merged: InstRawRow[] = Array.from(byPeriod.values()).map(({ base, minDueDate, confirmedPaymentRecord, anyPayRecSeen, maxPayRecPaid }) => {
    // Determine paid_amount and inst_status:
    // Rule: When ANY payment-record row exists for this period, use the PAY_REC
    // as the authoritative source for paid status — do NOT trust INST_BASE paid_amount
    // because Boonphone/Fastfone365 API sometimes sends wrong paid_amount in INST_BASE
    // (e.g. period 4 INST_BASE has paid=2094 but the actual payment is for period 3).
    //
    // - If a confirmed PAY_REC (status=ยืนยันการชำระ) exists → isPaid=true, paid=from PAY_REC
    // - If PAY_REC exists but NOT confirmed → isPaid=false, paid=maxPayRecPaid (partial payment)
    //   Phase 86 fix: use maxPayRecPaid instead of 0 to correctly show partial payments
    //   (e.g. PAY_REC has paid=50 with status=เกินกำหนดชำระ → show paid=50, not 0)
    // - If NO PAY_REC at all → use INST_BASE paid_amount as-is (single-source data)
    let paidAmount: number;
    let instStatus: string | null;

    if (confirmedPaymentRecord != null) {
      // Confirmed PAY_REC exists → use its paid_amount (authoritative)
      paidAmount = Number(confirmedPaymentRecord.paid_amount ?? 0);
      instStatus = 'ยืนยันการชำระ';
    } else if (anyPayRecSeen) {
      // PAY_REC exists but NOT confirmed → use maxPayRecPaid (PAY_REC is authoritative)
      // Phase 86 fix: respect partial payments from PAY_REC (paid > 0 but not fully paid)
      paidAmount = maxPayRecPaid;
      instStatus = base.inst_status === 'ยืนยันการชำระ' ? 'ยังไม่ถึงกำหนด' : base.inst_status;
    } else {
      // No PAY_REC at all → use INST_BASE paid_amount as-is
      paidAmount = Number(base.paid_amount ?? 0);
      instStatus = base.inst_status;
    }

    return {
      ...base,
      due_date: minDueDate ? minDueDate.toISOString().slice(0, 10) : base.due_date,
      paid_amount: paidAmount,
      inst_status: instStatus,
    };
  });

  // Return sorted by period ascending
  return merged.sort((a, b) => (a.period ?? 0) - (b.period ?? 0));
}

/**
 * Fix installment rows whose due_date is out-of-order relative to adjacent periods.
 *
 * Boonphone API occasionally sends a wrong due_date for a period (e.g. period 1
 * gets 2027-01-05 while period 2 is 2026-04-05).  This helper detects any
 * period N where due_date > due_date of period N+1 and recalculates it from
 * the due-day-of-month inferred from the nearest correct neighbour.
 *
 * The fix is applied in-memory only — the DB row is not modified, so the
 * correction is re-applied automatically on every query without being wiped by
 * future syncs.
 */
function fixOutOfOrderDueDates(list: InstRawRow[]): InstRawRow[] {
  if (list.length < 2) return list;
  // Work on a sorted copy (ascending period)
  const sorted = [...list].sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

  // Find the first pair where period N > period N+1
  let hasOutOfOrder = false;
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i].due_date;
    const next = sorted[i + 1].due_date;
    if (curr && next && curr > next) {
      hasOutOfOrder = true;
      break;
    }
  }
  if (!hasOutOfOrder) return list; // fast-path: nothing to fix

  // Derive due-day-of-month from the first "good" period (period 2 or later)
  // by looking for a period whose due_date is in ascending order with its successor.
  let dueDayOfMonth: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i].due_date;
    if (!d) continue;
    const parsed = new Date(`${d}T00:00:00`);
    if (!isNaN(parsed.getTime())) {
      dueDayOfMonth = parsed.getDate();
      break;
    }
  }
  if (!dueDayOfMonth) return list; // cannot infer day — leave as-is

  // Anchor strategy: find the SMALLEST valid due_date in the list and treat it
  // as the due_date for period 1.  Then rebuild every period as:
  //   period N due_date = anchor + (N - 1) months
  //
  // This handles the Boonphone API bug where multiple periods may have wrong
  // years (e.g. period 1 = 2027-01-05 and period 10 = 2026-12-05 when the
  // correct sequence should start at 2026-04-05).
  let anchorDate: Date | null = null;

  for (const row of sorted) {
    if (!row.due_date) continue;
    const d = new Date(`${row.due_date}T00:00:00`);
    if (isNaN(d.getTime())) continue;
    if (!anchorDate || d < anchorDate) {
      anchorDate = d;
    }
  }

  if (!anchorDate) return list;

  return sorted.map((row) => {
    if (row.period == null || !row.due_date) return row;
    const expected = new Date(anchorDate!);
    expected.setMonth(expected.getMonth() + (row.period - 1));
    expected.setDate(dueDayOfMonth!);
    const expectedStr = expected.toISOString().slice(0, 10);
    if (row.due_date !== expectedStr) {
      return { ...row, due_date: expectedStr };
    }
    return row;
  });
}

/** Compute "debt_status" label based on days overdue. */
function bucketFromDays(days: number): string {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

const TERMINAL_STATUSES = new Set([
  "ระงับสัญญา",
  "สิ้นสุดสัญญา",
  "หนี้เสีย",
]);

function deriveDebtStatus(
  contractStatus: string | null,
  installmentsForContract: InstRawRow[],
  today: Date,
): { label: string; daysOverdue: number } {
  if (contractStatus && TERMINAL_STATUSES.has(contractStatus)) {
    return { label: contractStatus, daysOverdue: 0 };
  }
  let maxDays = 0;
  for (const it of installmentsForContract) {
    if (!it.due_date) continue;
    const dueMs = Date.parse(`${it.due_date}T00:00:00`);
    if (Number.isNaN(dueMs)) continue;
    const paid = Number(it.paid_amount ?? 0);
    const amt = Number(it.amount ?? 0);
    // Skip payment-record rows (amount=0) — these are payment receipts, not installment schedules.
    // Only real installment rows (amount > 0) should be considered for overdue calculation.
    if (amt <= 0.001) continue;
    // If paid_amount >= amount, the installment is fully paid regardless of what balance says.
    // This handles cases where the API returns a stale balance (before payment was applied)
    // but paid_amount has already been summed correctly via dedup logic.
    if (paid >= amt - 0.001) continue;
    // Prefer balance from raw_json (API-computed, already accounts for discounts/partial payments).
    // Fall back to amount - paid_amount when balance is not available.
    const outstanding = (it.balance !== null && it.balance !== undefined)
      ? Number(it.balance)
      : amt - paid;
    if (outstanding <= 0.001) continue;
    const days = Math.floor((today.getTime() - dueMs) / (1000 * 60 * 60 * 24));
    if (days > maxDays) maxDays = days;
  }
  return { label: bucketFromDays(maxDays), daysOverdue: maxDays };
}

/**
 * Return the dataset used by the "เป้าเก็บหนี้" tab.
 * One entry per contract with `installments[]` describing the scheduled
 * principal / interest / fee / penalty for each period.
 */
export async function listDebtTarget(params: { section: SectionKey }) {
  const db = await getDb();
  if (!db) return { rows: [] as any[] };

  // --- Load contract headers (trimmed — no rawJson) ---
  const contractRowsRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           installment_count,
           installment_amount,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           status,
           product_type,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date,
           CAST(commission_net AS DECIMAL(18,2)) AS commission_net
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
  `);
  const cRows: Array<any> = (contractRowsRaw as any)[0] ?? contractRowsRaw;

  // --- Load installments with sub-fields extracted from raw_json once ---
  // Both Boonphone and Fastfone365 use the same API fields:
  // installment_status_code, principal_due, interest_due, fee_due, penalty_due, unlock_fee_due
  const instRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           external_id,
           period,
           due_date,
           CAST(amount AS DECIMAL(18,2))       AS amount,
           CAST(paid_amount AS DECIMAL(18,2))  AS paid_amount,
           status AS inst_status,
           CAST(JSON_EXTRACT(raw_json, '$.principal_due') AS DECIMAL(18,2)) AS principal_due,
           CAST(JSON_EXTRACT(raw_json, '$.interest_due')  AS DECIMAL(18,2)) AS interest_due,
           CAST(JSON_EXTRACT(raw_json, '$.fee_due')       AS DECIMAL(18,2)) AS fee_due,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_due')    AS DECIMAL(18,2)) AS penalty_due,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_due')  AS DECIMAL(18,2)) AS unlock_fee_due,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS installment_status_code,
           CAST(JSON_EXTRACT(raw_json, '$.balance') AS DECIMAL(18,2)) AS balance
      FROM ${installments}
     WHERE ${installments.section} = ${params.section}
     ORDER BY contract_external_id, period
  `);
  const iRows: InstRawRow[] = (instRowsRaw as any)[0] ?? instRowsRaw;

  const instByContract = new Map<string, InstRawRow[]>();
  for (const r of iRows) {
    const key = String(r.contract_external_id);
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key)!.push({
      contract_external_id: key,
      external_id: r.external_id != null ? String(r.external_id) : null,
      period: r.period != null ? Number(r.period) : null,
      due_date: r.due_date ?? null,
      amount: r.amount != null ? Number(r.amount) : null,
      paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
      inst_status: r.inst_status ?? null,
      principal_due: r.principal_due != null ? Number(r.principal_due) : null,
      interest_due: r.interest_due != null ? Number(r.interest_due) : null,
      fee_due: r.fee_due != null ? Number(r.fee_due) : null,
      penalty_due: r.penalty_due != null ? Number(r.penalty_due) : null,
      unlock_fee_due: r.unlock_fee_due != null ? Number(r.unlock_fee_due) : null,
      installment_status_code: r.installment_status_code ?? null,
      balance: r.balance != null ? Number(r.balance) : null,
    });
  }

  // --- Dedup installments per period (DB may have 2 rows per period) ---
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, dedupInstByPeriod(list));
  }
  // --- Fix out-of-order due_dates (Boonphone API bug) ---
  // Apply in-memory correction for any contract whose installments have a
  // period N with due_date > period N+1.  This is idempotent and safe.
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, fixOutOfOrderDueDates(list));
  }

  // --- Detect "ปิดค่างวด" (customer settles ALL remaining periods at once).
  //
  // Phase 52 rule (2026-04-26): use the LAST period that has paid_amount > 0
  // (from installments, which is already loaded into instByContract) as the
  // "close period". Periods strictly AFTER that period render as "ปิดค่างวดแล้ว".
  // Only applies to contracts that have status = 'สิ้นสุดสัญญา' (i.e. have a TXRTC
  // close payment). Active/suspended contracts are NOT affected.
  const closedByContract = new Map<string, number>();

  // Phase 74: Build contractNo lookup for correct receipt period parsing
  // Receipt format: TXRT{contract_no}-{period} or TXRT{contract_no}-{period}-{sub}
  // e.g. TXRT0225-SRI001-9292-01-2-1 → contract_no=CT0225-SRI001-9292-01 → period=2
  // Regex /-(d+)$/ incorrectly matches last digit (-1 instead of -2)
  // Fix: strip "TXRT{contract_no}-" prefix, then take first segment
  const contractNoByExtId = new Map<string, string>();
  for (const cr of cRows) {
    const k = String(cr.external_id ?? "");
    if (k && cr.contract_no) contractNoByExtId.set(k, String(cr.contract_no));
  }
  // Helper: parse period from TXRT receipt_no using contract_no prefix strip
  function parseTxrtPeriod(receipt: string, contractExtId: string): number {
    const contractNo = contractNoByExtId.get(contractExtId);
    if (contractNo) {
      // receipt prefix = "TXRT" + contract_no.replace(/^CT/, '') + "-"
      // e.g. contract_no = "CT0225-SRI001-9292-01" → prefix = "TXRT0225-SRI001-9292-01-"
      const prefix = "TXRT" + contractNo.replace(/^CT/, "") + "-";
      if (receipt.startsWith(prefix)) {
        const suffix = receipt.slice(prefix.length); // e.g. "2-1" or "4"
        const firstSegment = suffix.split("-")[0];
        const p = Number(firstSegment);
        if (Number.isFinite(p) && p > 0) return p;
      }
    }
    // Fallback: use last -N suffix (old behavior)
    const m = /-(\d+)$/.exec(receipt);
    return m ? Number(m[1]) : 0;
  }
  const overpaidByContractPeriod = new Map<string, Map<number, number>>();
  // For bad-debt date derivation: every payment's paid_at per contract.
  const paidAtsByContract = new Map<string, string[]>();
  // Phase 67: TXRT normal receipt suffix periods per contract (for bad-debt suspendedFromPeriod fallback)
  const normalPeriodsByContractOuter = new Map<string, Set<number>>();
  // Phase 68: track total_paid_amount per TXRT suffix per contract (to detect device sale payments)
  const txrtTotalByContractPeriod = new Map<string, Map<number, number>>();
  // Phase 68B: sum of close_installment_amount per contract (excluding device sale payments)
  // Used when receipt_no is null (FF365 style) to compute suspendedFromPeriod via close amounts
  const closeAmtSumByContract = new Map<string, number>();
  const closePayTotalByContract = new Map<string, number[]>(); // list of total_paid_amount per payment

  {
    // Extra query: get close_installment_amount for ALL payments (no receipt_no filter)
    // Phase 110: include paid_at so we can exclude bad-debt-date payments from closeSum
    const rawCloseAmtData = await db.execute(sql`
      SELECT contract_external_id,
             CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
             CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
             DATE(paid_at) AS paid_date
        FROM ${paymentTransactions}
       WHERE ${paymentTransactions.section} = ${params.section}
         AND JSON_EXTRACT(raw_json, '$.close_installment_amount') IS NOT NULL
         AND CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
    `);
    const closeAmtRows: any[] = (rawCloseAmtData as any)[0] ?? rawCloseAmtData;
    // First pass: collect all total_paid_amounts per contract
    for (const row of closeAmtRows) {
      const key = String(row.contract_external_id ?? "");
      if (!key) continue;
      const totalPaid = Number(row.total_paid_amount ?? 0);
      const tList = closePayTotalByContract.get(key) ?? [];
      tList.push(totalPaid);
      closePayTotalByContract.set(key, tList);
    }
    // Second pass: accumulate close_installment_amount, excluding bad-debt payments
    // Phase 110 Iron Rule: exclude payments on bad_debt_date from closeSum
    // (bad-debt payments are NOT normal installment payments, even if they have close_installment_amount > 0)
    // Also exclude device sale payments: total_paid_amount ≈ bad_debt_amount (within 1 baht)
    // We need bad_debt_amount and bad_debt_date per contract — load from cRows
    const badDebtAmtByContract = new Map<string, number>();
    const badDebtDateByContract = new Map<string, string>(); // YYYY-MM-DD
    for (const cr of cRows) {
      const k = String(cr.external_id ?? "");
      if (k && cr.bad_debt_amount != null) badDebtAmtByContract.set(k, Number(cr.bad_debt_amount));
      if (k && cr.bad_debt_date != null) {
        // Normalize to YYYY-MM-DD string
        const d = cr.bad_debt_date instanceof Date
          ? cr.bad_debt_date.toISOString().slice(0, 10)
          : String(cr.bad_debt_date).slice(0, 10);
        badDebtDateByContract.set(k, d);
      }
    }
    for (const row of closeAmtRows) {
      const key = String(row.contract_external_id ?? "");
      if (!key) continue;
      const totalPaid = Number(row.total_paid_amount ?? 0);
      const closeAmt = Number(row.close_installment_amount ?? 0);
      const badDebt = badDebtAmtByContract.get(key) ?? 0;
      const badDebtDate = badDebtDateByContract.get(key) ?? null;
      // Phase 110: Skip payments on bad_debt_date (these are bad-debt payments, not normal installments)
      if (badDebtDate) {
        const paidDate = row.paid_date ? String(row.paid_date).slice(0, 10) : null;
        if (paidDate && paidDate === badDebtDate) continue;
      }
      // Skip device sale payments (total ≈ bad_debt_amount)
      if (badDebt > 0 && Math.abs(totalPaid - badDebt) <= 1) continue;
      closeAmtSumByContract.set(key, (closeAmtSumByContract.get(key) ?? 0) + closeAmt);
    }
  }

  {
    // Load all payments: needed for (a) TXRTC close detection, (b) overpaid tracking,
    // (c) paidAts for bad-debt date derivation.
    // Phase 78: include principal_paid, interest_paid, fee_paid, close_installment_amount, payment_id
    // so that assignPayPeriods can be used to derive the correct installment period for each TXRT payment,
    // replacing the receipt_no suffix parsing (which gives sequence number, not period number).
    const rawCloseData = await db.execute(sql`
      SELECT contract_external_id,
             external_id AS payment_external_id,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
             CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount,
             CAST(JSON_EXTRACT(raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
             CAST(JSON_EXTRACT(raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
             CAST(JSON_EXTRACT(raw_json, '$.fee_paid') AS DECIMAL(18,2)) AS fee_paid,
             CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
             CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount') AS DECIMAL(18,2)) AS bad_debt_amount,
             CAST(JSON_EXTRACT(raw_json, '$.payment_id') AS UNSIGNED) AS payment_id,
             CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
             paid_at
        FROM ${paymentTransactions}
       WHERE ${paymentTransactions.section} = ${params.section}
         AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) IS NOT NULL
    `);
    const allPayRows: any[] = (rawCloseData as any)[0] ?? rawCloseData;

    // Pass 1: collect paidAts, TXRTC close markers, and build per-contract payment lists
    // for assignPayPeriods-based period derivation (Phase 78).
    const closeDatesByContract = new Map<string, Date[]>();
    // normalPeriodsByContractOuter and txrtTotalByContractPeriod are declared outside this block (Phase 67/68)
    // Phase 78: group raw payment rows by contract for assignPayPeriods
    const rawPaysByContract = new Map<string, PayRawRow[]>();

    for (const pr of allPayRows) {
      const key = String(pr.contract_external_id ?? "");
      if (!key) continue;
      if (pr.paid_at) {
        const arr = paidAtsByContract.get(key) ?? [];
        arr.push(String(pr.paid_at));
        paidAtsByContract.set(key, arr);
      }
      const receipt = String(pr.receipt_no ?? "");
      if (receipt.startsWith("TXRTC")) {
        const dt = pr.paid_at ? new Date(pr.paid_at) : null;
        if (dt && !isNaN(dt.getTime())) {
          const list = closeDatesByContract.get(key) ?? [];
          list.push(dt);
          closeDatesByContract.set(key, list);
        }
      }
      // Phase 78: collect all payments (TXRT + TXRTC) for assignPayPeriods
      const payRow: PayRawRow = {
        contract_external_id: key,
        period: null,
        paid_at: pr.paid_at ?? null,
        total_paid_amount: pr.total_paid_amount != null ? Number(pr.total_paid_amount) : null,
        principal_paid: pr.principal_paid != null ? Number(pr.principal_paid) : null,
        interest_paid: pr.interest_paid != null ? Number(pr.interest_paid) : null,
        fee_paid: pr.fee_paid != null ? Number(pr.fee_paid) : null,
        penalty_paid: null,
        unlock_fee_paid: null,
        discount_amount: null,
        overpaid_amount: pr.overpaid_amount != null ? Number(pr.overpaid_amount) : null,
        close_installment_amount: pr.close_installment_amount != null ? Number(pr.close_installment_amount) : null,
        bad_debt_amount: pr.bad_debt_amount != null ? Number(pr.bad_debt_amount) : null,
        receipt_no: pr.receipt_no ?? null,
        remark: null,
        payment_id: pr.payment_id != null ? Number(pr.payment_id) : null,
      };
      const arr2 = rawPaysByContract.get(key) ?? [];
      arr2.push(payRow);
      rawPaysByContract.set(key, arr2);
    }

    // Phase 78: For each contract that has TXRTC (สิ้นสุดสัญญา), use assignPayPeriods
    // to derive the correct installment period for each TXRT-N payment.
    // This replaces parseTxrtPeriod suffix parsing which gives sequence number, not period number.
    //
    // Phase 78 fix: build baseline map (installment_amount per contract) BEFORE the loop
    // so we can use it as fallback when installment.amount=0 (isClosed periods).
    // Without this, assignPayPeriods cursor stalls on amount=0 rows and assigns
    // subsequent TXRT payments to the wrong period, causing maxNormalPeriod to be too low.
    const baselineByKeyPhase78 = new Map<string, number>();
    for (const cr of cRows) {
      const k = String(cr.external_id ?? "");
      if (k && cr.installment_amount != null) {
        baselineByKeyPhase78.set(k, Number(cr.installment_amount));
      }
    }

    for (const key of Array.from(closeDatesByContract.keys())) {
      const instList = instByContract.get(key) ?? [];
      if (!instList.length) continue;
      const contractNo = contractNoByExtId.get(key) ?? null;
      const rawPays = rawPaysByContract.get(key) ?? [];
      // Only process real payments (numeric external_id or TXRT receipt pattern)
      const realPays = rawPays.filter((p) => {
        const payExtId = String((p as any).payment_external_id ?? "");
        const receiptNo = p.receipt_no ?? "";
        return /^\d+$/.test(payExtId) || /^TXRT.*-\d+$/.test(receiptNo);
      });
      // Phase 78 fix: use installment_amount as fallback when amount=0 (isClosed periods)
      // so assignPayPeriods cursor can advance past closed installments correctly.
      const baselineAmt78 = baselineByKeyPhase78.get(key) ?? 0;
      const assigned = assignPayPeriods(
        realPays,
        instList.map((i) => {
          const amt = Number(i.amount ?? 0);
          return { period: i.period, amount: amt > 0 ? amt : baselineAmt78 };
        }),
        contractNo,
      );
      // Build normalPeriodsByContractOuter from assignPayPeriods output (TXRT-N only, not TXRTC)
      // Phase 79: Exclude TXRT payments that did NOT actually close any installment principal.
      // A TXRT receipt with close_installment_amount=0 AND principal_paid=0 AND interest_paid=0
      // is a zero-value or partial-fee-only payment that should NOT count as a "normal period"
      // for maxNormalPeriod calculation. Including it inflates maxNormalPeriod and causes
      // subsequent periods to be shown as normal instead of "ปิดค่างวดแล้ว".
      const outerSet = new Set<number>();
      for (const ap of assigned) {
        if (ap.isCloseRow || ap.isBadDebtRow) continue;
        const period = ap.period;
        if (period == null || period <= 0) continue;
        // Phase 79: skip TXRT rows that did NOT actually close any installment principal.
        // close_installment_amount is the authoritative field from the source system indicating
        // how much of the current installment was closed by this payment.
        // When close_installment_amount = 0, the payment did not close any installment period
        // (e.g. TXRT-5 with 550 baht that has close_installment_amount=0, principal_paid=0,
        // interest_paid=0 — it's a partial fee payment that doesn't advance the period cursor).
        // Such rows must NOT be counted as normalPeriods, otherwise maxNormalPeriod is inflated
        // and subsequent periods are shown as normal instead of "ปิดค่างวดแล้ว".
        //
        // Exception: when close_installment_amount is null (field not present in raw_json),
        // fall back to principal_paid > 0 as the indicator. This handles older payment records
        // that may not have the close_installment_amount field populated.
        const closeAmt79 = ap.close_installment_amount;
        const principalPaid79 = Number(ap.principal_paid ?? 0);
        if (closeAmt79 !== null) {
          // close_installment_amount is present: use it as authoritative indicator
          if (Number(closeAmt79) === 0) continue;
        } else {
          // close_installment_amount is absent: fall back to principal_paid
          if (principalPaid79 === 0) continue;
        }
        outerSet.add(period);
        // Phase 68: track total_paid_amount per period (for device sale detection)
        const totalPaidForPeriod = Number(ap.total_paid_amount ?? 0);
        if (totalPaidForPeriod > 0) {
          let tMap = txrtTotalByContractPeriod.get(key);
          if (!tMap) { tMap = new Map<number, number>(); txrtTotalByContractPeriod.set(key, tMap); }
          tMap.set(period, (tMap.get(period) ?? 0) + totalPaidForPeriod);
        }
        // Track overpaid amount for this period
        const overpaid = Number(ap.overpaid_amount ?? 0);
        if (overpaid > 0) {
          let periodMap = overpaidByContractPeriod.get(key);
          if (!periodMap) {
            periodMap = new Map<number, number>();
            overpaidByContractPeriod.set(key, periodMap);
          }
          periodMap.set(period, (periodMap.get(period) ?? 0) + overpaid);
        }
      }
      if (outerSet.size > 0) normalPeriodsByContractOuter.set(key, outerSet);
    }

    // Phase 78 fallback: For contracts WITHOUT TXRTC (not in closeDatesByContract),
    // still populate normalPeriodsByContractOuter for bad-debt suspendedFromPeriod (Phase 67/68).
    // These contracts use parseTxrtPeriod (sequence number = period for non-TXRTC contracts).
    for (const pr of allPayRows) {
      const key = String(pr.contract_external_id ?? "");
      if (!key) continue;
      // Skip contracts already processed by assignPayPeriods above
      if (closeDatesByContract.has(key)) continue;
      const receipt = String(pr.receipt_no ?? "");
      if (receipt.startsWith("TXRTC")) continue;
      const period = parseTxrtPeriod(receipt, key);
      if (!Number.isFinite(period) || period <= 0) continue;
      const outerSet = normalPeriodsByContractOuter.get(key) ?? new Set<number>();
      outerSet.add(period);
      normalPeriodsByContractOuter.set(key, outerSet);
      // Phase 68: track total_paid_amount per TXRT suffix
      const totalPaidForPeriod = Number(pr.total_paid_amount ?? 0);
      if (totalPaidForPeriod > 0) {
        let tMap = txrtTotalByContractPeriod.get(key);
        if (!tMap) { tMap = new Map<number, number>(); txrtTotalByContractPeriod.set(key, tMap); }
        tMap.set(period, (tMap.get(period) ?? 0) + totalPaidForPeriod);
      }
      // Phase 85: Validate overpaid against INST_BASE paid_amount.
      // Suffix-based period assignment (TXRT-N → period N) can be wrong when a payment
      // covers the REMAINING balance of an earlier period (e.g. TXRT-2 closes period 1
      // remainder, not period 2). In that case the INST_BASE for period N will show
      // paid_amount < amount (not fully paid), which means the suffix-based assignment
      // is incorrect and the overpaid_amount belongs to a different period.
      //
      // Phase 85 revised: Two-step check:
      // 1. If INST_BASE[period] is fully paid → track overpaid at period (normal case).
      // 2. If INST_BASE[period] is NOT fully paid but INST_BASE[period-1] IS fully paid
      //    → TXRT-N actually closed period N-1 remainder, so overpaid belongs to period N.
      //    Track overpaid at period (same period N, which is where the carry lands).
      // 3. If neither → skip (suffix assignment is wrong in an unresolvable way).
      const overpaid = Number(pr.overpaid_amount ?? 0);
      if (overpaid > 0) {
        const instListForKey = instByContract.get(key) ?? [];
        const instRow = instListForKey.find((r) => Number(r.period ?? 0) === period);
        const instBaseAmount = instRow ? Number(instRow.amount ?? 0) : 0;
        const instBasePaid = instRow ? Number(instRow.paid_amount ?? 0) : 0;
        const instIsPaid =
          (instBaseAmount < 0.009 && instBasePaid > 0.009) ||
          (instBaseAmount > 0.009 && instBasePaid >= instBaseAmount - 0.5);
        // Phase 85 step 2: check prior period (period-1) when current period is not fully paid
        const priorInstRow = !instIsPaid && period > 1
          ? instListForKey.find((r) => Number(r.period ?? 0) === period - 1)
          : null;
        const priorBaseAmount = priorInstRow ? Number(priorInstRow.amount ?? 0) : 0;
        const priorBasePaid = priorInstRow ? Number(priorInstRow.paid_amount ?? 0) : 0;
        const priorIsPaid = priorInstRow &&
          ((priorBaseAmount < 0.009 && priorBasePaid > 0.009) ||
           (priorBaseAmount > 0.009 && priorBasePaid >= priorBaseAmount - 0.5));
        if (instIsPaid || priorIsPaid) {
          let periodMap = overpaidByContractPeriod.get(key);
          if (!periodMap) {
            periodMap = new Map<number, number>();
            overpaidByContractPeriod.set(key, periodMap);
          }
          // Phase 85b fix: when priorIsPaid (TXRT-N closed prior period remainder),
          // track at period-1 so carry-forward correctly applies overpaid at period N.
          // (e.g. TXRT-2 closes period 1 remainder + overpaid 50 -> track at 1 -> apply at 2)
          const trackPeriod = instIsPaid ? period : period - 1;
          periodMap.set(trackPeriod, (periodMap.get(trackPeriod) ?? 0) + overpaid);
        }
      }
    }

    // Phase 64: Cascade overpaid carry-forward across periods
    // If overpaid[p] > installment_amount (contract baseline), the excess
    // carries to period p+1, p+2, ... until exhausted.
    // Example: CT0925-PKN001-15462-01 period 2 overpaid=7802, baseline=3901
    //   → period 3 gets 7802 (covers full 3901), excess 3901 → period 4
    //   → period 4 gets 3901 (covers full 3901), excess 0 → done
    {
      const baselineByKey = new Map<string, number>();
      for (const cr of cRows) {
        const k = String(cr.external_id ?? "");
        if (k && cr.installment_amount != null) {
          baselineByKey.set(k, Number(cr.installment_amount));
        }
      }
      for (const [key, periodMap] of Array.from(overpaidByContractPeriod.entries())) {
        const baseline = baselineByKey.get(key) ?? 0;
        if (baseline <= 0) continue;
        // Sort periods ascending so cascade flows forward
        const periods = Array.from(periodMap.keys()).sort((a, b) => a - b);
        for (const p of periods) {
          const overpaid = periodMap.get(p) ?? 0;
          if (overpaid > baseline + 0.5) {
            // Carry excess to next period
            const excess = overpaid - baseline;
            periodMap.set(p + 1, (periodMap.get(p + 1) ?? 0) + excess);
          }
        }
      }
    }

    // Pass 2 (Phase 62): 3-pattern isClosed logic based on TXRTC position
    //
    // Pattern 1: maxNormal=0 (TXRTC ปิดงวดแรก ไม่มี TXRT ปกติ)
    //   → งวด 1 ยอดปกติ, งวด 2+ ปดค่างวด
    //   stored as: closedByContract.set(key, 0)
    //
    // Pattern 2: 1 < maxNormal < totalPeriods (TXRTC ปิดงวด N ระหว่างกลาง)
    //   → งวด 1..N ยอดปกติ, งวด N+1+ ปดค่างวด
    //   stored as: closedByContract.set(key, N)
    //
    // Pattern 3: maxNormal >= totalPeriods (TXRTC ปิดงวดสุดท้ายงวดเดียว)
    //   → ทุกงวดยอดปกติ (isClosed = false ทั้งหมด)
    //   stored as: closedByContract.set(key, -1)  (-1 = sentinel for Pattern 3)
    //
    // Build a lookup of installment_count per contract for Pattern 3 detection.
    const installCountByKey = new Map<string, number>();
    for (const cr of cRows) {
      const k = String(cr.external_id ?? "");
      if (k) installCountByKey.set(k, cr.installment_count != null ? Number(cr.installment_count) : 0);
    }

    for (const key of Array.from(closeDatesByContract.keys())) {
      const normalPeriods = normalPeriodsByContractOuter.get(key);
      const maxNormalPeriod = normalPeriods && normalPeriods.size > 0
        ? Math.max(...Array.from(normalPeriods))
        : 0;
      const totalPeriods = installCountByKey.get(key) ?? 0;
      // Pattern 3: TXRTC ปิดงวดสุดท้ายงวดเดียว (maxNormal >= totalPeriods > 0) → ยอดปกติทั้งหมด
      if (totalPeriods > 0 && maxNormalPeriod >= totalPeriods) {
        closedByContract.set(key, -1); // -1 = Pattern 3: no isClosed
      } else {
        // Phase 84: Pattern 2 — ใช้ txrtcPaidDate vs dueDate(N) เพื่อตัดสิน boundary
        //
        // Business rule:
        //   txrtcPaidDate < dueDate(N)  → ปิดค่างวดตั้งแต่งวด N   (ปิด N ด้วย)
        //     stored as: closedByContract.set(key, N - 1)
        //   txrtcPaidDate >= dueDate(N) → ปิดค่างวดตั้งแต่งวด N+1 (งวด N ยังปกติ)
        //     stored as: closedByContract.set(key, N)
        //
        // Pattern 1 (maxNormalPeriod=0): ไม่มีงวดปกติ → ปิดค่างวดตั้งแต่งวด 1
        //   stored as: closedByContract.set(key, 0) — ไม่เปลี่ยน
        if (maxNormalPeriod > 0) {
          // หา txrtcPaidDate ล่าสุด (earliest TXRTC date = วันที่ชำระปิดค่างวด)
          const txrtcDates = closeDatesByContract.get(key) ?? [];
          // ใช้ date ที่เก่าที่สุด (earliest) เพราะ TXRTC แรกคือวันที่ชำระปิดค่างวดจริง
          const txrtcPaidDate = txrtcDates.length > 0
            ? new Date(Math.min(...txrtcDates.map((d) => d.getTime())))
            : null;
          // หา dueDate ของงวด N (maxNormalPeriod)
          const instList = instByContract.get(key) ?? [];
          const periodNRow = instList.find((r) => Number(r.period ?? 0) === maxNormalPeriod);
          const dueDateN = periodNRow?.due_date ? new Date(periodNRow.due_date) : null;
          if (txrtcPaidDate && dueDateN && !isNaN(txrtcPaidDate.getTime()) && !isNaN(dueDateN.getTime())) {
            if (txrtcPaidDate < dueDateN) {
              // ชำระก่อนดิวงวด N → ปิดค่างวดตั้งแต่งวด N (ปิด N ด้วย)
              closedByContract.set(key, maxNormalPeriod - 1);
            } else {
              // ชำระถึงหรือหลังดิวงวด N → ปิดค่างวดตั้งแต่งวด N+1 (งวด N ยังปกติ)
              closedByContract.set(key, maxNormalPeriod);
            }
          } else {
            // Fallback: ไม่มีวันที่ → ใช้ logic เดิม
            closedByContract.set(key, maxNormalPeriod);
          }
        } else {
          // Pattern 1: maxNormal=0 → ปิดค่างวดตั้งแต่งวด 2 (ไม่เปลี่ยน)
          closedByContract.set(key, 0);
        }
      }
    }
  }

  const today = new Date();

  // --- TRUST-API MODEL ---
  // Empirical DB audit (2026-04 over Boonphone section, 2,559 payments,
  // 63 overpaid cases): 57/63 already see their next installment amount
  // reduced in `installments.amount` coming from the API, and the
  // remaining 6 cases are terminal-period / same-period overpays. So the
  // API is the authoritative source of truth for per-period `amount`,
  // `principal_due`, `interest_due`, `fee_due`. Re-computing deductions
  // client-side double-counts.
  //
  // Instead of mutating per-period amounts, we compute the DELTA against
  // the contract baseline (`contracts.installment_amount`) and expose it
  // to the UI so the operator can see "(-หักชำระเกิน: xxx)" or
  // "ปิดค่างวดแล้ว" without changing the underlying number.

  const rows = cRows.map((c) => {
    const extId = String(c.external_id);
    const list = instByContract.get(extId) ?? [];
    const totalPaid = list.reduce(
      (s, r) => s + Number(r.paid_amount ?? 0),
      0,
    );
    const totalAmount = list.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const { label: debtStatus, daysOverdue } = deriveDebtStatus(
      c.status ?? null,
      list,
      today,
    );

    const baselineAmount =
      c.installment_amount != null ? Number(c.installment_amount) : null;

    // Highest period that the customer CLOSED via a lump-sum payment.
    // Periods strictly greater than this are the ones to render as
    // "ปิดค่างวดแล้ว" with zero amounts.
    const maxClosedPeriod = closedByContract.get(extId) ?? 0;

    // --- USER RULE (2026-04-23): ระงับสัญญา / หนี้เสีย ---
    // เมื่อ contract.status = "ระงับสัญญา": หา period แรกที่ installment_status_code='ระงับสัญญา'
    // → periods >= that period ต้องแสดงเป็น "ระงับสัญญา" + ใช้ due_date ของ period นั้นเป็น suspendedAt
    // เมื่อ contract.status = "หนี้เสีย": ใช้รูปแบบเดียวกับระงับสัญญา แต่เปลี่ยนป้ายเป็น "หนี้เสีย"
    //   (per-period: override ทุก period ที่ installment_status_code เป็น ระงับสัญญา/หนี้เสีย)
    // ทั้งสองสถานะ: money fields = 0, ไม่นับเข้าเป้าเก็บหนี้
    //
    // Suspend/bad-debt detection: FF365 uses "ยกเลิกสัญญา"; Boonphone uses "ระงับสัญญา"/"หนี้เสีย".
    const contractStatus = c.status ?? null;
    const isContractSuspended = contractStatus === "ระงับสัญญา";
    const isContractBadDebt = contractStatus === "หนี้เสีย";
    const isFF365Section = params.section === "Fastfone365";
    // Phase 69: declare suspendCodes outside if-block so it's accessible in baseInstallments.map
    // FF365: "ระงับสัญญา" | "ยกเลิกสัญญา"  (FF365 stores status in i.status column, not raw_json)
    // Boonphone: "ระงับสัญญา" | "หนี้เสีย"
    const suspendCodes = isFF365Section
      ? ["ระงับสัญญา", "ยกเลิกสัญญา"]
      : ["ระงับสัญญา", "หนี้เสีย"];
    let suspendedFromPeriod = 0; // > 0 → periods >= this render as suspended
    let suspendedAt: string | null = null;
    if (isContractSuspended || isContractBadDebt) {
      // FF365 stores status in i.status (inst_status), Boonphone stores in raw_json.installment_status_code
      // Check both fields to handle both providers
      const firstSuspended = list
        .filter((r) => {
          const code = r.installment_status_code ?? r.inst_status ?? "";
          return suspendCodes.includes(code);
        })
        .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
      // Phase 71: bad debt contracts → ใช้ Phase 67/68 (TXRT receipt logic) ก่อนเสมอ
      // เพราะ firstSuspended อาจชี้งวดที่ 2 ทั้งที่ bad debt row อยู่งวด 1
      // (เช่น FF365 งวด 1 status="ยืนยันการชำระ" แต่ TXRT-1 คือยอดขายเครื่อง)
      // ระงับสัญญา: ยังใช้ firstSuspended ตามปกติ
      if (isContractBadDebt) {
        // Phase 67/68: หา suspendedFromPeriod จาก TXRT receipts
        const txrtPeriods = normalPeriodsByContractOuter.get(extId);
        const contractBadDebt = c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null;
        if (txrtPeriods && txrtPeriods.size > 0) {
          // Phase 68: exclude TXRT periods that are device sale payments (total ≈ bad_debt_amount)
          const tMap = txrtTotalByContractPeriod.get(extId);
          const normalTxrtPeriods = Array.from(txrtPeriods).filter((p) => {
            if (!contractBadDebt || contractBadDebt <= 0) return true;
            const total = tMap?.get(p) ?? 0;
            return Math.abs(total - contractBadDebt) > 1; // not a device sale payment
          });
          const maxTxrtPeriod = normalTxrtPeriods.length > 0
            ? Math.max(...normalTxrtPeriods)
            : 0;
          suspendedFromPeriod = maxTxrtPeriod + 1;
          // suspendedAt = due_date of the period at suspendedFromPeriod
          const suspendedPeriodRow = list
            .filter((r) => Number(r.period ?? 0) === suspendedFromPeriod)
            .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
          suspendedAt = suspendedPeriodRow?.due_date ?? null;
          // If no row for that period, fall back to last normal TXRT period's due_date
          if (!suspendedAt && maxTxrtPeriod > 0) {
            const lastTxrtRow = list
              .filter((r) => Number(r.period ?? 0) === maxTxrtPeriod)
              .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
            suspendedAt = lastTxrtRow?.due_date ?? null;
          }
        } else {
          // No TXRT receipt_no → use close_installment_amount sum to compute suspendedFromPeriod
          // Phase 68B: sum(close_installment_amount of non-device-sale payments) / installment_amount
          // Phase 111 Iron Rule: ใช้ badDebtPeriod จาก ยอดเก็บหนี้ โดยตรง
          //   - closeSum = 0 (ไม่มี normal payments) → suspendedFromPeriod = 1
          //   - closeSum > 0 (มี normal payments) → suspendedFromPeriod = closedPeriods + 1
          //   ไม่ fallback ไป firstSuspended.period เพราะ installment_status อาจชี้งวดผิด
          const contractInstAmt = c.installment_amount != null ? Number(c.installment_amount) : 0;
          const closeSum = closeAmtSumByContract.get(extId) ?? 0;
          if (contractInstAmt > 0 && closeSum > 0) {
            // มี normal payments: Count how many full installments were closed
            const closedPeriods = Math.round(closeSum / contractInstAmt);
            suspendedFromPeriod = closedPeriods + 1;
            // Find due_date of suspendedFromPeriod
            const suspendedPeriodRow = list
              .filter((r) => Number(r.period ?? 0) === suspendedFromPeriod)
              .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
            suspendedAt = suspendedPeriodRow?.due_date ?? null;
            if (!suspendedAt && closedPeriods > 0) {
              const lastClosedRow = list
                .filter((r) => Number(r.period ?? 0) === closedPeriods)
                .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
              suspendedAt = lastClosedRow?.due_date ?? null;
            }
          } else {
            // Phase 111: ไม่มี normal payments (closeSum=0) → bad-debt บันทึกที่งวด 1
            // ไม่ใช้ firstSuspended.period เพราะ installment_status อาจชี้งวดผิด
            const firstPeriod = list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
            suspendedFromPeriod = 1;
            suspendedAt = firstPeriod?.due_date ?? null;
          }
        }
      } else if (firstSuspended?.period) {
        // ระงับสัญญา: ใช้ firstSuspended ตามปกติ
        suspendedFromPeriod = Number(firstSuspended.period);
        suspendedAt = firstSuspended.due_date ?? null;
      } else {
        // Phase 9AK fallback: ระงับสัญญา ไม่มี installment status ตรงกับ suspendCodes
        const firstPeriod = list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
        if (firstPeriod) {
          suspendedFromPeriod = 1;
          suspendedAt = firstPeriod.due_date ?? null;
        }
      }
      // For bad-debt contracts, the effective "status-change date" is
      // the LAST payment that arrived while the contract was still in
      // ระงับสัญญา (i.e. after `suspendedAt`). Falls back to
      // `suspendedAt` when no such payment exists.
      if (isContractBadDebt && suspendedAt) {
        const paidAts = paidAtsByContract.get(extId) ?? [];
        suspendedAt = deriveBadDebtDate(
          paidAts.map((t) => ({ paid_at: t })),
          suspendedAt,
        );
      }
    }

    // Build installment schedule.
    //
    // USER RULE (2026-04-23):
    //   ଇ Past/current periods must ALWAYS show the baseline amount — even
    //     after the customer has fully paid them. The collections team uses
    //     this report as "ยอดตั้งเก็บ" for the month, not "ยอดค้างชำระ".
    //   ଇ EXCEPTION: if a previous period generated an overpaid carry that
    //     got applied to THIS period, the API already reduced `amount`
    //     (e.g. baseline 4097 → amount 3944 when 153 was carried). We
    //     keep the reduced amount so the real outstanding is shown, and
    //     surface the delta via `overpaidApplied` for UI annotation.
    //   ଇ POST-CLOSE: periods strictly AFTER `maxClosedPeriod` render as
    //     "ปิดค่างวดแล้ว" with zero amounts.
    //
    // API observation (see scripts/audit-overpaid-carry.mjs):
    //   ଇ Boonphone sets `amount = 0` for the period where the customer
    //     paid in full AND also generated an overpaid carry (i.e. the
    //     overpaid is booked against that very period's row). Before the
    //     carry appears, the period would simply have amount=baseline and
    //     paid_amount=baseline. So when we see `amount=0, paid>0` outside
    //     of post-close, we restore baseline so the operator still sees the
    //     full monthly target.
    const baseInstallments = list
      .map((r) => {
        const rawAmount = Number(r.amount ?? 0);
        const rawPrincipal = Number(r.principal_due ?? 0);
        const rawInterest = Number(r.interest_due ?? 0);
        const rawFee = Number(r.fee_due ?? 0);
        const rawPenalty = Number(r.penalty_due ?? 0);
        const rawUnlockFee = Number(r.unlock_fee_due ?? 0);
        const paid = Number(r.paid_amount ?? 0);
        const periodNo = r.period != null ? Number(r.period) : 0;

        // Phase 73: เช็คสถานะสัญญาก่อน แล้วค่อยใช้เงื่อนไขของสถานะนั้น (ไม่ mix logic ข้ามสถานะ)
        //
        // สถานะ 1: หนี้เสีย (isContractBadDebt)
        //   → งวด >= suspendedFromPeriod → isSuspended = true, isClosed = false
        //   → งวด < suspendedFromPeriod → ยอดปกติ
        //
        // สถานะ 2: ระงับสัญญา (isContractSuspended)
        //   → งวด >= suspendedFromPeriod + (instStatusIsSuspend || paid <= 0) → isSuspended = true
        //   → งวดที่ชำระแล้ว (paid > 0) → ยอดปกติ
        //
        // สถานะ 3: สิ้นสุดสัญญา (closedByContract.has)
        //   → งวด > maxClosedPeriod + paid <= 0 → isClosed = true
        //   → งวด 1 ยอดปกติเสมอ, Pattern 3 → ยอดปกติทั้งหมด
        //
        // สถานะ 4: ปกติ → ยอดปกติทั้งหมด
        const instStatusIsSuspend = suspendCodes.includes(r.installment_status_code ?? "") ||
          suspendCodes.includes((r as any).inst_status ?? "");

        let isClosed = false;
        let isSuspended = false;
        let suspendLabel = "";

        if (isContractBadDebt) {
          // สถานะหนี้เสีย: งวด >= suspendedFromPeriod → หนี้เสียทุกงวด (ไม่สนใจ isClosed)
          isSuspended = suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod;
          suspendLabel = "หนี้เสีย";
        } else if (isContractSuspended) {
          // สถานะระงับสัญญา: งวด >= suspendedFromPeriod และยังไม่ชำระ → ระงับสัญญา
          isSuspended = suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod &&
            (instStatusIsSuspend || paid <= 0);
          suspendLabel = "ระงับสัญญา";
        } else {
          // สถานะสิ้นสุดสัญญา / ปกติ: ใช้ TXRTC logic
          // Phase 62: 3-pattern isClosed
          // maxClosedPeriod = -1 → Pattern 3 (ยอดปกติทั้งหมด)
          // maxClosedPeriod = 0  → Pattern 1 (งวด 1 ยอดปกติ, งวด 2+ ปิดค่างวด)
          // maxClosedPeriod = N  → Pattern 2 (งวด 1..N ยอดปกติ, งวด N+1+ ปิดค่างวด)
          // Phase 65: งวดที่มี paid > 0 ให้แสดงยอดปกติเสมอ
          // Phase 74: ลบ paid<=0 guard — TXRTC close contracts ต้องแสดง isClosed เสมอ
          // ไม่ว่า paid จะเป็นเท่าไหร่ (เช่น งวด 8 ของ CT0225-SRI001-9292-01 มี paid=1550 แต่ถูกปิดด้วย TXRTC)
          // closedByContract.has(extId) รับประกันว่าสัญญานี้มี TXRTC close payment จริง
          isClosed = closedByContract.has(extId)
            && maxClosedPeriod !== -1
            && periodNo > 1
            && periodNo > maxClosedPeriod;
        }
        // --- Compute display amount (non-closed periods) ---
        let amount = rawAmount;
        let principal = rawPrincipal;
        let interest = rawInterest;
        let fee = rawFee;
        let penalty = rawPenalty;
        let unlockFee = rawUnlockFee;

        // Case A: API sent amount=0 but paid>0 (classic zeroed-by-api case)
        const paidInFullButZeroedByApi =
          !isClosed &&
          rawAmount <= 0.009 &&
          paid > 0.009 &&
          baselineAmount != null &&
          baselineAmount > 0;
        // Case B (Phase 9AC): API sent amount < baseline AND paid >= amount
        // (customer paid the reduced amount in full, but we should display baseline
        // so the collections team sees the full monthly target, not the reduced amount).
        // Example: baseline=2830, API amount=350 (penalty only), paid=2830
        // → netBaseline = max(0, 350-350) = 0 → sub-fields all zero → wrong.
        // Fix: treat as paidInFull and restore baseline sub-fields.
        const paidInFullWithReducedAmount =
          !isClosed &&
          !paidInFullButZeroedByApi &&
          rawAmount > 0.009 &&
          baselineAmount != null &&
          baselineAmount > 0 &&
          rawAmount < baselineAmount - 0.5 && // API amount is significantly less than baseline
          paid >= rawAmount - 0.5;            // customer paid the reduced amount in full
        const useBaselineDisplay = paidInFullButZeroedByApi || paidInFullWithReducedAmount;

        // overpaidApplied:: ยอดชำระเกินจากงวดก่อนหน้า (P-1) ที่นำมาหักงวดนี้
        // Bug fix (Phase 9AB): overpaidApplied is sourced from raw_json.overpaid_amount
        // of the PREVIOUS period's payment row.
        //
        // Phase 9AF fix: Two sub-cases for useBaselineDisplay:
        //   A) paidInFullWithReducedAmount: API already reduced amount (e.g. 4097→3944).
        //      → Do NOT apply overpaidApplied again (would double-deduct).
        //   B) paidInFullButZeroedByApi: API zeroed amount because customer paid in full.
        //      → If previous period had overpaid, we MUST still apply the carry-forward
        //        because the API did NOT reduce the next period's amount in this case.
        //        Example: CT0226-SNI001-0978-01 period 1 overpaid=1010, period 2 amount=0
        //        (zeroed by API after payment), so we must show baseline-1010=980.
        let overpaidApplied = 0;
        if (!isClosed && periodNo > 1) {
          // Skip carry-forward only when API already reduced the amount (paidInFullWithReducedAmount)
          // For paidInFullButZeroedByApi, we still apply carry so baseline display is reduced.
          const skipCarry = paidInFullWithReducedAmount;
          if (!skipCarry) {
            const periodMap = overpaidByContractPeriod.get(extId);
            if (periodMap) {
              overpaidApplied = periodMap.get(periodNo - 1) ?? 0;
            }
          }
        }

        if (isClosed || isSuspended) {
          amount = 0;
          principal = 0;
          interest = 0;
          fee = 0;
          penalty = 0;
          unlockFee = 0;
        } else {
          // --- Phase 9X: Formula-based principal/interest + overpaid deduction + API penalty/unlockFee ---
          //
          // principal/interest/fee คำนวณจากสูตร:
          //   basePrincipal = ceil(finance_amount / installment_count)
          //   baseFee       = 100 (ตายตัวต่องวด)
          //   baseInterest  = baseline_amount - basePrincipal - baseFee
          //
          // ถ้างวดก่อนหน้าจ่ายเกิน (overpaidApplied > 0) ให้หักออกจากยอดงวดนี้:
          //   effectiveBaseline = max(0, baseline - overpaidApplied)
          //   แล้วปรับ principal/interest ตามสัดส่วน
          //
          // penalty/unlockFee ดึงจาก API *_due โดยตรง
          //
          // isArrears = มี penalty_due > 0 หรือ unlock_fee_due > 0

          const financeAmt = c.finance_amount != null ? Number(c.finance_amount) : 0;
          const periods = c.installment_count != null ? Number(c.installment_count) : 0;
          const baseline = baselineAmount ?? 0;

          // Step 1: Compute formula baseline sub-fields
          let basePrincipal: number;
          let baseFee: number;
          let baseInterest: number;
          if (financeAmt > 0 && periods > 0) {
            basePrincipal = Math.ceil(financeAmt / periods);
            baseFee = 100;
            baseInterest = Math.max(0, baseline - basePrincipal - baseFee);
          } else {
            // Fallback: ใช้ค่าจาก API *_due
            basePrincipal = rawPrincipal;
            baseFee = rawFee > 0 ? rawFee : 100;
            baseInterest = rawInterest;
          }

          // Step 2: Apply overpaid deduction from previous period
          // Phase 48: ลำดับการหัก ดอกเบี้ย → ค่าดำเนินการ → เงินต้น
          let effectiveInterest = baseInterest;
          let effectiveFee = baseFee;
          let effectivePrincipal = basePrincipal;
          if (overpaidApplied > 0.009) {
            let rem = overpaidApplied;
            // 1) หักดอกเบี้ยก่อน
            const dInt = Math.min(rem, effectiveInterest);
            effectiveInterest = Math.max(0, effectiveInterest - dInt);
            rem = Math.max(0, rem - dInt);
            // 2) หักค่าดำเนินการ
            const dFee = Math.min(rem, effectiveFee);
            effectiveFee = Math.max(0, effectiveFee - dFee);
            rem = Math.max(0, rem - dFee);
            // 3) หักเงินต้น
            effectivePrincipal = Math.max(0, effectivePrincipal - rem);
          }

          // Step 3: penalty/unlockFee from API *_due
          // Bug 3 fix (Phase 9AA): future periods (dueDate > today) must show 0
          // for penalty/unlockFee — API may send non-zero values for future periods
          // but they are not yet overdue charges.
          const dueDateForPenalty = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
          const isFuturePeriod = dueDateForPenalty > today.getTime();
          penalty   = isFuturePeriod ? 0 : rawPenalty;   // penalty_due
          unlockFee = isFuturePeriod ? 0 : rawUnlockFee; // unlock_fee_due

          // Step 4: Determine final amount and scale sub-fields to fit
          if (useBaselineDisplay) {
            // Paid in full (API zeroed amount OR API sent reduced amount): restore baseline
            // Use integer values (no scaling needed — baseline sub-fields are already integers)
            principal = basePrincipal;
            interest  = baseInterest;
            fee       = baseFee;
            amount    = baseline;
            // Phase 9AF: For paidInFullButZeroedByApi (NOT paidInFullWithReducedAmount),
            // the API did NOT reduce the next period's amount, so we must apply overpaidApplied
            // to show the correct reduced baseline. Example: period 2 baseline=1990, overpaid
            // carry from period 1=1010 → display 980 (not 1990).
            //
            // Phase 9AG fix: When overpaidApplied >= baseline (the entire period was covered
            // by overpaid carry from a previous payment), do NOT reduce amount to 0.
            // This happens when a single TXRT payment covers multiple periods (e.g. TXRT-1
            // pays 2×baseline). The overpaid pool fully covers this period, so we should
            // still display the full baseline so the collections team sees the monthly target.
            if (paidInFullButZeroedByApi && overpaidApplied > 0.009 && overpaidApplied < baseline - 0.5) {
              // Phase 48: Apply carry in order: interest → fee → principal
              principal = Math.round(effectivePrincipal);
              interest  = Math.round(effectiveInterest);
              fee       = Math.round(effectiveFee);
              amount    = principal + interest + fee;
            }
            // else: overpaidApplied >= baseline (full period covered by carry) OR overpaidApplied=0
            // → keep amount = baseline (already set above at line 1519)
          } else {
            // Use API amount as source of truth (it already includes penalty+unlockFee)
            // Derive principal/interest/fee from formula scaled to fit (amount - penalty - unlockFee)
            const apiAmount = rawAmount > 0.009 ? rawAmount : null;
            const baselineForCalc = apiAmount != null ? apiAmount : baseline;
            const netBaseline = Math.max(0, baselineForCalc - penalty - unlockFee);

            // Scale formula sub-fields to fit netBaseline
            // Phase 48: ใช้ effective values (หัก overpaid แล้ว) ทั้ง 3 fields
            fee       = Math.round(effectiveFee);
            principal = Math.round(effectivePrincipal);
            interest  = Math.round(effectiveInterest);

            // Phase 24 fix: if API amount equals baseline (API did NOT reduce it for overpaid carry),
            // we must deduct overpaidApplied from the displayed amount so the UI shows the correct
            // reduced target. Example: CT0226-SBR001-0909-01 period 2: apiAmount=2094 (=baseline),
            // overpaidApplied=50 → display 2044 (not 2094).
            const apiEqualsBaseline = apiAmount != null && Math.abs(apiAmount - baseline) < 0.5;
            const applyCarryToAmount = overpaidApplied > 0.009 && apiEqualsBaseline;
            amount = apiAmount != null
              ? (applyCarryToAmount ? Math.max(0, apiAmount - overpaidApplied) : apiAmount)
              : principal + interest + fee + penalty + unlockFee;
          }

          // isArrears = มีค่าปรับหรือค่าปลดล็อก **เฉพาะงวดที่ผ่านมาแล้ว/ปัจจุบัน** (dueDate <= today)
          // งวดอนาคต: API อาจส่ง unlock_fee_due > 0 มาด้วย แต่ยังไม่ถึงกำหนดจึงไม่นับเป็นค้างชำระ
          const todayForArrears = new Date();
          todayForArrears.setHours(0, 0, 0, 0);
          const dueDateMs = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
          const isPastOrCurrent = dueDateMs <= todayForArrears.getTime();
          const hasArrears = isPastOrCurrent && (rawPenalty > 0.005 || rawUnlockFee > 0.005);
          (r as any)._hasArrears = hasArrears;
        }

        return {
          period: r.period ?? null,
          dueDate: r.due_date ?? null,
          principal,
          interest,
          fee,
          penalty,
          unlockFee,
          amount,
          // Phase 9AH: netAmount = principal+interest+fee only (no penalty/unlockFee).
          // Frontend uses this for principalOnly display so it never needs to subtract
          // penalty from amount (which may or may not include penalty depending on period).
          netAmount: principal + interest + fee,
          paid,
          baselineAmount: baselineAmount ?? 0,
          overpaidApplied,
          // Legacy fields kept for export compatibility.
          principalDeducted: 0,
          interestDeducted: 0,
          feeDeducted: 0,
          isClosed,
          isSuspended,
          suspendLabel: isSuspended ? suspendLabel : null,
          suspendedAt: isSuspended ? suspendedAt : null,
          // isArrears: true when any *_due field > 0 (API-based, no carry pass needed)
          isArrears: (r as any)._hasArrears === true,
          // isCurrentPeriod: will be set to true for the current period in the arrears pass below
          isCurrentPeriod: false,
          // isPaid: true when this period has been fully paid (principal reduced to 0).
          // Conditions:
          //   1. API sent amount=0 and paid>0 (API zeroed because fully paid)
          //   2. paid >= rawAmount (paid amount covers the API amount)
          // Note: isClosed periods are NOT isPaid — they use grey styling, not green.
          isPaid: !isClosed && !isSuspended && (
            (rawAmount <= 0.009 && paid > 0.009) ||
            (rawAmount > 0.009 && paid >= rawAmount - 0.5)
          ),
        };
      })
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    // --- Arrears pass (Phase 9Z) ---
    // กฎ:
    //   1. isArrears = เฉพาะ "งวดปัจจุบัน" เท่านั้น
    //      งวดปัจจุบัน = งวดแรก (period ต่ำสุด) ที่ dueDate <= today
    //                    และ paid < amount (ยังไม่จ่ายครบ)
    //                    และ !isClosed && !isSuspended
    //   2. penalty ของงวดปัจจุบัน = sum penalty ของทุกงวดที่ dueDate <= today
    //      (รวมค่าปรับคงค้างทุกงวดที่ผ่านมา)
    //   3. unlockFee ของงวดปัจจุบัน = max unlockFee ของทุกงวดที่ dueDate <= today
    //      (ค่าปลดล็อกไม่ทบ แต่ค้างข้ามงวดได้)
    {
      const todayMs = Date.now();
      // Reset all isArrears (was set per-period in map above, now we re-derive)
      for (const inst of baseInstallments) {
        inst.isArrears = false;
      }
      // Find the "current period": the LATEST (highest period no) past/current period
      // that is not closed/suspended.
      // Phase 14 fix: previously used .find() which returned the FIRST (lowest) unpaid period,
      // causing the highlight to stay on period 1 even when period 2 due_date had already passed.
      // Now we pick the period with the highest period number among all past/current periods,
      // regardless of paid status. Overdue earlier periods are shown as-is (no special highlight).
      const currentPeriod = baseInstallments
        .filter((inst) => {
          if (inst.isClosed || inst.isSuspended) return false;
          if (!inst.dueDate) return false;
          const dueMs = Date.parse(`${inst.dueDate}T00:00:00`);
          return dueMs <= todayMs; // past or today (not future)
        })
        .sort((a, b) => Number(b.period ?? 0) - Number(a.period ?? 0))[0] ?? null;
      if (currentPeriod) {
        const currentPeriodNo = Number(currentPeriod.period ?? 0);
        // Sum penalty from all past/current periods BEFORE currentPeriod (dueDate <= today)
        // Bug 1 fix (Phase 9AA): only count penalty from PRIOR periods, not currentPeriod itself.
        // This prevents period 1 from being flagged as isArrears when it only has its own penalty_due.
        const priorPenalty = baseInstallments.reduce((sum, inst) => {
          if (inst.isClosed || inst.isSuspended) return sum;
          if (!inst.dueDate) return sum;
          const dueMs = Date.parse(`${inst.dueDate}T00:00:00`);
          if (dueMs > todayMs) return sum;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return sum; // skip current+future
          return sum + Number(inst.penalty ?? 0);
        }, 0);
        // Max unlockFee from all prior past/current periods (ค่าปลดล็อกไม่ทบ)
        const priorUnlockFee = baseInstallments.reduce((max, inst) => {
          if (inst.isClosed || inst.isSuspended) return max;
          if (!inst.dueDate) return max;
          const dueMs = Date.parse(`${inst.dueDate}T00:00:00`);
          if (dueMs > todayMs) return max;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return max; // skip current+future
          return Math.max(max, Number(inst.unlockFee ?? 0));
        }, 0);
        // isArrears = true ONLY when there are PRIOR periods with penalty/unlockFee carry.
        // Phase 9Z + Bug1 fix: do NOT set isArrears just because currentPeriod is unpaid.
        // isArrears is a UI signal that accumulated charges from PREVIOUS periods are
        // being carried into the current period. A first-time overdue period (no prior carry)
        // should NOT be flagged as isArrears — it is simply overdue (shown by dueDate color).
        const hasCarryFromPrior = priorPenalty > 0.005 || priorUnlockFee > 0.005;
        currentPeriod.isArrears = hasCarryFromPrior;
        // Total penalty = prior carry + currentPeriod's own penalty_due
        const ownPenalty = Number(currentPeriod.penalty ?? 0);
        const ownUnlockFee = Number(currentPeriod.unlockFee ?? 0);
        const totalPenalty = priorPenalty + ownPenalty;
        const totalUnlockFee = Math.max(priorUnlockFee, ownUnlockFee);
        currentPeriod.penalty = totalPenalty;
        currentPeriod.unlockFee = totalUnlockFee;
        // Recalculate amount for current period to include accumulated charges
        // Bug fix (Phase 9AB): when baseNet=0 (API sent amount=0 for an unpaid period),
        // fall back to baselineAmount so the total is not just penalty alone.
        // Phase 49 fix: do NOT fallback to baselineAmount when overpaidApplied > 0
        // because baseNet=0 in that case means overpaid covered all components (correct),
        // not that API sent 0 erroneously. Fallback only when overpaidApplied=0.
        const baseNet = currentPeriod.principal + currentPeriod.interest + currentPeriod.fee;
        const noOverpaid = (currentPeriod.overpaidApplied ?? 0) < 0.009;
        const effectiveBase = baseNet > 0.009
          ? baseNet
          : (noOverpaid && currentPeriod.baselineAmount > 0.009 ? currentPeriod.baselineAmount : baseNet);
        currentPeriod.amount = effectiveBase + totalPenalty + totalUnlockFee;
        // Phase 9AH: keep netAmount in sync (netAmount = principal+interest+fee, no penalty)
        currentPeriod.netAmount = effectiveBase;
        // Mark this as the current period for UI highlighting
        currentPeriod.isCurrentPeriod = true;
      }
    }

    return {
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      approveDate: c.approve_date ?? null,
      customerName: c.customer_name ?? null,
      phone: c.phone ?? null,
      productType: c.product_type ?? null,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : list.length,
      installmentAmount: c.installment_amount != null ? Number(c.installment_amount) : null,
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments: baseInstallments,
      // bad debt info from contracts table (used by listDebtCollected for tooltip + real payment filtering)
      contractBadDebtAmount: c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null,
      contractBadDebtDate: c.bad_debt_date ?? null,
      financeAmount: c.finance_amount != null ? Number(c.finance_amount) : null,
      commissionNet: c.commission_net != null ? Number(c.commission_net) : null,
    };
  });

  return { rows };
}

/**
 * Return the dataset used by the "ยอดเก็บหนี้" tab.
 * One entry per contract + array of actual payments grouped by the
 * installment period they closed (`close_installment_amount` / derived).
 */
export async function listDebtCollected(params: { section: SectionKey }) {
  const db = await getDb();
  if (!db) return { rows: [] as any[] };

  // Reuse target list for shared summary columns & debt-status derivation.
  const { rows: baseRows } = await listDebtTarget(params);

  // Both Boonphone and Fastfone365 use the same payment transactions endpoint.
  // payment_transactions.raw_json contains the same fields for both sections.
  const payRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           external_id AS payment_external_id,
           paid_at,
           CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.principal_paid')           AS DECIMAL(18,2)) AS principal_paid,
           CAST(JSON_EXTRACT(raw_json, '$.interest_paid')            AS DECIMAL(18,2)) AS interest_paid,
           CAST(JSON_EXTRACT(raw_json, '$.fee_paid')                 AS DECIMAL(18,2)) AS fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_paid')             AS DECIMAL(18,2)) AS penalty_paid,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')          AS DECIMAL(18,2)) AS unlock_fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.discount_amount')          AS DECIMAL(18,2)) AS discount_amount,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')          AS DECIMAL(18,2)) AS overpaid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
           CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')          AS DECIMAL(18,2)) AS bad_debt_amount,
           CAST(JSON_EXTRACT(raw_json, '$.payment_id')               AS UNSIGNED) AS payment_id,
           NULL AS installment_external_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark,
           status AS ff_status
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
     ORDER BY contract_external_id, paid_at, payment_id
  `);
  const pRows: any[] = (payRowsRaw as any)[0] ?? payRowsRaw;

  const payByContract = new Map<string, PayRawRow[]>();
  for (const r of pRows) {
    const key = String(r.contract_external_id ?? "");
    if (!key) continue;
    if (!payByContract.has(key)) payByContract.set(key, []);

    payByContract.get(key)!.push({
      contract_external_id: key,
      period: null, // period is derived by assignPayPeriods for both Boonphone and FF365
      // payment_external_id: numeric string = real payment from API, "pay-{id}-{n}" = synthetic
      payment_external_id: r.payment_external_id ?? null,
      paid_at: r.paid_at ?? null,
      total_paid_amount:
        r.total_paid_amount != null ? Number(r.total_paid_amount) : null,
      principal_paid:
        r.principal_paid != null ? Number(r.principal_paid) : null,
      interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
      fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
      penalty_paid: r.penalty_paid != null ? Number(r.penalty_paid) : null,
      unlock_fee_paid:
        r.unlock_fee_paid != null ? Number(r.unlock_fee_paid) : null,
      discount_amount:
        r.discount_amount != null ? Number(r.discount_amount) : null,
      overpaid_amount:
        r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
      close_installment_amount:
        r.close_installment_amount != null
          ? Number(r.close_installment_amount)
          : null,
      bad_debt_amount:
        r.bad_debt_amount != null ? Number(r.bad_debt_amount) : null,
      payment_id: r.payment_id != null ? Number(r.payment_id) : null,
      receipt_no: r.receipt_no ?? null,
      remark: r.remark ?? null,
      // FF365 only: raw status from payment_transactions
      ff_status: r.ff_status ?? null,
    } as any);
  }

  // Per-contract walk.
  // Both Boonphone and Fastfone365 use the same logic:
  //   - Use only real payments (external_id is numeric) from the API
  //   - Synthetic payments (pay-{id}-{n}) are excluded
  //   - bad_debt_amount from contracts table drives isBadDebtRow detection
  const rows = baseRows.map((c) => {
    const rawPayments = payByContract.get(c.contractExternalId) ?? [];
    let tagged: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }>;

    let contractBadDebtAmount = (c as any).contractBadDebtAmount as number | null;
    let contractBadDebtDate = (c as any).contractBadDebtDate as string | null;

    // Use only real payments from the API.
    // Real payments are identified by:
    //   1. Numeric payment_external_id (Boonphone/FF365 standard)
    //   2. TXRT receipt pattern (TXRT...-N) — FF365 contracts without numeric pay_ext_id
    // Synthetic payments (pay-{id}-{n}) are excluded.
    const realPaymentsRaw = rawPayments.filter((p) => {
      const payExtId = (p as any).payment_external_id as string | null;
      const receiptNo = (p as any).receipt_no as string | null;
      const isNumericPayExt = payExtId != null && /^\d+$/.test(payExtId);
      const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
      return isNumericPayExt || isTxrtReceipt;
    });

    // Phase 106: Universal bad-debt rule (replaces Phase 87 + Phase 104).
    // For ALL contracts with debtStatus = "หนี้เสีย":
    //   - Find the LATEST paid_at date across all real payments.
    //   - SUM all real payments on that latest date → bad_debt_amount.
    //   - All other payments (earlier dates) → normal installment columns.
    //   - No conditions, no exceptions.
    //
    // Special cases:
    //   Ex.1: Only 1 payment → that payment = bad_debt_amount, other columns = 0.
    //   Ex.2: Multiple payments, latest date has 1 payment → that payment = bad_debt_amount.
    //   Ex.3: Multiple payments on the same latest date → SUM of all = bad_debt_amount.
    let isPhase87Fallback = false;
    if (c.debtStatus === "หนี้เสีย" && realPaymentsRaw.length > 0) {
      // Find the latest paid_at date (date portion only, YYYY-MM-DD)
      const sortedReal = [...realPaymentsRaw].sort((a, b) => {
        const da = ((a as any).paid_at ?? "").substring(0, 10);
        const db2 = ((b as any).paid_at ?? "").substring(0, 10);
        return da < db2 ? 1 : da > db2 ? -1 : 0;
      });
      const latestDate = ((sortedReal[0] as any).paid_at ?? "").substring(0, 10);
      // Sum all payments on the latest date
      const latestDatePayments = sortedReal.filter(
        (p) => ((p as any).paid_at ?? "").substring(0, 10) === latestDate,
      );
      const latestDateTotal = latestDatePayments.reduce(
        (sum, p) => sum + Number((p as any).total_paid_amount ?? 0),
        0,
      );
      contractBadDebtAmount = latestDateTotal;
      contractBadDebtDate = latestDate || null;
      isPhase87Fallback = true; // use firstSuspendedPeriod for badDebtPeriod assignment
    }

    if (contractBadDebtAmount != null && contractBadDebtAmount > 0 && contractBadDebtDate) {
      // Contract has bad debt: build tooltip and create 1 bad debt row.
      let badDebtNote: string | null = null;
      const d = new Date(`${contractBadDebtDate}T00:00:00`);
      const day = String(d.getDate()).padStart(2, "0");
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const year = d.getFullYear() + 543;
      badDebtNote = `ยอดขายเครื่อง ${contractBadDebtAmount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} บาท (${day}/${month}/${year})`;

      // Phase 106: normalPayments = all real payments EXCEPT those on the latest date
      // (the latest-date payments are the bad-debt / device-sale row).
      // Phase 63 fix: ใช้ installmentAmount เป็น fallback เมื่อ amount=0
      const baselineAmt = c.installmentAmount ?? 0;
      // Filter out latest-date payments before assigning periods
      const normalPaymentsRaw = realPaymentsRaw.filter(
        (p) => ((p as any).paid_at ?? "").substring(0, 10) !== contractBadDebtDate,
      );
      const realAssignedForBadDebt = assignPayPeriods(
        normalPaymentsRaw,
        c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) > 0 ? Number(i.amount) : baselineAmt })),
        c.contractNo ?? null,
      );
      const normalPayments = realAssignedForBadDebt;

      // Phase 106/110: badDebtPeriod calculation (Iron Rule)
      // Rule 1: ถ้าไม่มี normal payments เลย → badDebtPeriod = 1 (งวดแรก)
      // Rule 2: ถ้ามี normal payments → badDebtPeriod = lastNormalPeriod + 1
      // (ไม่ใช้ firstSuspendedPeriod จาก installments เพราะอาจชี้งวดผิด เช่น งวด 3 ทั้งที่ลูกค้าไม่เคยจ่ายเลย)
      let badDebtPeriod: number;
      let lastNormalPeriod = 0;
      for (const p of normalPayments) {
        if (p.period != null && p.period > lastNormalPeriod) lastNormalPeriod = p.period;
      }
      if (lastNormalPeriod === 0) {
        // ไม่มียอดชำระปกติเลย → bad-debt บันทึกที่งวด 1
        badDebtPeriod = 1;
      } else {
        // มียอดชำระปกติ → bad-debt บันทึกที่งวดถัดไปต่อจากงวดสุดท้ายที่ชำระปกติ
        badDebtPeriod = lastNormalPeriod + 1;
      }
      // Phase 55: patch installments so periods < badDebtPeriod show normal amounts.
      // งวดที่ลูกค้าจ่ายปกติก่อนหนี้เสีย ให้ตั้งหนี้ตามปกติ
      // เฉพาะงวดที่ >= badDebtPeriod เท่านั้นที่แสดงเป็นหนี้เสีย
      c.installments = c.installments.map((inst: any) => {
        const pNo = inst.period ?? 0;
        if (pNo > 0 && pNo < badDebtPeriod && inst.isSuspended) {
          return { ...inst, isSuspended: false, suspendLabel: null, suspendedAt: null };
        }
        return inst;
      });

      const badDebtRow: any = {
        contract_external_id: c.contractExternalId,
        period: badDebtPeriod,
        splitIndex: 0,
        isCloseRow: false,
        isBadDebtRow: true,
        paid_at: contractBadDebtDate,
        principal_paid: 0,
        interest_paid: 0,
        fee_paid: 0,
        penalty_paid: 0,
        unlock_fee_paid: 0,
        discount_amount: 0,
        overpaid_amount: 0,
        close_installment_amount: 0,
        bad_debt_amount: contractBadDebtAmount,
        total_paid_amount: 0,
        payment_id: null,
        receipt_no: null,
        remark: null,
        ff_status: null,
        payment_external_id: null,
        badDebtNote,
      };

      tagged = [
        ...normalPayments.map((p) => ({ ...p, isBadDebtRow: false })),
        badDebtRow,
      ];
    } else {
      // No bad debt: use real payments only, assign periods normally.
      // Phase 63 fix: ใช้ installmentAmount เป็น fallback เมื่อ amount=0
      // (listDebtTarget ตั้ง amount=0 สำหรับงวดที่ isClosed=true ซึ่งทำให้ assignPayPeriods ไม่ advance cursor)
      const baselineAmtNoBd = c.installmentAmount ?? 0;
      const realAssigned = assignPayPeriods(
        realPaymentsRaw,
        c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) > 0 ? Number(i.amount) : baselineAmtNoBd })),
        c.contractNo ?? null,
      );
      tagged = realAssigned.map((p) => ({ ...p, isBadDebtRow: false }));
    }
    // Phase 63: สร้าง carry rows สำหรับงวดที่ถูก skip เพราะ overpaid
    // ตรวจสอบ gaps ใน periods ของ tagged payments
    // ถ้ามี gap (เช่น period 2 แล้วข้ามไป period 5) ให้สร้าง carry rows สำหรับงวด 3, 4
    {
      const baselineAmount = c.installmentAmount ?? 0;
      if (baselineAmount > 0) {
        // หา periods ที่มีอยู่ใน tagged (เฉพาะ non-close, non-badDebt)
        const existingPeriods = new Set<number>();
        for (const p of tagged) {
          if (p.period != null && !p.isCloseRow && !p.isBadDebtRow) {
            existingPeriods.add(p.period);
          }
        }
        const normalPeriods = Array.from(existingPeriods).sort((a, b) => a - b);
        const maxNormal = normalPeriods.length > 0 ? normalPeriods[normalPeriods.length - 1] : 0;
        // สร้าง carry rows สำหรับ gaps ระหว่าง 1 ถึง maxNormal
        if (maxNormal > 1) {
          const carryRows: Array<typeof tagged[0]> = [];
          for (let pNo = 1; pNo <= maxNormal; pNo++) {
            if (!existingPeriods.has(pNo)) {
              // หา payment ก่อน gap นี้ (period < pNo) ที่มี overpaid
              const prevPayments = tagged
                .filter((p) => p.period != null && p.period < pNo && !p.isCloseRow && !p.isBadDebtRow)
                .sort((a, b) => (b.period ?? 0) - (a.period ?? 0));
              const sourcePayment = prevPayments[0];
              const carryPaidAt = sourcePayment?.paid_at ?? null;
              const carryRow: typeof tagged[0] = {
                contract_external_id: c.contractExternalId,
                period: pNo,
                splitIndex: 0,
                isCloseRow: false,
                isBadDebtRow: false,
                paid_at: carryPaidAt,
                total_paid_amount: 0,
                principal_paid: 0,
                interest_paid: 0,
                fee_paid: 0,
                penalty_paid: 0,
                unlock_fee_paid: 0,
                discount_amount: 0,
                overpaid_amount: 0,
                close_installment_amount: 0,
                bad_debt_amount: 0,
                payment_id: null,
                receipt_no: "(carry)",
                remark: `(-หักชำระเกิน: ${baselineAmount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`,
                ff_status: null,
                payment_external_id: null,
              } as any;
              carryRows.push(carryRow);
            }
          }
          if (carryRows.length > 0) {
            // รวม carry rows เข้าไปใน tagged แล้ว sort ตาม period
            tagged = [...tagged, ...carryRows].sort((a, b) => {
              const pa = a.period ?? 9999;
              const pb = b.period ?? 9999;
              if (pa !== pb) return pa - pb;
              // carry rows ให้อยู่หลัง normal rows ของ period เดียวกัน
              const aIsCarry = (a as any).receipt_no === "(carry)";
              const bIsCarry = (b as any).receipt_no === "(carry)";
              if (aIsCarry && !bIsCarry) return 1;
              if (!aIsCarry && bIsCarry) return -1;
              return (a.splitIndex ?? 0) - (b.splitIndex ?? 0);
            });
          }
        }
      }
    }
    return {
      ...c,
      payments: tagged.map((p) => ({
        period: p.period ?? null,
        splitIndex: p.splitIndex,
        isCloseRow: p.isCloseRow,
        isBadDebtRow: p.isBadDebtRow,
        paidAt: p.paid_at,
        principal: p.principal_paid ?? 0,
        interest: p.interest_paid ?? 0,
        fee: p.fee_paid ?? 0,
        penalty: p.penalty_paid ?? 0,
        unlockFee: p.unlock_fee_paid ?? 0,
        discount: p.discount_amount ?? 0,
        overpaid: p.overpaid_amount ?? 0,
        closeInstallmentAmount: p.close_installment_amount ?? 0,
        badDebt: p.bad_debt_amount ?? 0,
        total: p.total_paid_amount ?? 0,
        receiptNo: p.receipt_no ?? null,
        remark: p.remark ?? null,
        // tooltip สำหรับ bad debt rows: "ยอดขายเครื่อง X บาท (DD/MM/YYYY)"
        badDebtNote: (p as any).badDebtNote ?? null,
      })),
    };
  });

  // hasPrincipalBreakdown: true = both Boonphone and Fastfone365 now have full breakdown
  //   (principal_paid, interest_paid, fee_paid, penalty_paid, etc. from payment transactions API)
  return { rows, hasPrincipalBreakdown: true };
}

/**
 * Streaming variant of listDebtTarget.
 *
 * Phase 43: แก้ Cloudflare 100s hard timeout โดยส่ง rows ทีละ batch ระหว่างคำนวณ
 * แทนที่จะรอ compute ทั้งหมดก่อนส่ง
 *
 * Strategy:
 *   1. Load ALL DB data upfront (contracts + installments + payments) — 1 round-trip
 *   2. Process contracts ทีละ BATCH_SIZE แล้ว yield batch ทันที
 *   3. ใช้ setImmediate ระหว่าง batch เพื่อ yield event loop ให้ Express flush chunk
 *
 * Caller (debtStream.ts) ต้อง:
 *   - เขียน opening `{"rows":[` ก่อน iterate
 *   - เขียน `,` ระหว่าง rows
 *   - เขียน closing `]}` หลัง iterate เสร็จ
 */
export async function* listDebtTargetStream(params: {
  section: SectionKey;
  /** rows per yield (default 100) */
  batchSize?: number;
}): AsyncGenerator<any[], void, unknown> {
  const BATCH = params.batchSize ?? 100;
  const db = await getDb();
  if (!db) return;

  // --- Load contract headers ---
  const contractRowsRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           installment_count,
           installment_amount,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           status,
           product_type,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date,
           CAST(commission_net AS DECIMAL(18,2)) AS commission_net
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
       AND (status IS NULL OR status != 'ยกเลิกสัญญา')
  `);
  const cRows: Array<any> = (contractRowsRaw as any)[0] ?? contractRowsRaw;
  if (!cRows.length) return;

  // --- Load installments ---
  const instRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           external_id,
           period,
           due_date,
           CAST(amount AS DECIMAL(18,2))       AS amount,
           CAST(paid_amount AS DECIMAL(18,2))  AS paid_amount,
           status AS inst_status,
           CAST(JSON_EXTRACT(raw_json, '$.principal_due') AS DECIMAL(18,2)) AS principal_due,
           CAST(JSON_EXTRACT(raw_json, '$.interest_due')  AS DECIMAL(18,2)) AS interest_due,
           CAST(JSON_EXTRACT(raw_json, '$.fee_due')       AS DECIMAL(18,2)) AS fee_due,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_due')    AS DECIMAL(18,2)) AS penalty_due,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_due')  AS DECIMAL(18,2)) AS unlock_fee_due,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS installment_status_code,
           CAST(JSON_EXTRACT(raw_json, '$.balance') AS DECIMAL(18,2)) AS balance
      FROM ${installments}
     WHERE ${installments.section} = ${params.section}
     ORDER BY contract_external_id, period
  `);
  const iRows: InstRawRow[] = (instRowsRaw as any)[0] ?? instRowsRaw;

  const instByContract = new Map<string, InstRawRow[]>();
  for (const r of iRows) {
    const key = String(r.contract_external_id);
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key)!.push({
      contract_external_id: key,
      external_id: r.external_id != null ? String(r.external_id) : null,
      period: r.period != null ? Number(r.period) : null,
      due_date: r.due_date ?? null,
      amount: r.amount != null ? Number(r.amount) : null,
      paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
      inst_status: r.inst_status ?? null,
      principal_due: r.principal_due != null ? Number(r.principal_due) : null,
      interest_due: r.interest_due != null ? Number(r.interest_due) : null,
      fee_due: r.fee_due != null ? Number(r.fee_due) : null,
      penalty_due: r.penalty_due != null ? Number(r.penalty_due) : null,
      unlock_fee_due: r.unlock_fee_due != null ? Number(r.unlock_fee_due) : null,
      installment_status_code: r.installment_status_code ?? null,
      balance: r.balance != null ? Number(r.balance) : null,
    });
  }

  // --- Dedup installments per period (DB may have 2 rows per period) ---
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, dedupInstByPeriod(list));
  }
  // Fix out-of-order due_dates
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, fixOutOfOrderDueDates(list));
  }

  // --- Load payments (for close detection + paidAts) ---
  // Phase 52 rule: close period = last period with paid_amount > 0 in installments.
  const closedByContract = new Map<string, number>();
  const overpaidByContractPeriod = new Map<string, Map<number, number>>();
  const paidAtsByContract = new Map<string, string[]>();
  // Phase 67: TXRT normal receipt suffix periods per contract (for bad-debt suspendedFromPeriod fallback)
  const normalPeriodsByContract = new Map<string, Set<number>>();
  // Phase 68: track total_paid_amount per TXRT suffix per contract (to detect device sale payments)
  const txrtTotalByContractPeriodStream = new Map<string, Map<number, number>>();
  // Phase 68B: sum of close_installment_amount per contract (excluding device sale payments)
  const closeAmtSumByContractStream = new Map<string, number>();
  const closePayTotalByContractStream = new Map<string, number[]>();

  // Phase 74: Build contractNo lookup for correct receipt period parsing (stream version)
  const contractNoByExtIdStream = new Map<string, string>();
  for (const cr of cRows) {
    const k = String(cr.external_id ?? "");
    if (k && cr.contract_no) contractNoByExtIdStream.set(k, String(cr.contract_no));
  }
  function parseTxrtPeriodStream(receipt: string, contractExtId: string): number {
    const contractNo = contractNoByExtIdStream.get(contractExtId);
    if (contractNo) {
      const prefix = "TXRT" + contractNo.replace(/^CT/, "") + "-";
      if (receipt.startsWith(prefix)) {
        const suffix = receipt.slice(prefix.length);
        const firstSegment = suffix.split("-")[0];
        const p = Number(firstSegment);
        if (Number.isFinite(p) && p > 0) return p;
      }
    }
    const m = /-(\d+)$/.exec(receipt);
    return m ? Number(m[1]) : 0;
  }

  {
    // Extra query: get close_installment_amount for ALL payments (no receipt_no filter)
    // Phase 110 (stream): include paid_at so we can exclude bad-debt-date payments from closeSum
    const rawCloseAmtData = await db.execute(sql`
      SELECT contract_external_id,
             CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
             CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
             DATE(paid_at) AS paid_date
        FROM ${paymentTransactions}
       WHERE ${paymentTransactions.section} = ${params.section}
         AND JSON_EXTRACT(raw_json, '$.close_installment_amount') IS NOT NULL
         AND CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
    `);
    const closeAmtRows: any[] = (rawCloseAmtData as any)[0] ?? rawCloseAmtData;
    // First pass: collect total_paid_amounts per contract
    for (const row of closeAmtRows) {
      const key = String(row.contract_external_id ?? "");
      if (!key) continue;
      const totalPaid = Number(row.total_paid_amount ?? 0);
      const tList = closePayTotalByContractStream.get(key) ?? [];
      tList.push(totalPaid);
      closePayTotalByContractStream.set(key, tList);
    }
    // Second pass: accumulate close_installment_amount, excluding bad-debt-date payments and device sale payments
    const badDebtAmtByContractStream = new Map<string, number>();
    const badDebtDateByContractStream = new Map<string, string>(); // YYYY-MM-DD
    for (const cr of cRows) {
      const k = String(cr.external_id ?? "");
      if (k && cr.bad_debt_amount != null) badDebtAmtByContractStream.set(k, Number(cr.bad_debt_amount));
      if (k && cr.bad_debt_date != null) {
        // Normalize to YYYY-MM-DD string
        const d = cr.bad_debt_date instanceof Date
          ? cr.bad_debt_date.toISOString().slice(0, 10)
          : String(cr.bad_debt_date).slice(0, 10);
        badDebtDateByContractStream.set(k, d);
      }
    }
    for (const row of closeAmtRows) {
      const key = String(row.contract_external_id ?? "");
      if (!key) continue;
      const totalPaid = Number(row.total_paid_amount ?? 0);
      const closeAmt = Number(row.close_installment_amount ?? 0);
      const badDebt = badDebtAmtByContractStream.get(key) ?? 0;
      const badDebtDate = badDebtDateByContractStream.get(key) ?? null;
      // Phase 110 (stream): Skip payments on bad_debt_date (these are bad-debt payments, not normal installments)
      if (badDebtDate) {
        const paidDate = row.paid_date ? String(row.paid_date).slice(0, 10) : null;
        if (paidDate && paidDate === badDebtDate) continue;
      }
      // Skip device sale payments (total ≈ bad_debt_amount)
      if (badDebt > 0 && Math.abs(totalPaid - badDebt) <= 1) continue;
      closeAmtSumByContractStream.set(key, (closeAmtSumByContractStream.get(key) ?? 0) + closeAmt);
    }
  }

  {
    // Phase 78 (stream): same as listDebtTarget — use assignPayPeriods to derive correct period
    // instead of parseTxrtPeriodStream suffix parsing.
    const rawCloseData = await db.execute(sql`
      SELECT contract_external_id,
             external_id AS payment_external_id,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
             CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount,
             CAST(JSON_EXTRACT(raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
             CAST(JSON_EXTRACT(raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
             CAST(JSON_EXTRACT(raw_json, '$.fee_paid') AS DECIMAL(18,2)) AS fee_paid,
             CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
             CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount') AS DECIMAL(18,2)) AS bad_debt_amount,
             CAST(JSON_EXTRACT(raw_json, '$.payment_id') AS UNSIGNED) AS payment_id,
             CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
             paid_at
        FROM ${paymentTransactions}
       WHERE ${paymentTransactions.section} = ${params.section}
         AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) IS NOT NULL
    `);
    const allPayRows: any[] = (rawCloseData as any)[0] ?? rawCloseData;
    const closeDatesByContract = new Map<string, Date[]>();
    // Phase 78: group raw payment rows by contract for assignPayPeriods
    const rawPaysByContractStream = new Map<string, PayRawRow[]>();

    for (const pr of allPayRows) {
      const key = String(pr.contract_external_id ?? "");
      if (!key) continue;
      if (pr.paid_at) {
        const arr = paidAtsByContract.get(key) ?? [];
        arr.push(String(pr.paid_at));
        paidAtsByContract.set(key, arr);
      }
      const receipt = String(pr.receipt_no ?? "");
      if (receipt.startsWith("TXRTC")) {
        const dt = pr.paid_at ? new Date(pr.paid_at) : null;
        if (dt && !isNaN(dt.getTime())) {
          const list = closeDatesByContract.get(key) ?? [];
          list.push(dt);
          closeDatesByContract.set(key, list);
        }
      }
      // Phase 78: collect all payments for assignPayPeriods
      const payRow: PayRawRow = {
        contract_external_id: key,
        period: null,
        paid_at: pr.paid_at ?? null,
        total_paid_amount: pr.total_paid_amount != null ? Number(pr.total_paid_amount) : null,
        principal_paid: pr.principal_paid != null ? Number(pr.principal_paid) : null,
        interest_paid: pr.interest_paid != null ? Number(pr.interest_paid) : null,
        fee_paid: pr.fee_paid != null ? Number(pr.fee_paid) : null,
        penalty_paid: null,
        unlock_fee_paid: null,
        discount_amount: null,
        overpaid_amount: pr.overpaid_amount != null ? Number(pr.overpaid_amount) : null,
        close_installment_amount: pr.close_installment_amount != null ? Number(pr.close_installment_amount) : null,
        bad_debt_amount: pr.bad_debt_amount != null ? Number(pr.bad_debt_amount) : null,
        receipt_no: pr.receipt_no ?? null,
        remark: null,
        payment_id: pr.payment_id != null ? Number(pr.payment_id) : null,
      };
      const arr2 = rawPaysByContractStream.get(key) ?? [];
      arr2.push(payRow);
      rawPaysByContractStream.set(key, arr2);
    }

    // Phase 78: For each contract with TXRTC (สิ้นสุดสัญญา), use assignPayPeriods
    // Phase 78 fix: build baseline map for fallback when installment.amount=0 (isClosed periods)
    const baselineByKeyPhase78Stream = new Map<string, number>();
    for (const cr of cRows) {
      const k = String(cr.external_id ?? "");
      if (k && cr.installment_amount != null) {
        baselineByKeyPhase78Stream.set(k, Number(cr.installment_amount));
      }
    }

    for (const key of Array.from(closeDatesByContract.keys())) {
      const instList = instByContract.get(key) ?? [];
      if (!instList.length) continue;
      const contractNo = contractNoByExtIdStream.get(key) ?? null;
      const rawPays = rawPaysByContractStream.get(key) ?? [];
      const realPays = rawPays.filter((p) => {
        const payExtId = String((p as any).payment_external_id ?? "");
        const receiptNo = p.receipt_no ?? "";
        return /^\d+$/.test(payExtId) || /^TXRT.*-\d+$/.test(receiptNo);
      });
      // Phase 78 fix: use installment_amount as fallback when amount=0 (isClosed periods)
      const baselineAmt78Stream = baselineByKeyPhase78Stream.get(key) ?? 0;
      const assigned = assignPayPeriods(
        realPays,
        instList.map((i) => {
          const amt = Number(i.amount ?? 0);
          return { period: i.period, amount: amt > 0 ? amt : baselineAmt78Stream };
        }),
        contractNo,
      );
      const periodSet = new Set<number>();
      for (const ap of assigned) {
        if (ap.isCloseRow || ap.isBadDebtRow) continue;
        const period = ap.period;
        if (period == null || period <= 0) continue;
        periodSet.add(period);
        const totalPaidForPeriod = Number(ap.total_paid_amount ?? 0);
        if (totalPaidForPeriod > 0) {
          let tMap = txrtTotalByContractPeriodStream.get(key);
          if (!tMap) { tMap = new Map<number, number>(); txrtTotalByContractPeriodStream.set(key, tMap); }
          tMap.set(period, (tMap.get(period) ?? 0) + totalPaidForPeriod);
        }
        const overpaid = Number(ap.overpaid_amount ?? 0);
        if (overpaid > 0) {
          let periodMap = overpaidByContractPeriod.get(key);
          if (!periodMap) {
            periodMap = new Map<number, number>();
            overpaidByContractPeriod.set(key, periodMap);
          }
          periodMap.set(period, (periodMap.get(period) ?? 0) + overpaid);
        }
      }
      if (periodSet.size > 0) normalPeriodsByContract.set(key, periodSet);
    }

    // Phase 78 fallback: contracts WITHOUT TXRTC — use parseTxrtPeriodStream for bad-debt logic
    for (const pr of allPayRows) {
      const key = String(pr.contract_external_id ?? "");
      if (!key) continue;
      if (closeDatesByContract.has(key)) continue; // already processed by assignPayPeriods
      const receipt = String(pr.receipt_no ?? "");
      if (receipt.startsWith("TXRTC")) continue;
      const period = parseTxrtPeriodStream(receipt, key);
      if (!Number.isFinite(period) || period <= 0) continue;
      const set = normalPeriodsByContract.get(key) ?? new Set<number>();
      set.add(period);
      normalPeriodsByContract.set(key, set);
      const totalPaidForPeriod = Number(pr.total_paid_amount ?? 0);
      if (totalPaidForPeriod > 0) {
        let tMap = txrtTotalByContractPeriodStream.get(key);
        if (!tMap) { tMap = new Map<number, number>(); txrtTotalByContractPeriodStream.set(key, tMap); }
        tMap.set(period, (tMap.get(period) ?? 0) + totalPaidForPeriod);
      }
      // Phase 85: Validate overpaid against INST_BASE paid_amount.
      // Suffix-based period assignment (TXRT-N → period N) can be wrong when a payment
      // covers the REMAINING balance of an earlier period (e.g. TXRT-2 closes period 1
      // remainder, not period 2). In that case the INST_BASE for period N will show
      // paid_amount < amount (not fully paid), which means the suffix-based assignment
      // is incorrect and the overpaid_amount belongs to a different period.
      //
      // Phase 85 revised: Two-step check:
      // 1. If INST_BASE[period] is fully paid → track overpaid at period (normal case).
      // 2. If INST_BASE[period] is NOT fully paid but INST_BASE[period-1] IS fully paid
      //    → TXRT-N actually closed period N-1 remainder, so overpaid belongs to period N.
      //    Track overpaid at period (same period N, which is where the carry lands).
      // 3. If neither → skip (suffix assignment is wrong in an unresolvable way).
      const overpaid = Number(pr.overpaid_amount ?? 0);
      if (overpaid > 0) {
        const instListForKey = instByContract.get(key) ?? [];
        const instRow = instListForKey.find((r) => Number(r.period ?? 0) === period);
        const instBaseAmount = instRow ? Number(instRow.amount ?? 0) : 0;
        const instBasePaid = instRow ? Number(instRow.paid_amount ?? 0) : 0;
        const instIsPaid =
          (instBaseAmount < 0.009 && instBasePaid > 0.009) ||
          (instBaseAmount > 0.009 && instBasePaid >= instBaseAmount - 0.5);
        // Phase 85 step 2: check prior period (period-1) when current period is not fully paid
        const priorInstRow = !instIsPaid && period > 1
          ? instListForKey.find((r) => Number(r.period ?? 0) === period - 1)
          : null;
        const priorBaseAmount = priorInstRow ? Number(priorInstRow.amount ?? 0) : 0;
        const priorBasePaid = priorInstRow ? Number(priorInstRow.paid_amount ?? 0) : 0;
        const priorIsPaid = priorInstRow &&
          ((priorBaseAmount < 0.009 && priorBasePaid > 0.009) ||
           (priorBaseAmount > 0.009 && priorBasePaid >= priorBaseAmount - 0.5));
        if (instIsPaid || priorIsPaid) {
          let periodMap = overpaidByContractPeriod.get(key);
          if (!periodMap) {
            periodMap = new Map<number, number>();
            overpaidByContractPeriod.set(key, periodMap);
          }
          // Phase 85b fix: when priorIsPaid (TXRT-N closed prior period remainder),
          // track at period-1 so carry-forward correctly applies overpaid at period N.
          // (e.g. TXRT-2 closes period 1 remainder + overpaid 50 -> track at 1 -> apply at 2)
          const trackPeriod = instIsPaid ? period : period - 1;
          periodMap.set(trackPeriod, (periodMap.get(trackPeriod) ?? 0) + overpaid);
        }
      }
    }

    // Phase 64: Cascade overpaid carry-forward across periods (same logic as listDebtTarget)
    {
      const baselineByKey = new Map<string, number>();
      for (const cr of cRows) {
        const k = String(cr.external_id ?? "");
        if (k && cr.installment_amount != null) {
          baselineByKey.set(k, Number(cr.installment_amount));
        }
      }
      for (const [key, periodMap] of Array.from(overpaidByContractPeriod.entries())) {
        const baseline = baselineByKey.get(key) ?? 0;
        if (baseline <= 0) continue;
        const periods = Array.from(periodMap.keys()).sort((a, b) => a - b);
        for (const p of periods) {
          const overpaid = periodMap.get(p) ?? 0;
          if (overpaid > baseline + 0.5) {
            const excess = overpaid - baseline;
            periodMap.set(p + 1, (periodMap.get(p + 1) ?? 0) + excess);
          }
        }
      }
    }

    // Pass 2 (Phase 62): 3-pattern isClosed logic based on TXRTC position
    // Pattern 1: maxNormal=0 → stored as 0 (งวด 1 ยอดปกติ, งวด 2+ ปิดค่างวด)
    // Pattern 2: 1 < maxNormal < totalPeriods → stored as N (งวด N+1+ ปิดค่างวด)
    // Pattern 3: maxNormal >= totalPeriods → stored as -1 (ยอดปกติทั้งหมด)
    const installCountByKeyStream = new Map<string, number>();
    for (const cr of cRows) {
      const k = String(cr.external_id ?? "");
      if (k) installCountByKeyStream.set(k, cr.installment_count != null ? Number(cr.installment_count) : 0);
    }
    for (const key of Array.from(closeDatesByContract.keys())) {
      const normalPeriods = normalPeriodsByContract.get(key);
      const maxNormalPeriod = normalPeriods && normalPeriods.size > 0
        ? Math.max(...Array.from(normalPeriods))
        : 0;
      const totalPeriods = installCountByKeyStream.get(key) ?? 0;
      if (totalPeriods > 0 && maxNormalPeriod >= totalPeriods) {
        closedByContract.set(key, -1); // Pattern 3: ยอดปกติทั้งหมด
      } else {
        // Phase 84: Pattern 2 — ใช้ txrtcPaidDate vs dueDate(N) เพื่อตัดสิน boundary
        if (maxNormalPeriod > 0) {
          const txrtcDates = closeDatesByContract.get(key) ?? [];
          const txrtcPaidDate = txrtcDates.length > 0
            ? new Date(Math.min(...txrtcDates.map((d) => d.getTime())))
            : null;
          const instList = instByContract.get(key) ?? [];
          const periodNRow = instList.find((r) => Number(r.period ?? 0) === maxNormalPeriod);
          const dueDateN = periodNRow?.due_date ? new Date(periodNRow.due_date) : null;
          if (txrtcPaidDate && dueDateN && !isNaN(txrtcPaidDate.getTime()) && !isNaN(dueDateN.getTime())) {
            if (txrtcPaidDate < dueDateN) {
              // ชำระก่อนดิวงวด N → ปิดค่างวดตั้งแต่งวด N (ปิด N ด้วย)
              closedByContract.set(key, maxNormalPeriod - 1);
            } else {
              // ชำระถึงหรือหลังดิวงวด N → ปิดค่างวดตั้งแต่งวด N+1 (งวด N ยังปกติ)
              closedByContract.set(key, maxNormalPeriod);
            }
          } else {
            closedByContract.set(key, maxNormalPeriod);
          }
        } else {
          // Pattern 1: maxNormal=0 → ปิดค่างวดตั้งแต่งวด 2
          closedByContract.set(key, 0);
        }
      }
    }
  }

  const today = new Date();

  // --- Process contracts in batches, yield each batch ---
  // Reuse the same per-contract logic from listDebtTarget
  function processContract(c: any): any {
    const extId = String(c.external_id);
    const list = instByContract.get(extId) ?? [];
    const totalPaid = list.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0);
    const totalAmount = list.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const { label: debtStatus, daysOverdue } = deriveDebtStatus(c.status ?? null, list, today);
    const baselineAmount = c.installment_amount != null ? Number(c.installment_amount) : null;
    const maxClosedPeriod = closedByContract.get(extId) ?? 0;
    const contractStatus = c.status ?? null;
    const isContractSuspended = contractStatus === "ระงับสัญญา";
    const isContractBadDebt = contractStatus === "หนี้เสีย";
    const isFF365SectionStream = params.section === "Fastfone365";
    // Phase 69: declare suspendCodes outside if-block so it's accessible in baseInstallments.map
    const suspendCodes = isFF365SectionStream
      ? ["ระงับสัญญา", "ยกเลิกสัญญา"]
      : ["ระงับสัญญา", "หนี้เสีย"];
    let suspendedFromPeriod = 0;
    let suspendedAt: string | null = null;
    if (isContractSuspended || isContractBadDebt) {
      // FF365 stores status in i.status (inst_status), Boonphone stores in raw_json.installment_status_code
      // Check both fields to handle both providers (suspendCodes declared above)
      const firstSuspended = list
        .filter((r) => {
          const code = r.installment_status_code ?? r.inst_status ?? "";
          return suspendCodes.includes(code);
        })
        .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
      // Phase 71: bad debt contracts → ใช้ Phase 67/68 (TXRT receipt logic) ก่อนเสมอ
      // เพราะ firstSuspended อาจชี้งวดที่ 2 ทั้งที่ bad debt row อยู่งวด 1
      // (เช่น FF365 งวด 1 status="ยืนยันการชำระ" แต่ TXRT-1 คือยอดขายเครื่อง)
      // ระงับสัญญา: ยังใช้ firstSuspended ตามปกติ
      if (isContractBadDebt) {
        // Phase 67/68: หา suspendedFromPeriod จาก TXRT receipts
        const txrtPeriods = normalPeriodsByContract.get(extId);
        const contractBadDebt = c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null;
        if (txrtPeriods && txrtPeriods.size > 0) {
          // Phase 68: exclude TXRT periods that are device sale payments (total ≈ bad_debt_amount)
          const tMap = txrtTotalByContractPeriodStream.get(extId);
          const normalTxrtPeriods = Array.from(txrtPeriods).filter((p) => {
            if (!contractBadDebt || contractBadDebt <= 0) return true;
            const total = tMap?.get(p) ?? 0;
            return Math.abs(total - contractBadDebt) > 1;
          });
          const maxTxrtPeriod = normalTxrtPeriods.length > 0
            ? Math.max(...normalTxrtPeriods)
            : 0;
          suspendedFromPeriod = maxTxrtPeriod + 1;
          const suspendedPeriodRow = list
            .filter((r) => Number(r.period ?? 0) === suspendedFromPeriod)
            .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
          suspendedAt = suspendedPeriodRow?.due_date ?? null;
          if (!suspendedAt && maxTxrtPeriod > 0) {
            const lastTxrtRow = list
              .filter((r) => Number(r.period ?? 0) === maxTxrtPeriod)
              .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
            suspendedAt = lastTxrtRow?.due_date ?? null;
          }
        } else {
          // Phase 68B: No TXRT receipt_no → use close_installment_amount sum
          // Phase 111 Iron Rule: ใช้ badDebtPeriod จาก ยอดเก็บหนี้ โดยตรง
          //   - closeSum = 0 (ไม่มี normal payments) → suspendedFromPeriod = 1
          //   - closeSum > 0 (มี normal payments) → suspendedFromPeriod = closedPeriods + 1
          //   ไม่ fallback ไป firstSuspended.period เพราะ installment_status อาจชี้งวดผิด
          const contractInstAmt = c.installment_amount != null ? Number(c.installment_amount) : 0;
          const closeSum = closeAmtSumByContractStream.get(extId) ?? 0;
          if (contractInstAmt > 0 && closeSum > 0) {
            // มี normal payments: Count how many full installments were closed
            const closedPeriods = Math.round(closeSum / contractInstAmt);
            suspendedFromPeriod = closedPeriods + 1;
            const suspendedPeriodRow = list
              .filter((r) => Number(r.period ?? 0) === suspendedFromPeriod)
              .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
            suspendedAt = suspendedPeriodRow?.due_date ?? null;
            if (!suspendedAt && closedPeriods > 0) {
              const lastClosedRow = list
                .filter((r) => Number(r.period ?? 0) === closedPeriods)
                .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
              suspendedAt = lastClosedRow?.due_date ?? null;
            }
          } else {
            // Phase 111: ไม่มี normal payments (closeSum=0) → bad-debt บันทึกที่งวด 1
            // ไม่ใช้ firstSuspended.period เพราะ installment_status อาจชี้งวดผิด
            const firstPeriod = list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
            suspendedFromPeriod = 1;
            suspendedAt = firstPeriod?.due_date ?? null;
          }
        }
      } else if (firstSuspended?.period) {
        // ระงับสัญญา: ใช้ firstSuspended ตามปกติ
        suspendedFromPeriod = Number(firstSuspended.period);
        suspendedAt = firstSuspended.due_date ?? null;
      } else {
        // Phase 9AK fallback: ระงับสัญญา ไม่มี installment status ตรงกับ suspendCodes
        const firstPeriod = list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
        if (firstPeriod) {
          suspendedFromPeriod = 1;
          suspendedAt = firstPeriod.due_date ?? null;
        }
      }
      if (isContractBadDebt && suspendedAt) {
        const paidAts = paidAtsByContract.get(extId) ?? [];
        suspendedAt = deriveBadDebtDate(
          paidAts.map((t) => ({ paid_at: t })),
          suspendedAt,
        );
      }
    }

    const baseInstallments = list
      .map((r) => {
        const rawAmount = Number(r.amount ?? 0);
        const rawPrincipal = Number(r.principal_due ?? 0);
        const rawInterest = Number(r.interest_due ?? 0);
        const rawFee = Number(r.fee_due ?? 0);
        const rawPenalty = Number(r.penalty_due ?? 0);
        const rawUnlockFee = Number(r.unlock_fee_due ?? 0);
        const paid = Number(r.paid_amount ?? 0);
        const periodNo = r.period != null ? Number(r.period) : 0;
        // Phase 73: เช็คสถานะสัญญาก่อน แล้วค่อยใช้เงื่อนไขของสถานะนั้น (ไม่ mix logic ข้ามสถานะ)
        //
        // สถานะ 1: หนี้เสีย (isContractBadDebt)
        //   → งวด >= suspendedFromPeriod → isSuspended = true, isClosed = false
        //   → งวด < suspendedFromPeriod → ยอดปกติ
        //
        // สถานะ 2: ระงับสัญญา (isContractSuspended)
        //   → งวด >= suspendedFromPeriod + (instStatusIsSuspend || paid <= 0) → isSuspended = true
        //   → งวดที่ชำระแล้ว (paid > 0) → ยอดปกติ
        //
        // สถานะ 3: สิ้นสุดสัญญา (closedByContract.has)
        //   → งวด > maxClosedPeriod + paid <= 0 → isClosed = true
        //   → งวด 1 ยอดปกติเสมอ, Pattern 3 → ยอดปกติทั้งหมด
        //
        // สถานะ 4: ปกติ → ยอดปกติทั้งหมด
        const instStatusIsSuspendStream = suspendCodes.includes(r.installment_status_code ?? "") ||
          suspendCodes.includes((r as any).inst_status ?? "");

        let isClosed = false;
        let isSuspended = false;
        let suspendLabel = "";

        if (isContractBadDebt) {
          // สถานะหนี้เสีย: งวด >= suspendedFromPeriod → หนี้เสียทุกงวด (ไม่สนใจ isClosed)
          isSuspended = suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod;
          suspendLabel = "หนี้เสีย";
        } else if (isContractSuspended) {
          // สถานะระงับสัญญา: งวด >= suspendedFromPeriod และยังไม่ชำระ → ระงับสัญญา
          isSuspended = suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod &&
            (instStatusIsSuspendStream || paid <= 0);
          suspendLabel = "ระงับสัญญา";
        } else {
          // สถานะสิ้นสุดสัญญา / ปกติ: ใช้ TXRTC logic
          // Phase 62: 3-pattern isClosed
          // maxClosedPeriod = -1 → Pattern 3 (ยอดปกติทั้งหมด)
          // maxClosedPeriod = 0  → Pattern 1 (งวด 1 ยอดปกติ, งวด 2+ ปิดค่างวด)
          // maxClosedPeriod = N  → Pattern 2 (งวด 1..N ยอดปกติ, งวด N+1+ ปิดค่างวด)
          // Phase 74: ลบ paid<=0 guard — TXRTC close contracts ต้องแสดง isClosed เสมอ
          isClosed = closedByContract.has(extId)
            && maxClosedPeriod !== -1
            && periodNo > 1
            && periodNo > maxClosedPeriod;
        }
        let amount = rawAmount;
        let principal = rawPrincipal;
        let interest = rawInterest;
        let fee = rawFee;
        let penalty = rawPenalty;
        let unlockFee = rawUnlockFee;
        const paidInFullButZeroedByApi = !isClosed && rawAmount <= 0.009 && paid > 0.009 && baselineAmount != null && baselineAmount > 0;
        const paidInFullWithReducedAmount = !isClosed && !paidInFullButZeroedByApi && rawAmount > 0.009 && baselineAmount != null && baselineAmount > 0 && rawAmount < baselineAmount - 0.5 && paid >= rawAmount - 0.5;
        const useBaselineDisplay = paidInFullButZeroedByApi || paidInFullWithReducedAmount;
        let overpaidApplied = 0;
        if (!isClosed && periodNo > 1) {
          const skipCarry = paidInFullWithReducedAmount;
          if (!skipCarry) {
            const periodMap = overpaidByContractPeriod.get(extId);
            if (periodMap) overpaidApplied = periodMap.get(periodNo - 1) ?? 0;
          }
        }
        if (isClosed || isSuspended) {
          amount = 0; principal = 0; interest = 0; fee = 0; penalty = 0; unlockFee = 0;
        } else {
          const financeAmt = c.finance_amount != null ? Number(c.finance_amount) : 0;
          const periods = c.installment_count != null ? Number(c.installment_count) : 0;
          const baseline = baselineAmount ?? 0;
          let basePrincipal: number, baseFee: number, baseInterest: number;
          if (financeAmt > 0 && periods > 0) {
            basePrincipal = Math.ceil(financeAmt / periods);
            baseFee = 100;
            baseInterest = Math.max(0, baseline - basePrincipal - baseFee);
          } else {
            basePrincipal = rawPrincipal;
            baseFee = rawFee > 0 ? rawFee : 100;
            baseInterest = rawInterest;
          }
          // Phase 48: ลำดับการหัก ดอกเบี้ย → ค่าดำเนินการ → เงินต้น
          let effectiveInterest = baseInterest;
          let effectiveFee = baseFee;
          let effectivePrincipal = basePrincipal;
          if (overpaidApplied > 0.009) {
            let rem = overpaidApplied;
            const dInt = Math.min(rem, effectiveInterest);
            effectiveInterest = Math.max(0, effectiveInterest - dInt);
            rem = Math.max(0, rem - dInt);
            const dFee = Math.min(rem, effectiveFee);
            effectiveFee = Math.max(0, effectiveFee - dFee);
            rem = Math.max(0, rem - dFee);
            effectivePrincipal = Math.max(0, effectivePrincipal - rem);
          }
          const dueDateForPenalty = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
          const isFuturePeriod = dueDateForPenalty > today.getTime();
          penalty = isFuturePeriod ? 0 : rawPenalty;
          unlockFee = isFuturePeriod ? 0 : rawUnlockFee;
          if (useBaselineDisplay) {
            principal = basePrincipal; interest = baseInterest; fee = baseFee; amount = baseline;
            if (paidInFullButZeroedByApi && overpaidApplied > 0.009) {
              // Phase 48: Apply carry in order: interest → fee → principal
              principal = Math.round(effectivePrincipal);
              interest = Math.round(effectiveInterest);
              fee = Math.round(effectiveFee);
              amount = principal + interest + fee;
            }
          } else {
            const apiAmount = rawAmount > 0.009 ? rawAmount : null;
            const apiEqualsBaseline = apiAmount != null && Math.abs(apiAmount - baseline) < 0.5;
            const applyCarryToAmount = overpaidApplied > 0.009 && apiEqualsBaseline;
            // Phase 48: ใช้ effective values (หัก overpaid แล้ว) ทั้ง 3 fields
            fee = Math.round(effectiveFee);
            principal = Math.round(effectivePrincipal);
            interest = Math.round(effectiveInterest);
            amount = apiAmount != null
              ? (applyCarryToAmount ? Math.max(0, apiAmount - overpaidApplied) : apiAmount)
              : principal + interest + fee + penalty + unlockFee;
          }
          const todayForArrears = new Date();
          todayForArrears.setHours(0, 0, 0, 0);
          const dueDateMs = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
          const isPastOrCurrent = dueDateMs <= todayForArrears.getTime();
          const hasArrears = isPastOrCurrent && (rawPenalty > 0.005 || rawUnlockFee > 0.005);
          (r as any)._hasArrears = hasArrears;
        }
        return {
          period: r.period ?? null, dueDate: r.due_date ?? null,
          principal, interest, fee, penalty, unlockFee, amount,
          netAmount: principal + interest + fee,
          paid, baselineAmount: baselineAmount ?? 0, overpaidApplied,
          principalDeducted: 0, interestDeducted: 0, feeDeducted: 0,
          isClosed, isSuspended,
          suspendLabel: isSuspended ? suspendLabel : null,
          suspendedAt: isSuspended ? suspendedAt : null,
          isArrears: (r as any)._hasArrears === true,
          isCurrentPeriod: false,
          // isPaid: true when this period has been fully paid (principal reduced to 0).
          // Same logic as listDebtTarget — used for green text styling in frontend.
          isPaid: !isClosed && !isSuspended && (
            (rawAmount <= 0.009 && paid > 0.009) ||
            (rawAmount > 0.009 && paid >= rawAmount - 0.5)
          ),
        };
      })
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    // Arrears pass
    {
      const todayMs = Date.now();
      for (const inst of baseInstallments) inst.isArrears = false;
      const currentPeriod = baseInstallments
        .filter((inst) => {
          if (inst.isClosed || inst.isSuspended) return false;
          if (!inst.dueDate) return false;
          return Date.parse(`${inst.dueDate}T00:00:00`) <= todayMs;
        })
        .sort((a, b) => Number(b.period ?? 0) - Number(a.period ?? 0))[0] ?? null;
      if (currentPeriod) {
        const currentPeriodNo = Number(currentPeriod.period ?? 0);
        const priorPenalty = baseInstallments.reduce((sum, inst) => {
          if (inst.isClosed || inst.isSuspended || !inst.dueDate) return sum;
          if (Date.parse(`${inst.dueDate}T00:00:00`) > todayMs) return sum;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return sum;
          return sum + Number(inst.penalty ?? 0);
        }, 0);
        const priorUnlockFee = baseInstallments.reduce((max, inst) => {
          if (inst.isClosed || inst.isSuspended || !inst.dueDate) return max;
          if (Date.parse(`${inst.dueDate}T00:00:00`) > todayMs) return max;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return max;
          return Math.max(max, Number(inst.unlockFee ?? 0));
        }, 0);
        // isArrears = true ONLY when there are PRIOR periods with penalty/unlockFee carry.
        // Phase 9Z + Bug1 fix: do NOT set isArrears just because currentPeriod is unpaid.
        const hasCarryFromPrior = priorPenalty > 0.005 || priorUnlockFee > 0.005;
        currentPeriod.isArrears = hasCarryFromPrior;
        const ownPenalty = Number(currentPeriod.penalty ?? 0);
        const ownUnlockFee = Number(currentPeriod.unlockFee ?? 0);
        currentPeriod.penalty = priorPenalty + ownPenalty;
        currentPeriod.unlockFee = Math.max(priorUnlockFee, ownUnlockFee);
        const baseNet = currentPeriod.principal + currentPeriod.interest + currentPeriod.fee;
        // Phase 49 fix: do NOT fallback to baselineAmount when overpaidApplied > 0
        // because baseNet=0 means overpaid covered all components (correct), not API error.
        const noOverpaidS = (currentPeriod.overpaidApplied ?? 0) < 0.009;
        const effectiveBase = baseNet > 0.009
          ? baseNet
          : (noOverpaidS && currentPeriod.baselineAmount > 0.009 ? currentPeriod.baselineAmount : baseNet);
        currentPeriod.amount = effectiveBase + currentPeriod.penalty + currentPeriod.unlockFee;
        currentPeriod.netAmount = effectiveBase;
        currentPeriod.isCurrentPeriod = true;
      }
    }

    return {
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      approveDate: c.approve_date ?? null,
      customerName: c.customer_name ?? null,
      phone: c.phone ?? null,
      productType: c.product_type ?? null,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : list.length,
      installmentAmount: c.installment_amount != null ? Number(c.installment_amount) : null,
      totalAmount, totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus, daysOverdue,
      installments: baseInstallments,
      contractBadDebtAmount: c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null,
      contractBadDebtDate: c.bad_debt_date ?? null,
      financeAmount: c.finance_amount != null ? Number(c.finance_amount) : null,
      commissionNet: c.commission_net != null ? Number(c.commission_net) : null,
    };
  }

  // Yield in batches
  let batch: any[] = [];
  for (const c of cRows) {
    batch.push(processContract(c));
    if (batch.length >= BATCH) {
      yield batch;
      batch = [];
      // Yield event loop so Express can flush the chunk
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (batch.length > 0) yield batch;
}

/**
 * Streaming variant of listDebtCollected.
 * Loads target rows first (via listDebtTargetStream), then streams collected rows.
 */
export async function* listDebtCollectedStream(params: {
  section: SectionKey;
  batchSize?: number;
}): AsyncGenerator<{ rows: any[]; meta?: Record<string, unknown> }, void, unknown> {
  const CONTRACT_BATCH = 500; // contracts per DB query batch (keeps memory low)
  const YIELD_BATCH = params.batchSize ?? 100; // rows per HTTP chunk
  const today = new Date(); // used by deriveDebtStatus

  const db = await getDb();
  if (!db) return;

  // Step 1: Load only contract headers (no installments) — small payload
  const contractHeadersRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           installment_count,
           CAST(installment_amount AS DECIMAL(18,2)) AS installment_amount,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           status,
           product_type,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
       AND (status IS NULL OR status != 'ยกเลิกสัญญา')
     ORDER BY external_id
  `);
  const allContractHeaders: any[] = (contractHeadersRaw as any)[0] ?? contractHeadersRaw;
  if (!allContractHeaders.length) return;

  // Step 2 + 3: Process contracts in batches — query BOTH installments AND payments per batch.
  // This avoids loading ALL 222K payment rows into memory at once (which caused OOM/503 in production).
  // Per-batch: ~100 contracts × ~15 payments = ~1,500 payment rows per query (~1MB) vs ~150MB for all.
  let yieldBatch: any[] = [];
  for (let batchStart = 0; batchStart < allContractHeaders.length; batchStart += CONTRACT_BATCH) {
    const contractBatch = allContractHeaders.slice(batchStart, batchStart + CONTRACT_BATCH);
    const batchIds = contractBatch.map((c: any) => String(c.external_id));
    // Build safe IN clause (IDs are numeric strings from the API)
    const batchIdsLiteral = batchIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
    const sectionLiteral = params.section.replace(/'/g, "''");

    // Query installments for this batch only (installments are smaller, per-batch is fine)
    // Include due_date, paid_amount, and status for deriveDebtStatus + badDebtPeriod calculation
    const instRaw = await db.execute(sql.raw(`
      SELECT contract_external_id,
             period,
             CAST(amount AS DECIMAL(18,2)) AS amount,
             due_date,
             CAST(paid_amount AS DECIMAL(18,2)) AS paid_amount,
             status,
             CAST(JSON_EXTRACT(raw_json, '$.balance') AS DECIMAL(18,2)) AS balance
        FROM installments
       WHERE section = '${sectionLiteral}'
         AND contract_external_id IN (${batchIdsLiteral})
       ORDER BY contract_external_id, period
    `));
    const instRows: any[] = (instRaw as any)[0] ?? instRaw;
    const instByContractRaw = new Map<string, Array<{ period: number | null; amount: number; due_date: string | null; paid_amount: number | null; status: string | null; balance: number | null }>>();
    for (const r of instRows) {
      const key = String(r.contract_external_id ?? "");
      if (!instByContractRaw.has(key)) instByContractRaw.set(key, []);
      instByContractRaw.get(key)!.push({
        period: r.period != null ? Number(r.period) : null,
        amount: r.amount != null ? Number(r.amount) : 0,
        due_date: r.due_date ?? null,
        paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
        status: r.status ?? null,
        balance: r.balance != null ? Number(r.balance) : null,
      });
    }
    // Dedup per period (DB may have 2 rows per period)
    const instByContract = new Map<string, Array<{ period: number | null; amount: number; due_date: string | null; paid_amount: number | null; status: string | null; balance: number | null }>>();
    for (const [key, list] of Array.from(instByContractRaw.entries())) {
      // Merge: base = row with highest amount; totalPaid = SUM of all paid_amounts per period;
      // balance: take the MIN (0 wins — row with balance=0 means fully paid).
      // (Boonphone API splits paid/due into 2 rows: amount=0/paid=X and amount=X/paid=0)
      const byPeriod = new Map<number | null, { base: { period: number | null; amount: number; due_date: string | null; paid_amount: number | null; status: string | null; balance: number | null }; totalPaid: number; minBalance: number | null }>();
      for (const row of list) {
        const p = row.period;
        const rowPaid = row.paid_amount != null ? Number(row.paid_amount) : 0;
        // Only use balance from real installment rows (amount > 0).
        // Payment-record rows (amount=0) have balance=null which should NOT override
        // the real installment's balance — doing so causes debtStatus to show overdue
        // even when the installment is fully paid.
        const rowBalance = (row.balance != null && row.amount > 0.001) ? Number(row.balance) : null;
        const existing = byPeriod.get(p);
        if (!existing) {
          byPeriod.set(p, { base: row, totalPaid: rowPaid, minBalance: rowBalance });
        } else {
          existing.totalPaid += rowPaid;
          if (row.amount > existing.base.amount) existing.base = row;
          // Keep minimum balance (0 = fully paid wins over non-null values)
          if (rowBalance !== null) {
            existing.minBalance = existing.minBalance === null ? rowBalance : Math.min(existing.minBalance, rowBalance);
          }
        }
      }
      instByContract.set(key, Array.from(byPeriod.values()).map(({ base, totalPaid, minBalance }) => ({ ...base, paid_amount: totalPaid, balance: minBalance })).sort((a, b) => (a.period ?? 0) - (b.period ?? 0)));
    }
    // Fix out-of-order due_dates (Boonphone API bug) — same correction as listDebtTargetStream.
    // Without this, deriveDebtStatus receives wrong due_dates → wrong daysOverdue → wrong debtStatus label.
    // This is the root cause of the status mismatch between "ยอดเก็บหนี้" and "เป้าเก็บหนี้".
    for (const [key, list] of Array.from(instByContract.entries())) {
      const fixed = fixOutOfOrderDueDates(list as unknown as InstRawRow[]);
      instByContract.set(key, fixed as unknown as Array<{ period: number | null; amount: number; due_date: string | null; paid_amount: number | null; status: string | null; balance: number | null }>);
    }

    // Query payments for this batch only (per-batch to avoid OOM with 222K rows)
    const payRaw = await db.execute(sql.raw(`
      SELECT contract_external_id,
             external_id AS payment_external_id,
             paid_at,
             CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
             CAST(JSON_EXTRACT(raw_json, '$.principal_paid')           AS DECIMAL(18,2)) AS principal_paid,
             CAST(JSON_EXTRACT(raw_json, '$.interest_paid')            AS DECIMAL(18,2)) AS interest_paid,
             CAST(JSON_EXTRACT(raw_json, '$.fee_paid')                 AS DECIMAL(18,2)) AS fee_paid,
             CAST(JSON_EXTRACT(raw_json, '$.penalty_paid')             AS DECIMAL(18,2)) AS penalty_paid,
             CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')          AS DECIMAL(18,2)) AS unlock_fee_paid,
             CAST(JSON_EXTRACT(raw_json, '$.discount_amount')          AS DECIMAL(18,2)) AS discount_amount,
             CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')          AS DECIMAL(18,2)) AS overpaid_amount,
             CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
             CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')          AS DECIMAL(18,2)) AS bad_debt_amount,
             CAST(JSON_EXTRACT(raw_json, '$.payment_id')               AS UNSIGNED) AS payment_id,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark,
             status AS ff_status
        FROM payment_transactions
       WHERE section = '${sectionLiteral}'
         AND contract_external_id IN (${batchIdsLiteral})
       ORDER BY contract_external_id, paid_at, payment_id
    `));
    const payRows: any[] = (payRaw as any)[0] ?? payRaw;
    const batchPayByContract = new Map<string, PayRawRow[]>();
    for (const r of payRows) {
      const key = String(r.contract_external_id ?? "");
      if (!key) continue;
      if (!batchPayByContract.has(key)) batchPayByContract.set(key, []);
      batchPayByContract.get(key)!.push({
        contract_external_id: key,
        period: null,
        payment_external_id: r.payment_external_id ?? null,
        paid_at: r.paid_at ?? null,
        total_paid_amount: r.total_paid_amount != null ? Number(r.total_paid_amount) : null,
        principal_paid: r.principal_paid != null ? Number(r.principal_paid) : null,
        interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
        fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
        penalty_paid: r.penalty_paid != null ? Number(r.penalty_paid) : null,
        unlock_fee_paid: r.unlock_fee_paid != null ? Number(r.unlock_fee_paid) : null,
        discount_amount: r.discount_amount != null ? Number(r.discount_amount) : null,
        overpaid_amount: r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
        close_installment_amount: r.close_installment_amount != null ? Number(r.close_installment_amount) : null,
        bad_debt_amount: r.bad_debt_amount != null ? Number(r.bad_debt_amount) : null,
        payment_id: r.payment_id != null ? Number(r.payment_id) : null,
        receipt_no: r.receipt_no ?? null,
        remark: r.remark ?? null,
        ff_status: r.ff_status ?? null,
      } as any);
    }

    // Process each contract in this batch
    for (const ch of contractBatch) {
      const extId = String(ch.external_id);
      // Build a contract object compatible with what listDebtTargetStream returns
      const instList = instByContract.get(extId) ?? [];
      // Compute totalAmount (sum of installment amounts) and totalPaid (sum of paid_amount)
      const totalAmount = instList.reduce((s, i) => s + (i.amount ?? 0), 0);
      const totalPaid = instList.reduce((s, i) => s + (i.paid_amount ?? 0), 0);
      // Derive debtStatus using contract status + installment due_date/paid_amount
      const instForStatus: InstRawRow[] = instList.map((i) => ({
        contract_external_id: extId,
        external_id: null,
        period: i.period,
        due_date: i.due_date,
        amount: i.amount,
        paid_amount: i.paid_amount,
        inst_status: null,
        principal_due: null,
        interest_due: null,
        fee_due: null,
        penalty_due: null,
        unlock_fee_due: null,
        installment_status_code: null,
        balance: (i as any).balance != null ? Number((i as any).balance) : null,
      }));
      const { label: debtStatus, daysOverdue } = deriveDebtStatus(ch.status ?? null, instForStatus, today);
      const c = {
        contractExternalId: extId,
        contractNo: ch.contract_no ?? null,
        approveDate: ch.approve_date ?? null,
        customerName: ch.customer_name ?? null,
        phone: ch.phone ?? null,
        productType: ch.product_type ?? null,
        installmentCount: ch.installment_count != null ? Number(ch.installment_count) : null,
        installmentAmount: ch.installment_amount != null ? Number(ch.installment_amount) : null,
        financeAmount: ch.finance_amount != null ? Number(ch.finance_amount) : null,
        status: ch.status ?? null,
        totalAmount,
        totalPaid,
        remaining: Math.max(totalAmount - totalPaid, 0),
        debtStatus,
        daysOverdue,
        contractBadDebtAmount: ch.bad_debt_amount != null ? Number(ch.bad_debt_amount) : null,
        contractBadDebtDate: ch.bad_debt_date ?? null,
        installments: instList,
      };
      // Use per-batch payments Map (loaded per batch to avoid OOM)
      const rawPayments = batchPayByContract.get(extId) ?? [];
      let contractBadDebtAmount = c.contractBadDebtAmount as number | null;
      let contractBadDebtDate = c.contractBadDebtDate as string | null;
      // Real payments: numeric pay_ext_id OR TXRT receipt pattern
      const realPaymentsRaw = rawPayments.filter((p) => {
        const payExtId = (p as any).payment_external_id as string | null;
        const receiptNo = (p as any).receipt_no as string | null;
        const isNumericPayExt = payExtId != null && /^\d+$/.test(payExtId);
        const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
        return isNumericPayExt || isTxrtReceipt;
      });

      // Phase 106 (Stream): Universal bad-debt rule — same as listDebtCollected.
      // For ALL contracts that are bad-debt AND real payments exist:
      //   - Find the LATEST paid_at date across all real payments.
      //   - SUM all real payments on that latest date → bad_debt_amount.
      //   - All other payments (earlier dates) → normal installment columns.
      // This overrides the DB bad_debt_amount (which may be null or wrong).
      //
      // A contract is considered bad-debt if:
      //   1. contract.status = "หนี้เสีย" (direct), OR
      //   2. Any installment has status = "ยกเลิกสัญญา" | "หนี้เสีย" | "ระงับสัญญา"
      //      (some contracts have status="สำเร็จ" but installments are cancelled)
      const SUSPEND_CODES_STREAM = new Set(["ยกเลิกสัญญา", "หนี้เสีย", "ระงับสัญญา"]);
      const hasSuspendedInstallment = c.installments.some((inst: any) => SUSPEND_CODES_STREAM.has(inst.status ?? ""));
      const isBadDebtContract = c.status === "หนี้เสีย" || hasSuspendedInstallment;
      if (isBadDebtContract && realPaymentsRaw.length > 0) {
        const sortedReal = [...realPaymentsRaw].sort((a, b) => {
          const da = ((a as any).paid_at ?? "").substring(0, 10);
          const db2 = ((b as any).paid_at ?? "").substring(0, 10);
          return da < db2 ? 1 : da > db2 ? -1 : 0;
        });
        const latestDate = ((sortedReal[0] as any).paid_at ?? "").substring(0, 10);
        const latestDatePayments = sortedReal.filter(
          (p) => ((p as any).paid_at ?? "").substring(0, 10) === latestDate,
        );
        const latestDateTotal = latestDatePayments.reduce(
          (sum, p) => sum + Number((p as any).total_paid_amount ?? 0),
          0,
        );
        contractBadDebtAmount = latestDateTotal;
        contractBadDebtDate = latestDate || null;
      }

      let tagged: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }>;
      if (contractBadDebtAmount != null && contractBadDebtAmount > 0 && contractBadDebtDate) {
        let badDebtNote: string | null = null;
        const d = new Date(`${contractBadDebtDate}T00:00:00`);
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear() + 543;
        badDebtNote = `ยอดขายเครื่อง ${contractBadDebtAmount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} บาท (${day}/${month}/${year})`;
        const realAssignedForBadDebt = assignPayPeriods(
          realPaymentsRaw,
          c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
          c.contractNo ?? null,
        );
        // Phase 107: ตัด payments ที่วันที่ตรงกับ latestDate (bad-debt date) ออกทั้งหมด
        // เพราะยอดรวมของวันนั้นถูกรวมไว้ใน bad-debt row แล้ว ไม่ต้องแสดงซ้ำ
        const normalPayments = realAssignedForBadDebt.filter((p) => {
          const paidAt = ((p as any).paid_at ?? "").substring(0, 10);
          return paidAt !== contractBadDebtDate;
        });
        // Phase 110 Iron Rule: badDebtPeriod calculation
        // Rule 1: ถ้าไม่มี normal payments เลย → badDebtPeriod = 1 (งวดแรก)
        // Rule 2: ถ้ามี normal payments → badDebtPeriod = lastNormalPeriod + 1
        // (ไม่ใช้ firstSuspendedPeriod จาก installments เพราะอาจชี้งวดผิด เช่น งวด 3 ทั้งที่ลูกค้าไม่เคยจ่ายเลย)
        let badDebtPeriod: number;
        {
          let lastNormalPeriod = 0;
          for (const p of normalPayments) {
            if (p.period != null && p.period > lastNormalPeriod) lastNormalPeriod = p.period;
          }
          if (lastNormalPeriod === 0) {
            // ไม่มียอดชำระปกติเลย → bad-debt บันทึกที่งวด 1
            badDebtPeriod = 1;
          } else {
            // มียอดชำระปกติ → bad-debt บันทึกที่งวดถัดไปต่อจากงวดสุดท้ายที่ชำระปกติ
            badDebtPeriod = lastNormalPeriod + 1;
          }
        }
        const badDebtRow: any = {
          contract_external_id: c.contractExternalId,
          period: badDebtPeriod, splitIndex: 0, isCloseRow: false, isBadDebtRow: true,
          paid_at: contractBadDebtDate, principal_paid: 0, interest_paid: 0, fee_paid: 0,
          penalty_paid: 0, unlock_fee_paid: 0, discount_amount: 0, overpaid_amount: 0,
          close_installment_amount: 0, bad_debt_amount: contractBadDebtAmount,
          total_paid_amount: 0, payment_id: null, receipt_no: null, remark: null,
          ff_status: null, payment_external_id: null, badDebtNote,
        };
        tagged = [...normalPayments.map((p) => ({ ...p, isBadDebtRow: false })), badDebtRow];
      } else {
        const realAssigned = assignPayPeriods(
          realPaymentsRaw,
          c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
          c.contractNo ?? null,
        );
        tagged = realAssigned.map((p) => ({ ...p, isBadDebtRow: false }));
      }
      // Phase 63: สร้าง carry rows สำหรับงวดที่ถูก skip เพราะ overpaidd
      // ตรวจสอบ gaps ใน periods ของ tagged payments
      // ถ้ามี gap (เช่น period 2 แล้วข้ามไป period 5) ให้สร้าง carry rows สำหรับงวด 3, 4
      {
        const baselineAmount = c.installmentAmount ?? 0;
        if (baselineAmount > 0) {
          // หา periods ที่มีอยู่ใน tagged (เฉพาะ non-close, non-badDebt)
          const existingPeriods = new Set<number>();
          for (const p of tagged) {
            if (p.period != null && !p.isCloseRow && !p.isBadDebtRow) {
              existingPeriods.add(p.period);
            }
          }
          // หา maxNormalPeriod และ minClosePeriod
          const normalPeriods = Array.from(existingPeriods).sort((a, b) => a - b);
          const closePeriods = tagged
            .filter((p) => p.isCloseRow && p.period != null)
            .map((p) => p.period as number)
            .sort((a, b) => a - b);
          const maxNormal = normalPeriods.length > 0 ? normalPeriods[normalPeriods.length - 1] : 0;
          // สร้าง carry rows สำหรับ gaps ระหว่าง 1 ถึง maxNormal
          if (maxNormal > 1) {
            const carryRows: Array<typeof tagged[0]> = [];
            for (let pNo = 1; pNo <= maxNormal; pNo++) {
              if (!existingPeriods.has(pNo)) {
                // หา payment ก่อน gap นี้ (period < pNo) ที่มี overpaid
                const prevPayments = tagged
                  .filter((p) => p.period != null && p.period < pNo && !p.isCloseRow && !p.isBadDebtRow)
                  .sort((a, b) => (b.period ?? 0) - (a.period ?? 0));
                const sourcePayment = prevPayments[0];
                const carryPaidAt = sourcePayment?.paid_at ?? null;
                const carryRow: typeof tagged[0] = {
                  contract_external_id: c.contractExternalId,
                  period: pNo,
                  splitIndex: 0,
                  isCloseRow: false,
                  isBadDebtRow: false,
                  paid_at: carryPaidAt,
                  total_paid_amount: 0,
                  principal_paid: 0,
                  interest_paid: 0,
                  fee_paid: 0,
                  penalty_paid: 0,
                  unlock_fee_paid: 0,
                  discount_amount: 0,
                  overpaid_amount: 0,
                  close_installment_amount: 0,
                  bad_debt_amount: 0,
                  payment_id: null,
                  receipt_no: "(carry)",
                  remark: `(-หักชำระเกิน: ${baselineAmount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`,
                  ff_status: null,
                  payment_external_id: null,
                } as any;
                carryRows.push(carryRow);
              }
            }
            if (carryRows.length > 0) {
              // รวม carry rows เข้าไปใน tagged แล้ว sort ตาม period
              tagged = [...tagged, ...carryRows].sort((a, b) => {
                const pa = a.period ?? 9999;
                const pb = b.period ?? 9999;
                if (pa !== pb) return pa - pb;
                // carry rows (receipt=(carry)) ให้อยู่หลัง normal rows ของ period เดียวกัน
                const aIsCarry = (a as any).receipt_no === "(carry)";
                const bIsCarry = (b as any).receipt_no === "(carry)";
                if (aIsCarry && !bIsCarry) return 1;
                if (!aIsCarry && bIsCarry) return -1;
                return (a.splitIndex ?? 0) - (b.splitIndex ?? 0);
              });
            }
          }
        }
      }

      const row = {
        ...c,
        payments: tagged.map((p) => ({
          period: p.period ?? null, splitIndex: p.splitIndex, isCloseRow: p.isCloseRow, isBadDebtRow: p.isBadDebtRow,
          paidAt: p.paid_at, principal: p.principal_paid ?? 0, interest: p.interest_paid ?? 0,
          fee: p.fee_paid ?? 0, penalty: p.penalty_paid ?? 0, unlockFee: p.unlock_fee_paid ?? 0,
          discount: p.discount_amount ?? 0, overpaid: p.overpaid_amount ?? 0,
          closeInstallmentAmount: p.close_installment_amount ?? 0, badDebt: p.bad_debt_amount ?? 0,
          total: p.total_paid_amount ?? 0, receiptNo: p.receipt_no ?? null, remark: p.remark ?? null,
          badDebtNote: (p as any).badDebtNote ?? null,
        })),
      };
      yieldBatch.push(row);
      if (yieldBatch.length >= YIELD_BATCH) {
        yield { rows: yieldBatch, meta: { hasPrincipalBreakdown: true } };
        yieldBatch = [];
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } // end for contractBatch
  } // end for batchStart
  if (yieldBatch.length > 0) {
    yield { rows: yieldBatch, meta: { hasPrincipalBreakdown: true } };
  }
}

/* ============================================================================
 * listSuspectedBadDebt — Phase 105
 *
 * Returns contracts with debtStatus "เกิน 61-90" or "เกิน >90".
 * Each row contains:
 *   contractNo, approveDate, customerName, phone, model, device,
 *   sellPrice, financeAmount, multiplier, commissionNet,
 *   cost (= financeAmount + commissionNet),
 *   paidInstallments (งวดที่ชำระ),
 *   totalPaid (ยอดเก็บค่างวด — sum of real payments excl. device-sale),
 *   debtValue (= cost - totalPaid),
 *   debtStatus, daysOverdue
 *
 * totalPaid is computed from payment_transactions (numeric external_id only).
 * ============================================================================ */
export async function listSuspectedBadDebt(params: { section: SectionKey }): Promise<{
  rows: Array<{
    contractExternalId: string;
    contractNo: string | null;
    approveDate: string | null;
    customerName: string | null;
    phone: string | null;
    model: string | null;
    device: string | null;
    sellPrice: number | null;
    financeAmount: number | null;
    multiplier: number | null;
    commissionNet: number | null;
    cost: number;
    paidInstallments: number;
    totalPaid: number;
    debtValue: number;
    debtStatus: string;
    daysOverdue: number;
  }>;
}> {
  const db = await getDb();
  if (!db) return { rows: [] };

  // --- Load contract headers ---
  const contractRowsRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           model,
           device,
           CAST(sell_price AS DECIMAL(18,2))    AS sell_price,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           CAST(multiplier AS DECIMAL(18,4))     AS multiplier,
           CAST(commission_net AS DECIMAL(18,2)) AS commission_net,
           paid_installments,
           installment_count,
           installment_amount,
           status
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
       AND ${contracts.status} NOT IN ('สำเร็จ', 'สิ้นสุดสัญญา', 'ยกเลิกสัญญา')
  `);
  const cRows: Array<any> = (contractRowsRaw as any)[0] ?? contractRowsRaw;

  // --- Load installments for overdue calculation ---
  const instRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           external_id,
           period,
           due_date,
           CAST(amount AS DECIMAL(18,2))       AS amount,
           CAST(paid_amount AS DECIMAL(18,2))  AS paid_amount,
           status AS inst_status,
           CAST(JSON_EXTRACT(raw_json, '$.balance') AS DECIMAL(18,2)) AS balance
      FROM ${installments}
     WHERE ${installments.section} = ${params.section}
     ORDER BY contract_external_id, period
  `);
  const iRows: Array<{
    contract_external_id: string;
    external_id: string | null;
    period: number | null;
    due_date: string | null;
    amount: number | null;
    paid_amount: number | null;
    inst_status: string | null;
    balance: number | null;
  }> = (instRowsRaw as any)[0] ?? instRowsRaw;

  // --- Load payment_transactions (real payments only — numeric external_id) ---
  const payRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           CAST(amount AS DECIMAL(18,2)) AS amount
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND (${paymentTransactions.status} IS NULL
            OR LOWER(${paymentTransactions.status}) IN ('active', 'paid', 'success', 'completed'))
       AND ${paymentTransactions.externalId} REGEXP '^[0-9]+$'
  `);
  const payRows: Array<{ contract_external_id: string; amount: number | null }> =
    (payRowsRaw as any)[0] ?? payRowsRaw;

  // --- Index installments by contract ---
  const instByContract = new Map<string, typeof iRows>();
  for (const r of iRows) {
    const key = r.contract_external_id;
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key)!.push(r);
  }

  // --- Index payments by contract ---
  const paidByContract = new Map<string, number>();
  for (const p of payRows) {
    const key = p.contract_external_id;
    paidByContract.set(key, (paidByContract.get(key) ?? 0) + Number(p.amount ?? 0));
  }

  const today = new Date();
  const SUSPECTED_STATUSES = new Set(["เกิน 61-90", "เกิน >90"]);

  const rows: ReturnType<typeof listSuspectedBadDebt> extends Promise<{ rows: infer R }> ? R : never = [];

  for (const c of cRows) {
    const extId: string = c.external_id;
    const instList = instByContract.get(extId) ?? [];

    // Derive debt status by computing daysOverdue directly from installments.
    // NOTE: We pass null for contractStatus to bypass the terminal-status short-circuit
    // in deriveDebtStatus (e.g. 'ระงับสัญญา' would return immediately without
    // computing daysOverdue from installments). We want the real overdue days here.
    const { label: debtStatus, daysOverdue } = deriveDebtStatus(
      null, // bypass terminal check — compute from installments
      instList as any,
      today,
    );

    // Only include suspected bad debt
    if (!SUSPECTED_STATUSES.has(debtStatus)) continue;

    const financeAmount = c.finance_amount != null ? Number(c.finance_amount) : null;
    const commissionNet = c.commission_net != null ? Number(c.commission_net) : null;
    const cost = (financeAmount ?? 0) + (commissionNet ?? 0);
    const totalPaid = paidByContract.get(extId) ?? 0;
    const debtValue = cost - totalPaid;

    rows.push({
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      approveDate: c.approve_date ?? null,
      customerName: c.customer_name ?? null,
      phone: c.phone ?? null,
      model: c.model ?? null,
      device: c.device ?? null,
      sellPrice: c.sell_price != null ? Number(c.sell_price) : null,
      financeAmount,
      multiplier: c.multiplier != null ? Number(c.multiplier) : null,
      commissionNet,
      cost,
      paidInstallments: c.paid_installments != null ? Number(c.paid_installments) : 0,
      totalPaid,
      debtValue,
      debtStatus,
      daysOverdue,
    });
  }

  return { rows };
}

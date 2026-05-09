/**
 * computePayPeriods.ts
 *
 * Pure-accumulation algorithm for assigning period_no (N) and sub_no (M)
 * to each payment transaction.
 *
 * Algorithm:
 *   - Sort payments by paid_at ASC, then external_id ASC
 *   - Accumulate payment.amount against installmentAmount (threshold per period)
 *   - When accumulated >= threshold → period N is complete, advance to N+1
 *   - Carry over excess to the next period
 *   - sub_no (M) = sequential count within the same period N
 *
 * No dependency on receipt_no, close_installment_amount, or installment schedule.
 * Uses only: payment.amount and contract.installment_amount
 */

export interface PaymentInput {
  id: number;
  externalId: string;
  paidAt: string; // ISO date string "YYYY-MM-DD"
  amount: number;
}

export interface PeriodAssignment {
  id: number;
  externalId: string;
  periodNo: number;
  subNo: number;
}

/**
 * Compute period_no and sub_no for a list of payments belonging to one contract.
 *
 * @param payments         - All payment_transactions for the contract
 * @param installmentAmount - The per-period threshold (contract.installment_amount)
 * @returns Array of { id, externalId, periodNo, subNo }
 */
export function computePayPeriods(
  payments: PaymentInput[],
  installmentAmount: number,
): PeriodAssignment[] {
  if (!payments.length) return [];

  // ── 1. Sort by paid_at ASC, then externalId ASC (numeric) ────────────────
  const sorted = [...payments].sort((a, b) => {
    const dateDiff = a.paidAt.localeCompare(b.paidAt);
    if (dateDiff !== 0) return dateDiff;
    return Number(a.externalId) - Number(b.externalId);
  });

  // ── 2. Guard: if installmentAmount is 0 or invalid, assign all to period 1 ─
  const threshold = installmentAmount > 0 ? installmentAmount : 0;

  // ── 3. Accumulate ─────────────────────────────────────────────────────────
  let currentPeriod = 1;
  let accumulated = 0; // running total within current period
  const subCounter = new Map<number, number>(); // period → sub count

  const result: PeriodAssignment[] = [];

  for (const pay of sorted) {
    const amount = Number(pay.amount) || 0;

    if (threshold <= 0) {
      // No threshold available → all payments go to period 1
      const sub = (subCounter.get(1) ?? 0) + 1;
      subCounter.set(1, sub);
      result.push({ id: pay.id, externalId: pay.externalId, periodNo: 1, subNo: sub });
      continue;
    }

    // Assign this payment to currentPeriod
    const sub = (subCounter.get(currentPeriod) ?? 0) + 1;
    subCounter.set(currentPeriod, sub);
    result.push({
      id: pay.id,
      externalId: pay.externalId,
      periodNo: currentPeriod,
      subNo: sub,
    });

    // Accumulate and advance period cursor
    accumulated += amount;
    while (accumulated >= threshold) {
      accumulated -= threshold;
      currentPeriod += 1;
    }
  }

  return result;
}

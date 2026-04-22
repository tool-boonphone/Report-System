/**
 * Regression tests for the "ยอดเก็บหนี้" (Debt Collected) tab shape.
 *
 * Phase 9L fixes pinned by this file:
 *   1. A partial payment (not a TXRTC receipt) must NOT be flagged as
 *      isCloseRow=true — even if it happens to equal close_installment_amount.
 *      (regression: มณีรัตน์ ช่วยบำรุง had a 1000 partial that used to be booked
 *      into the "ปิดค่างวด" column.)
 *   2. TXRTC receipts must be flagged isCloseRow=true so the frontend renders
 *      them in the close column.
 *   3. splitIndex must increment per period (0, 1, 2…) so the UI can show
 *      a "N-M" label (period-sequence) for every payment.
 *   4. bad_debt_amount > 0 must be routed to the LAST period with
 *      isBadDebtRow=true (no change; regression lock).
 */
import { describe, it, expect } from "vitest";
import { assignPayPeriods, type PayRawRow } from "./debtDb";

function mkPay(partial: Partial<PayRawRow>): PayRawRow {
  return {
    contract_external_id: "C1",
    period: null,
    paid_at: null,
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
    receipt_no: null,
    remark: null,
    payment_id: 1,
    ...partial,
  };
}

const schedule = [
  { period: 1, amount: 4486 },
  { period: 2, amount: 4486 },
  { period: 3, amount: 4486 },
  { period: 4, amount: 4486 },
];

describe("assignPayPeriods – isCloseRow detection", () => {
  it("does NOT flag a partial non-TXRTC payment as close-row (มณีรัตน์)", () => {
    // One partial payment of 1000 on installment #2 with a regular receipt.
    const pays = [
      mkPay({
        paid_at: "2026-03-10 10:00:00",
        total_paid_amount: 4486,
        principal_paid: 1907,
        interest_paid: 2479,
        fee_paid: 100,
        receipt_no: "TXRT6901-1",
        payment_id: 101,
      }),
      mkPay({
        paid_at: "2026-04-10 10:00:00",
        total_paid_amount: 1000,
        principal_paid: 500,
        interest_paid: 400,
        fee_paid: 100,
        close_installment_amount: 4486, // API always sends this; must NOT trigger close
        receipt_no: "TXRT6902-1",
        payment_id: 102,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule);
    expect(tagged).toHaveLength(2);
    expect(tagged.every((p) => p.isCloseRow === false)).toBe(true);
  });

  it("flags TXRTC receipts as close-row (lump-sum settlement)", () => {
    const pays = [
      mkPay({
        paid_at: "2026-03-10 10:00:00",
        total_paid_amount: 4486,
        principal_paid: 1907,
        interest_paid: 2479,
        fee_paid: 100,
        receipt_no: "TXRT6901-1",
        payment_id: 101,
      }),
      // TXRTC close on period 2
      mkPay({
        paid_at: "2026-04-10 10:00:00",
        total_paid_amount: 13458,
        principal_paid: 5721,
        interest_paid: 7437,
        fee_paid: 300,
        close_installment_amount: 13458,
        receipt_no: "TXRTC6902-1",
        payment_id: 102,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule);
    expect(tagged[0].isCloseRow).toBe(false);
    expect(tagged[1].isCloseRow).toBe(true);
    expect(tagged[1].receipt_no).toContain("TXRTC");
  });
});

describe("assignPayPeriods – splitIndex (N-M label source)", () => {
  it("increments splitIndex per period for multiple partial payments", () => {
    const pays = [
      mkPay({
        paid_at: "2026-03-10 10:00:00",
        total_paid_amount: 500,
        principal_paid: 250,
        interest_paid: 150,
        fee_paid: 100,
        receipt_no: "TXRT-A",
        payment_id: 1,
      }),
      mkPay({
        paid_at: "2026-03-11 10:00:00",
        total_paid_amount: 500,
        principal_paid: 250,
        interest_paid: 150,
        fee_paid: 100,
        receipt_no: "TXRT-B",
        payment_id: 2,
      }),
      mkPay({
        paid_at: "2026-03-12 10:00:00",
        total_paid_amount: 3486,
        principal_paid: 1407,
        interest_paid: 2179,
        fee_paid: 100,
        receipt_no: "TXRT-C",
        payment_id: 3,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule);
    // All three partials fall on period 1 (they don't sum past ≥4486 boundary yet).
    expect(tagged.map((p) => p.period)).toEqual([1, 1, 1]);
    expect(tagged.map((p) => p.splitIndex)).toEqual([0, 1, 2]);
  });

  it("resets splitIndex back to 0 when cursor advances to next period", () => {
    const pays = [
      // Period 1 paid in full.
      mkPay({
        paid_at: "2026-03-10 10:00:00",
        total_paid_amount: 4486,
        principal_paid: 1907,
        interest_paid: 2479,
        fee_paid: 100,
        receipt_no: "TXRT-A",
        payment_id: 1,
      }),
      // Period 2 — first partial.
      mkPay({
        paid_at: "2026-04-10 10:00:00",
        total_paid_amount: 1000,
        principal_paid: 500,
        interest_paid: 400,
        fee_paid: 100,
        receipt_no: "TXRT-B",
        payment_id: 2,
      }),
      // Period 2 — second partial.
      mkPay({
        paid_at: "2026-04-15 10:00:00",
        total_paid_amount: 1000,
        principal_paid: 500,
        interest_paid: 400,
        fee_paid: 100,
        receipt_no: "TXRT-C",
        payment_id: 3,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule);
    expect(tagged[0].period).toBe(1);
    expect(tagged[0].splitIndex).toBe(0);
    expect(tagged[1].period).toBe(2);
    expect(tagged[1].splitIndex).toBe(0);
    expect(tagged[2].period).toBe(2);
    expect(tagged[2].splitIndex).toBe(1);
  });
});

describe("assignPayPeriods – bad debt", () => {
  it("routes a bad_debt_amount payment to the last period with isBadDebtRow=true", () => {
    const pays = [
      mkPay({
        paid_at: "2026-03-10 10:00:00",
        total_paid_amount: 4486,
        principal_paid: 1907,
        interest_paid: 2479,
        fee_paid: 100,
        receipt_no: "TXRT-A",
        payment_id: 1,
      }),
      mkPay({
        paid_at: "2026-06-10 10:00:00",
        total_paid_amount: 0,
        bad_debt_amount: 13458,
        receipt_no: "BAD-1",
        payment_id: 99,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule);
    const bad = tagged.find((p) => p.isBadDebtRow);
    expect(bad).toBeDefined();
    expect(bad!.period).toBe(4); // last period
    expect(bad!.isCloseRow).toBe(false);
  });
});

describe("assignPayPeriods – empty inputs", () => {
  it("returns empty for no payments", () => {
    expect(assignPayPeriods([], schedule)).toEqual([]);
  });
});

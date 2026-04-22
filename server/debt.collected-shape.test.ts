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

describe("assignPayPeriods – TXRTC cursor advance (Phase 9M)", () => {
  const schedule12 = Array.from({ length: 12 }, (_, k) => ({
    period: k + 1,
    amount: 4959,
  }));

  it("places each TXRTC receipt on its OWN period (เอกลักษณ์ case: 1 regular + 11 TXRTC)", () => {
    // 1 regular TXRT for period 1, then 11 TXRTC receipts for periods 2-12
    // — all sharing the same paid_at. Principal/interest/fee are null on
    // TXRTC rows (reproducing what Boonphone actually sends).
    const pays: PayRawRow[] = [
      mkPay({
        paid_at: "2026-03-27",
        total_paid_amount: 4959,
        principal_paid: 2100,
        interest_paid: 2759,
        fee_paid: 100,
        receipt_no: "TXRT0226-PTE012-1317-01-1",
        payment_id: 1,
      }),
      ...Array.from({ length: 9 }, (_, k) =>
        mkPay({
          paid_at: "2026-04-10",
          total_paid_amount: 4959,
          // Field nulls match real Boonphone payload on TXRTC rows.
          principal_paid: null,
          interest_paid: null,
          fee_paid: null,
          close_installment_amount: 4959,
          receipt_no: "TXRTC0226-PTE012-1317-01",
          payment_id: 10 + k,
        }),
      ),
      // Two trailing discount-only TXRTC rows
      mkPay({
        paid_at: "2026-04-10",
        total_paid_amount: 0,
        principal_paid: null,
        interest_paid: null,
        fee_paid: null,
        discount_amount: 4959,
        receipt_no: "TXRTC0226-PTE012-1317-01",
        payment_id: 19,
      }),
      mkPay({
        paid_at: "2026-04-10",
        total_paid_amount: 0,
        principal_paid: null,
        interest_paid: null,
        fee_paid: null,
        discount_amount: 4959,
        receipt_no: "TXRTC0226-PTE012-1317-01",
        payment_id: 20,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule12);
    // 1 regular on period 1
    expect(tagged[0].period).toBe(1);
    expect(tagged[0].isCloseRow).toBe(false);
    // Next 11 rows cover periods 2..12 (cursor advances once per TXRTC row).
    const txrtcRows = tagged.filter((t) => t.isCloseRow);
    expect(txrtcRows).toHaveLength(11);
    const periodsUsed = txrtcRows.map((t) => t.period);
    expect(periodsUsed).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("places all TXRTC receipts across periods (สุวิทย์ case: 12 TXRTC covering 12 periods)", () => {
    // 10 TXRTC principal rows + 2 discount-only rows (all TXRTC). They
    // must cover periods 1..12 sequentially.
    const pays: PayRawRow[] = [
      ...Array.from({ length: 10 }, (_, k) =>
        mkPay({
          paid_at: "2026-04-04",
          total_paid_amount: 2692,
          principal_paid: null,
          interest_paid: null,
          fee_paid: null,
          close_installment_amount: 2692,
          receipt_no: "TXRTC0326-AYA006-2353-01",
          payment_id: k + 1,
        }),
      ),
      mkPay({
        paid_at: "2026-04-04",
        total_paid_amount: 0,
        discount_amount: 2692,
        receipt_no: "TXRTC0326-AYA006-2353-01",
        payment_id: 11,
      }),
      mkPay({
        paid_at: "2026-04-04",
        total_paid_amount: 0,
        discount_amount: 2692,
        receipt_no: "TXRTC0326-AYA006-2353-01",
        payment_id: 12,
      }),
    ];
    const schedule = Array.from({ length: 12 }, (_, k) => ({
      period: k + 1,
      amount: 2692,
    }));
    const tagged = assignPayPeriods(pays, schedule);
    expect(tagged).toHaveLength(12);
    expect(tagged.map((t) => t.period)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(tagged.every((t) => t.isCloseRow)).toBe(true);
  });

  it("does not advance past the last period (two extra TXRTC rows stick to last)", () => {
    // Schedule has 3 periods; 5 TXRTC rows — cursor should clamp at last.
    const schedule = [
      { period: 1, amount: 1000 },
      { period: 2, amount: 1000 },
      { period: 3, amount: 1000 },
    ];
    const pays: PayRawRow[] = Array.from({ length: 5 }, (_, k) =>
      mkPay({
        paid_at: "2026-04-04",
        total_paid_amount: 1000,
        close_installment_amount: 1000,
        receipt_no: "TXRTCAAA",
        payment_id: k + 1,
      }),
    );
    const tagged = assignPayPeriods(pays, schedule);
    expect(tagged.map((t) => t.period)).toEqual([1, 2, 3, 3, 3]);
    // splitIndex for period 3 grows from 0 onward.
    const period3 = tagged.filter((t) => t.period === 3);
    expect(period3.map((t) => t.splitIndex)).toEqual([0, 1, 2]);
  });

  it("regular TXRT partial payments still stay on the same period until filled (มณีรัตน์ case)", () => {
    const schedule = [
      { period: 1, amount: 1710 },
      { period: 2, amount: 1710 },
    ];
    const pays: PayRawRow[] = [
      mkPay({
        paid_at: "2026-04-17",
        total_paid_amount: 1000,
        principal_paid: 900,
        interest_paid: 0,
        fee_paid: 100,
        receipt_no: "TXRT0326-SNI001-1392-01-1",
        payment_id: 1,
      }),
      mkPay({
        paid_at: "2026-04-17",
        total_paid_amount: 680,
        principal_paid: 580,
        interest_paid: 0,
        fee_paid: 100,
        receipt_no: "TXRT0326-SNI001-1392-01-2",
        payment_id: 2,
      }),
      mkPay({
        paid_at: "2026-04-20",
        total_paid_amount: 830,
        principal_paid: 730,
        interest_paid: 0,
        fee_paid: 100,
        receipt_no: "TXRT0326-SNI001-1392-01-3",
        payment_id: 3,
      }),
    ];
    const tagged = assignPayPeriods(pays, schedule);
    // All three partials are tagged BEFORE cursor advance each step.
    // After payment 1 (1000): coveredCurrent=1000 < 1710 → stays on P1.
    // After payment 2 (680):  coveredCurrent=1680 < 1710 → stays on P1.
    // After payment 3 (830):  coveredCurrent=2510 ≥ 1710 → tagged P1 (before advance), then cursor advances to P2.
    // So all three rows belong to period 1 with splitIndex 0,1,2.
    expect(tagged.map((t) => t.period)).toEqual([1, 1, 1]);
    expect(tagged.map((t) => t.splitIndex)).toEqual([0, 1, 2]);
    expect(tagged.every((t) => t.isCloseRow === false)).toBe(true);
  });
});

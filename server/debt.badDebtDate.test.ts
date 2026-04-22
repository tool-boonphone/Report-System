/**
 * Fixture-backed unit tests for `deriveBadDebtDate`.
 *
 * Business rule (user, 2026-04-23):
 *   "วันที่รับยอดสุดท้ายตอนที่ยังเป็นระงับสัญญาอยู่นั่นแหละคือ
 *    วันที่ถูกบันทึกว่าเป็นหนี้เสีย"
 *
 * Meaning: the effective bad-debt date is the LATEST `paid_at` that
 * arrived strictly AFTER the contract was suspended (`suspendedAt`).
 * If no payment arrived after suspension, we fall back to `suspendedAt`
 * itself (best signal we have).
 *
 * These tests are fixture-backed (no DB) so they run deterministically
 * even though the live DB currently has zero `หนี้เสีย` contracts.
 */
import { describe, it, expect } from "vitest";

import { deriveBadDebtDate } from "./debtDb";

describe("deriveBadDebtDate", () => {
  const suspendedAt = "2026-02-15";

  it("returns null when suspendedAt is null", () => {
    expect(deriveBadDebtDate([{ paid_at: "2026-03-01" }], null)).toBeNull();
  });

  it("falls back to suspendedAt when there are no payments at all", () => {
    expect(deriveBadDebtDate([], suspendedAt)).toBe(suspendedAt);
  });

  it("falls back to suspendedAt when all payments happened BEFORE suspension", () => {
    const payments = [
      { paid_at: "2026-01-10" },
      { paid_at: "2026-02-01" },
      { paid_at: "2026-02-14" }, // still before suspendedAt
    ];
    expect(deriveBadDebtDate(payments, suspendedAt)).toBe(suspendedAt);
  });

  it("returns the LATEST paid_at among payments strictly AFTER suspendedAt", () => {
    const payments = [
      { paid_at: "2026-01-10" }, // before — ignored
      { paid_at: "2026-02-20" }, // after
      { paid_at: "2026-03-05" }, // after, latest
      { paid_at: "2026-02-28" }, // after, not latest
    ];
    expect(deriveBadDebtDate(payments, suspendedAt)).toBe("2026-03-05");
  });

  it("handles mixed null/valid paid_at values gracefully", () => {
    const payments = [
      { paid_at: null },
      { paid_at: "2026-03-01 09:30:00" },
      { paid_at: null },
      { paid_at: "2026-02-25 12:00:00" },
    ];
    expect(deriveBadDebtDate(payments, suspendedAt)).toBe(
      "2026-03-01 09:30:00",
    );
  });

  it("treats a paid_at equal to suspendedAt as NOT-after (strict >)", () => {
    // Business rule: only payments AFTER suspension count as "during
    // suspended period". An exact equality is treated as not-after.
    const payments = [
      { paid_at: "2026-02-15" }, // same as suspendedAt → ignored
      { paid_at: "2026-02-16" }, // after → wins
    ];
    expect(deriveBadDebtDate(payments, suspendedAt)).toBe("2026-02-16");
  });

  it("ISO datetime strings are sortable lexicographically", () => {
    const suspendedAtDT = "2026-02-15 10:00:00";
    const payments = [
      { paid_at: "2026-02-15 09:59:59" }, // before
      { paid_at: "2026-02-15 10:00:01" }, // after
      { paid_at: "2026-02-16 00:00:00" }, // after, latest
    ];
    expect(deriveBadDebtDate(payments, suspendedAtDT)).toBe(
      "2026-02-16 00:00:00",
    );
  });
});

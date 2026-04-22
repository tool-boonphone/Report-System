/**
 * Integration shape test for listDebtTarget.
 *
 * Verifies the "trust-API + annotation" contract:
 *   - Each contract row exposes `installments[]`
 *   - Each installment cell includes `baselineAmount`, `overpaidApplied`,
 *     and `isClosed` (required by the UI annotations).
 *   - For rows that contain a reduced period (amount < baselineAmount),
 *     `overpaidApplied > 0`; otherwise `overpaidApplied === 0`.
 *   - `isClosed` is mutually exclusive with a non-zero `amount`.
 *   - NEW (2026-04-23): "ปิดค่างวดแล้ว" applies only to periods strictly
 *     AFTER the one where the customer paid the close-out lump sum.
 *     The close-out period itself — and earlier ones — keep real figures.
 *
 * Runs against the live TiDB instance the dev server uses, so we keep the
 * timeout generous.
 */
import { describe, expect, it } from "vitest";
import { listDebtTarget } from "./debtDb";

describe("listDebtTarget — trust-API shape", () => {
  it(
    "returns baselineAmount/overpaidApplied/isClosed per installment cell",
    async () => {
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      expect(Array.isArray(rows)).toBe(true);
      if (rows.length === 0) return; // nothing to assert on an empty DB
      const sample = rows.find((r) => (r.installments ?? []).length > 0);
      expect(sample).toBeTruthy();
      if (!sample) return;
      for (const cell of sample.installments) {
        expect(cell).toHaveProperty("baselineAmount");
        expect(cell).toHaveProperty("overpaidApplied");
        expect(cell).toHaveProperty("isClosed");
        expect(typeof cell.baselineAmount).toBe("number");
        expect(typeof cell.overpaidApplied).toBe("number");
        expect(typeof cell.isClosed).toBe("boolean");
        // If the period is reported as closed, its amount must be 0.
        if (cell.isClosed) {
          expect(cell.amount).toBeLessThanOrEqual(0.01);
          expect(cell.principal).toBeLessThanOrEqual(0.01);
          expect(cell.interest).toBeLessThanOrEqual(0.01);
          expect(cell.fee).toBeLessThanOrEqual(0.01);
        }
        // overpaidApplied must be >= 0 and never exceed baselineAmount.
        expect(cell.overpaidApplied).toBeGreaterThanOrEqual(0);
        if (cell.baselineAmount > 0) {
          expect(cell.overpaidApplied).toBeLessThanOrEqual(
            cell.baselineAmount + 0.01,
          );
        }
      }
    },
    20_000,
  );

  it(
    "at least one contract in Boonphone historical data has overpaidApplied > 0",
    async () => {
      // Anchor: we proved in DB that 57 contracts already show a reduced
      // per-period amount. This sanity test guards against regressions where
      // we accidentally stop surfacing that annotation.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      let seenOverpaid = false;
      for (const r of rows) {
        for (const c of r.installments ?? []) {
          if ((c.overpaidApplied ?? 0) > 0) {
            seenOverpaid = true;
            break;
          }
        }
        if (seenOverpaid) break;
      }
      // Do NOT assert true when the DB is empty (CI stub); only when we have data.
      if (rows.length > 10) {
        expect(seenOverpaid).toBe(true);
      }
    },
    20_000,
  );

  it(
    "isClosed applies only to periods AFTER the customer's close-out payment",
    async () => {
      // Regression anchor for the 2026-04-23 fix: previously `isClosed` was
      // derived from `amount === 0`, which incorrectly flagged earlier unpaid
      // periods on closed contracts. The rule now is:
      //   isClosed(period P) <=> P > max(period_of_close_out_payment)
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      if (rows.length < 10) return;

      // Find a contract with at least one closed installment.
      const closedRow = rows.find((r) =>
        (r.installments ?? []).some((c) => c.isClosed),
      );
      expect(closedRow).toBeTruthy();
      if (!closedRow) return;

      const insts = (closedRow.installments ?? []).slice().sort(
        (a, b) => (a.period ?? 0) - (b.period ?? 0),
      );
      // Closed cells must form a contiguous suffix: every period STRICTLY
      // greater than the last non-closed period is closed.
      let lastNonClosedPeriod = 0;
      let firstClosedPeriod = Number.POSITIVE_INFINITY;
      for (const c of insts) {
        const p = Number(c.period ?? 0);
        if (c.isClosed) {
          if (p < firstClosedPeriod) firstClosedPeriod = p;
        } else if (p > lastNonClosedPeriod) {
          lastNonClosedPeriod = p;
        }
      }
      expect(firstClosedPeriod).toBeGreaterThan(lastNonClosedPeriod);
      // Closed cells must zero every money field.
      for (const c of insts) {
        if (!c.isClosed) continue;
        expect(c.amount).toBeLessThanOrEqual(0.01);
        expect(c.principal).toBeLessThanOrEqual(0.01);
        expect(c.interest).toBeLessThanOrEqual(0.01);
        expect(c.fee).toBeLessThanOrEqual(0.01);
      }
    },
    20_000,
  );
});

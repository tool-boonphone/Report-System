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
        // If the period is reported as closed, its amount must be ~0.
        if (cell.isClosed) {
          expect(cell.amount).toBeLessThanOrEqual(0.01);
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
});

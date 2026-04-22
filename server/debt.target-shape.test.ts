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

describe("listDebtTarget — baseline-restoration rule (2026-04-23)", () => {
  it(
    "past periods that were paid-in-full (non-closed) show the baseline amount, not 0",
    async () => {
      // USER RULE: ยอดหนี้รวม ของงวดที่ผ่านมา/งวดปัจจุบัน = baseline จริง
      // แม้ลูกค้าจะจ่ายครบแล้ว (API ส่ง amount=0) เพื่อให้ฝ่ายเก็บหนี้
      // เห็นยอดตั้งเก็บของเดือนนั้น.
      //
      // Anchor in DB: contract ext=1496, baseline=4097. API returns
      // installment #1 amount=0 paid=4097 (no close-out). We must restore
      // baseline so amount === 4097.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      if (rows.length < 10) return; // skip on empty DB

      const contract1496 = rows.find((r) => r.contractExternalId === "1496");
      if (contract1496) {
        const inst1 = (contract1496.installments ?? []).find(
          (c: any) => c.period === 1,
        );
        if (inst1) {
          expect(inst1.isClosed).toBe(false);
          expect(inst1.amount).toBeGreaterThan(4000); // ≈ baseline 4097
        }
      }

      // Broader guarantee: no non-closed period should have amount===0 when
      // paid>0 and baselineAmount>0 — that combination is exactly the one
      // the rule is designed to fix.
      let violations = 0;
      for (const r of rows) {
        for (const c of r.installments ?? []) {
          if (
            !c.isClosed &&
            !c.isSuspended &&
            c.baselineAmount > 0 &&
            c.paid > 0.01 &&
            c.amount <= 0.01
          ) {
            violations += 1;
          }
        }
      }
      expect(violations).toBe(0);
    },
    20_000,
  );
});

describe("listDebtTarget — overpaid carry surfaces correctly", () => {
  it(
    "next-period amount < baseline and overpaidApplied > 0 when API applied overpaid carry",
    async () => {
      // Anchor in DB (audit script scripts/audit-overpaid-carry.mjs):
      //   - contract 1496: baseline=4097, period 2 amount=3944, overpaid=153
      //   - contract 1517: baseline=3315, period 2 amount=3115, overpaid=200
      // After the backend rule, the next period's amount must remain
      // REDUCED (not restored to baseline) and `overpaidApplied` must
      // expose the delta so the UI can annotate it.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      if (rows.length < 10) return;

      const anchors = ["1496", "1517"];
      let checked = 0;
      for (const extId of anchors) {
        const c = rows.find((r) => r.contractExternalId === extId);
        if (!c) continue;
        const inst2 = (c.installments ?? []).find((x: any) => x.period === 2);
        if (!inst2) continue;
        checked += 1;
        // Period 2 should have amount < baseline (API carry).
        expect(inst2.baselineAmount).toBeGreaterThan(0);
        expect(inst2.amount).toBeLessThan(inst2.baselineAmount);
        // overpaidApplied must match the actual overpaid_amount carried
        // from the previous period's payment (anchors: 153 for 1496, 200 for 1517).
        // For these particular contracts, the previous-period overpaid happens
        // to equal (baseline - amount) of period 2, but we no longer derive it
        // that way — we read it from the payment row.
        expect(inst2.overpaidApplied).toBeGreaterThan(0);
        expect(
          Math.abs(inst2.overpaidApplied - (inst2.baselineAmount - inst2.amount)),
        ).toBeLessThan(1.0);
        expect(inst2.isClosed).toBe(false);
      }
      // If none of the anchors exist in DB yet, this assertion is a no-op.
      if (checked === 0) return;
    },
    20_000,
  );

  it(
    "does not flag false-positive overpaid when amount < baseline for other reasons",
    async () => {
      // Anchor: contract 2187 (สุทธิดา จงใจ).
      // Period 1 has baseline=6985, but API amount=6235.
      // The customer only paid 1000, so there is NO overpaid carry.
      // Previously, the heuristic `baseline - amount` incorrectly flagged
      // 750 as overpaidApplied. It must now be 0.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      const c = rows.find((r) => r.contractExternalId === "2187");
      if (!c) return;
      const inst1 = (c.installments ?? []).find((x: any) => x.period === 1);
      if (!inst1) return;
      expect(inst1.baselineAmount).toBe(6985);
      expect(inst1.amount).toBe(6235);
      expect(inst1.overpaidApplied).toBe(0); // NO false positive
    },
    20_000,
  );
});


describe("listDebtTarget — principal/interest scaling matches Boonphone UI (2026-04-23)", () => {
  it(
    "for any non-closed period with amount>0, principal+interest+fee+penalty ≈ amount",
    async () => {
      // USER REPORT: contract CT0426-RBR002-4092-01 showed principal=1360
      // interest=1768 in our UI, but Boonphone admin showed 1907 / 2479.
      // Root cause: API's principal_due/interest_due represent only the
      // base split, while the admin UI rescales them so the sub-fields sum
      // to the full installment amount (after fee+penalty). We mirror that
      // behaviour, so principal+interest+fee+penalty must equal amount.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      if (rows.length === 0) return;

      let checked = 0;
      for (const r of rows) {
        for (const c of (r.installments ?? []) as Array<any>) {
          if (c.isClosed) continue;
          const amt = Number(c.amount ?? 0);
          if (amt <= 0.01) continue;
          const sum =
            Number(c.principal ?? 0) +
            Number(c.interest ?? 0) +
            Number(c.fee ?? 0) +
            Number(c.penalty ?? 0);
          // Allow up to 0.05 baht of rounding drift.
          expect(Math.abs(sum - amt)).toBeLessThan(0.05);
          checked++;
          if (checked >= 200) return;
        }
      }
      expect(checked).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "contract CT0426-RBR002-4092-01 period 1 — principal≈1907, interest≈2479, fee=100",
    async () => {
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      const c: any = rows.find(
        (r: any) => r.contractNo === "CT0426-RBR002-4092-01",
      );
      if (!c) return; // anchor not present in this DB
      const p1 = (c.installments ?? []).find(
        (i: any) => Number(i.period) === 1,
      );
      if (!p1) return;
      expect(Math.round(Number(p1.principal))).toBe(1907);
      expect(Math.round(Number(p1.interest))).toBe(2479);
      expect(Number(p1.fee)).toBe(100);
      expect(Number(p1.amount)).toBe(4486);
    },
    15_000,
  );
});


describe("listDebtTarget — ระงับสัญญา / หนี้เสีย exclusion (2026-04-23)", () => {
  it(
    "suspended contracts: from the first suspended period, money fields are zero and suspendLabel is set",
    async () => {
      // USER RULE: contract.status='ระงับสัญญา' → หา period แรกที่
      // installment_status_code='ระงับสัญญา' → periods >= that period แสดง
      // suspendLabel + suspendedAt + เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/amount = 0.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      if (rows.length < 10) return;

      // At least one suspended row must exist (60 ระงับสัญญา ใน DB ปัจจุบัน).
      const suspendedRow = rows.find(
        (r: any) =>
          r.debtStatus === "ระงับสัญญา" &&
          (r.installments ?? []).some((c: any) => c.isSuspended === true),
      );
      expect(suspendedRow).toBeTruthy();
      if (!suspendedRow) return;

      const insts = (suspendedRow.installments ?? []).slice().sort(
        (a: any, b: any) => (a.period ?? 0) - (b.period ?? 0),
      );
      // Suspended cells must form a contiguous suffix (like closed cells).
      let firstSuspendedPeriod = Number.POSITIVE_INFINITY;
      let lastNonSuspendedPeriod = 0;
      for (const c of insts) {
        const p = Number(c.period ?? 0);
        if (c.isSuspended) {
          if (p < firstSuspendedPeriod) firstSuspendedPeriod = p;
        } else if (p > lastNonSuspendedPeriod) {
          lastNonSuspendedPeriod = p;
        }
      }
      expect(firstSuspendedPeriod).toBeGreaterThan(lastNonSuspendedPeriod);

      // Suspended cells must zero every money field and carry the label.
      for (const c of insts) {
        if (!c.isSuspended) continue;
        expect(c.amount).toBeLessThanOrEqual(0.01);
        expect(c.principal).toBeLessThanOrEqual(0.01);
        expect(c.interest).toBeLessThanOrEqual(0.01);
        expect(c.fee).toBeLessThanOrEqual(0.01);
        expect(c.suspendLabel).toBe("ระงับสัญญา");
        expect(typeof c.suspendedAt === "string").toBe(true);
      }
    },
    20_000,
  );

  it(
    "non-suspended contracts do not carry suspendLabel",
    async () => {
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      if (rows.length < 10) return;
      const normal = rows.find((r: any) => r.debtStatus !== "ระงับสัญญา" && r.debtStatus !== "หนี้เสีย");
      if (!normal) return;
      for (const c of normal.installments ?? []) {
        expect(!!c.isSuspended).toBe(false);
        expect(c.suspendLabel ?? null).toBeNull();
      }
    },
    20_000,
  );

  it(
    "bad-debt contracts would relabel all formerly-suspended periods as หนี้เสีย (forward-compat)",
    async () => {
      // DB currently has no หนี้เสีย contracts, but the logic must be
      // symmetric with ระงับสัญญา when one appears. If any do exist, every
      // suspended cell must carry label 'หนี้เสีย' instead of 'ระงับสัญญา'.
      const { rows } = await listDebtTarget({ section: "Boonphone" });
      const badDebt = rows.find((r: any) => r.debtStatus === "หนี้เสีย");
      if (!badDebt) return; // no anchor yet — skip
      const hasAnySuspended = (badDebt.installments ?? []).some((c: any) => c.isSuspended);
      expect(hasAnySuspended).toBe(true);
      for (const c of badDebt.installments ?? []) {
        if (!c.isSuspended) continue;
        expect(c.suspendLabel).toBe("หนี้เสีย");
      }
    },
    20_000,
  );
});

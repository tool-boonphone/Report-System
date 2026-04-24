/**
 * Unit tests for Bad Debt Summary (Phase 9k).
 * Tests the pure calculation logic without DB access.
 */
import { describe, expect, it } from "vitest";

// ─── Pure calculation helpers (extracted for testability) ─────────────────────

type BadDebtRow = {
  contractExternalId: string;
  contractNo: string | null;
  customerName: string | null;
  phone: string | null;
  approveDate: string | null;
  productType: string | null;
  model: string | null;
  salePrice: number | null;
  financeAmount: number;
  totalPaid: number;
  profitLoss: number;
  badDebtDate: string | null;
  installmentCount: number | null;
  paidInstallments: number;
};

type BadDebtSummary = {
  contractCount: number;
  totalSalePrice: number;
  totalFinanceAmount: number;
  totalPaid: number;
  totalProfitLoss: number;
  profitCount: number;
  lossCount: number;
  breakEvenCount: number;
};

function computeRow(
  financeAmount: number,
  totalPaid: number,
  salePrice: number | null = null,
): Pick<BadDebtRow, "financeAmount" | "totalPaid" | "profitLoss" | "salePrice"> {
  return {
    financeAmount,
    totalPaid,
    profitLoss: totalPaid - financeAmount,
    salePrice,
  };
}

function computeSummary(rows: BadDebtRow[]): BadDebtSummary {
  const empty: BadDebtSummary = {
    contractCount: 0,
    totalSalePrice: 0,
    totalFinanceAmount: 0,
    totalPaid: 0,
    totalProfitLoss: 0,
    profitCount: 0,
    lossCount: 0,
    breakEvenCount: 0,
  };
  return rows.reduce<BadDebtSummary>(
    (acc, r) => ({
      contractCount: acc.contractCount + 1,
      totalSalePrice: acc.totalSalePrice + (r.salePrice ?? 0),
      totalFinanceAmount: acc.totalFinanceAmount + r.financeAmount,
      totalPaid: acc.totalPaid + r.totalPaid,
      totalProfitLoss: acc.totalProfitLoss + r.profitLoss,
      profitCount: acc.profitCount + (r.profitLoss > 0 ? 1 : 0),
      lossCount: acc.lossCount + (r.profitLoss < 0 ? 1 : 0),
      breakEvenCount: acc.breakEvenCount + (r.profitLoss === 0 ? 1 : 0),
    }),
    { ...empty },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Bad Debt Row Calculation", () => {
  it("calculates loss correctly (paid < finance)", () => {
    const row = computeRow(9675, 5000);
    expect(row.profitLoss).toBe(-4675);
  });

  it("calculates profit correctly (paid > finance)", () => {
    const row = computeRow(8000, 9000);
    expect(row.profitLoss).toBe(1000);
  });

  it("calculates break-even correctly (paid === finance)", () => {
    const row = computeRow(10000, 10000);
    expect(row.profitLoss).toBe(0);
  });

  it("handles salePrice null correctly", () => {
    const row = computeRow(5000, 3000, null);
    expect(row.salePrice).toBeNull();
    expect(row.profitLoss).toBe(-2000);
  });

  it("handles salePrice value correctly", () => {
    const row = computeRow(9675, 5000, 12900);
    expect(row.salePrice).toBe(12900);
  });
});

describe("Bad Debt Summary Calculation", () => {
  const makeRow = (
    financeAmount: number,
    totalPaid: number,
    salePrice: number | null = null,
  ): BadDebtRow => ({
    contractExternalId: String(Math.random()),
    contractNo: null,
    customerName: null,
    phone: null,
    approveDate: null,
    productType: null,
    model: null,
    salePrice,
    financeAmount,
    totalPaid,
    profitLoss: totalPaid - financeAmount,
    badDebtDate: null,
    installmentCount: 12,
    paidInstallments: 3,
  });

  it("returns empty summary for empty rows", () => {
    const s = computeSummary([]);
    expect(s.contractCount).toBe(0);
    expect(s.totalProfitLoss).toBe(0);
  });

  it("counts contracts correctly", () => {
    const rows = [makeRow(9675, 5000), makeRow(10000, 8000), makeRow(8000, 8000)];
    const s = computeSummary(rows);
    expect(s.contractCount).toBe(3);
  });

  it("sums finance amount correctly", () => {
    const rows = [makeRow(9675, 5000), makeRow(10160, 8500)];
    const s = computeSummary(rows);
    expect(s.totalFinanceAmount).toBeCloseTo(19835, 2);
  });

  it("sums total paid correctly", () => {
    const rows = [makeRow(9675, 5000), makeRow(10160, 8500)];
    const s = computeSummary(rows);
    expect(s.totalPaid).toBeCloseTo(13500, 2);
  });

  it("calculates total profit/loss correctly", () => {
    // row1: -4675, row2: -1660
    const rows = [makeRow(9675, 5000), makeRow(10160, 8500)];
    const s = computeSummary(rows);
    expect(s.totalProfitLoss).toBeCloseTo(-6335, 2);
  });

  it("counts profit/loss/breakeven correctly", () => {
    const rows = [
      makeRow(9675, 5000),   // loss
      makeRow(8000, 9000),   // profit
      makeRow(10000, 10000), // breakeven
      makeRow(5000, 3000),   // loss
    ];
    const s = computeSummary(rows);
    expect(s.profitCount).toBe(1);
    expect(s.lossCount).toBe(2);
    expect(s.breakEvenCount).toBe(1);
  });

  it("sums salePrice (null treated as 0)", () => {
    const rows = [makeRow(9675, 5000, 12900), makeRow(10160, 8500, null)];
    const s = computeSummary(rows);
    expect(s.totalSalePrice).toBe(12900);
  });
});

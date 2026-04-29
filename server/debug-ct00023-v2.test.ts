import { describe, it } from "vitest";
import { listDebtCollected } from "./server/debtDb";

describe("Debug CT0824-NRT001-00023-01 payments detail", () => {
  it("แสดง payments ทั้งหมดพร้อม overpaid", async () => {
    const { rows } = await listDebtCollected({ section: "Fastfone365" });
    const contract = rows.find((r: any) => r.contractNo === "CT0824-NRT001-00023-01");
    if (!contract) { console.log("not found"); return; }
    const payments = (contract as any).payments as any[];
    console.log("\n=== ALL PAYMENTS ===");
    payments.forEach((p: any) => {
      console.log(JSON.stringify({
        period: p.period, splitIndex: p.splitIndex,
        isBadDebtRow: p.isBadDebtRow, isCloseRow: p.isCloseRow,
        total: p.total, overpaid: p.overpaid, badDebt: p.badDebt,
        principal: p.principal, interest: p.interest, fee: p.fee,
        paidAt: p.paidAt, receiptNo: p.receiptNo
      }));
    });
    // Compute what frontend would compute
    const summaryOverpaid = payments.reduce((s: number, p: any) => s + (p.overpaid ?? 0), 0);
    const summaryBadDebt = payments.reduce((s: number, p: any) => s + (p.badDebt ?? 0), 0);
    const summaryTotal = payments.reduce((s: number, p: any) => s + (p.total ?? 0), 0);
    console.log(`\nsummaryOverpaid=${summaryOverpaid}, summaryBadDebt=${summaryBadDebt}, summaryTotal=${summaryTotal}`);
    console.log(`Expected: summaryOverpaid=0, summaryBadDebt=7000, summaryTotal=10750`);
  }, 60000);
});

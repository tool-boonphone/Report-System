/**
 * Debug: Phase 87 fix — CT0824-NRT001-00023-01
 */
import { describe, it, expect } from "vitest";
import { listDebtCollected } from "./debtDb";

describe("Phase 87: CT0824-NRT001-00023-01 bad debt", () => {
  it("ตรวจสอบ payments ของ contract", async () => {
    const { rows } = await listDebtCollected({ section: "Fastfone365" });
    
    const contract = rows.find((r: any) => r.contractNo === "CT0824-NRT001-00023-01");
    
    if (!contract) {
      console.log("Contract not found");
      return;
    }
    
    console.log(`\n=== CT0824-NRT001-00023-01 ===`);
    console.log(`debtStatus: ${(contract as any).debtStatus}`);
    
    // ดู payments
    const payments = (contract as any).payments as any[];
    console.log(`\n=== payments (${payments.length} rows) ===`);
    payments.forEach((p: any) => {
      console.log(`  period=${p.period} isBadDebtRow=${p.isBadDebtRow} badDebt=${p.badDebt} overpaid=${p.overpaid} total=${p.total} paidAt=${p.paidAt}`);
    });
    
    // ตรวจสอบ
    const badDebtRow = payments.find((p: any) => p.isBadDebtRow);
    console.log(`\nbadDebtRow: ${JSON.stringify(badDebtRow)}`);
    
    expect(badDebtRow).toBeDefined();
    expect(badDebtRow?.badDebt).toBeGreaterThan(0);
    expect(badDebtRow?.overpaid).toBe(0);
  }, 60000);
});

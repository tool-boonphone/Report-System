/**
 * Debug test: ตรวจสอบ installments สำหรับ contract 23538 (CT0126-AYA004-22260-01)
 * Phase 86 fix: paid=50 ที่งวด 2 ควรแสดงจาก PAY_REC (partial payment)
 * Phase 85 revised: overpaid=50 จาก TXRT-2 ถูก track ที่ period=2 แต่ carry ไปที่งวด 3
 */
import { describe, it, expect } from "vitest";
import { listDebtTarget } from "./debtDb";

describe("Debug contract 23538 (CT0126-AYA004-22260-01) — Phase 86 fix", () => {
  it("งวด 2 ควรมี paid=50, isCurrentPeriod=true, isPaid=false (สีส้ม)", async () => {
    const { rows } = await listDebtTarget({ section: "Fastfone365" });
    const contract = rows.find((r) => r.contractNo === "CT0126-AYA004-22260-01");
    
    console.log("Contract found:", contract?.contractNo);
    contract?.installments?.forEach((inst) => {
      console.log(
        `  Period ${inst.period}: amount=${inst.amount}, paid=${inst.paid}, ` +
        `isPaid=${inst.isPaid}, isCurrentPeriod=${inst.isCurrentPeriod}, ` +
        `overpaidApplied=${inst.overpaidApplied}, baselineAmount=${inst.baselineAmount}`
      );
    });
    
    expect(contract).toBeDefined();
    
    const period2 = contract?.installments?.find((i) => i.period === 2);
    expect(period2).toBeDefined();
    
    // Phase 86 fix: paid=50 จาก PAY_REC (partial payment)
    expect(period2?.paid).toBeCloseTo(50, 0);
    
    // isCurrentPeriod=true (dueDate=2026-03-31 ≤ today)
    expect(period2?.isCurrentPeriod).toBe(true);
    
    // isPaid=false (paid=50 < amount=3177)
    expect(period2?.isPaid).toBe(false);
    
    // amount=3177 (baseline, overpaid carry ไปที่งวด 3 ไม่ใช่งวด 2)
    expect(period2?.amount).toBeCloseTo(3177, 0);
    
    // isPartialPaid = !isPaid && paid > 0 && paid < amount-0.5
    // = true && 50 > 0 && 50 < 3176.5 = true → สีส้ม
    const isPartialPaid = !period2?.isPaid && (period2?.paid ?? 0) > 0.009 && (period2?.paid ?? 0) < (period2?.amount ?? 0) - 0.5;
    expect(isPartialPaid).toBe(true);
    
    // งวด 3 ควรมี overpaidApplied=50 (carry จาก TXRT-2)
    const period3 = contract?.installments?.find((i) => i.period === 3);
    expect(period3?.overpaidApplied).toBeCloseTo(50, 0);
    expect(period3?.amount).toBeCloseTo(3127, 0);
  }, 30000);
});

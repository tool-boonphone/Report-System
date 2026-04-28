/**
 * Debug: ตรวจสอบ isSuspended ใน installments และ realPaymentsRaw
 */
import { describe, it, expect } from "vitest";
import { listDebtCollected } from "./debtDb";

describe("Phase 87: debug isSuspended", () => {
  it("ตรวจสอบ installments isSuspended", async () => {
    const { rows } = await listDebtCollected({ section: "Fastfone365" });
    
    const contract = rows.find((r: any) => r.contractNo === "CT0824-NRT001-00023-01");
    
    if (!contract) {
      console.log("Contract not found");
      return;
    }
    
    console.log(`\n=== installments detail ===`);
    (contract.installments as any[]).forEach((inst: any) => {
      console.log(`  period=${inst.period} isSuspended=${inst.isSuspended} isClosed=${inst.isClosed} status=${inst.status} inst_status=${inst.inst_status}`);
      // ดู keys ทั้งหมด
      if (inst.period === 4) {
        console.log(`  period=4 all keys: ${Object.keys(inst).join(", ")}`);
      }
    });
    
    // ดู payments ที่ถูก map แล้ว
    console.log(`\n=== payments (mapped) ===`);
    (contract.payments as any[]).forEach((p: any) => {
      console.log(`  period=${p.period} isBadDebtRow=${p.isBadDebtRow} badDebt=${p.badDebt} overpaid=${p.overpaid} total=${p.total} paidAt=${p.paidAt}`);
    });
    
    expect(contract).toBeDefined();
  }, 60000);
});

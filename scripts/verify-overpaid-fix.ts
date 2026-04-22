/**
 * Verify the overpaidApplied fix:
 *   - ext=2187 (สุทธิดา) period 1: should have overpaidApplied = 0 (no false positive)
 *   - ext=1496 period 2: should have overpaidApplied ≈ 153 (real carry from period 1)
 *   - ext=1517 period 2: should have overpaidApplied ≈ 200 (real carry from period 1)
 */
import "dotenv/config";
import { listDebtTarget } from "../server/debtDb";

const { rows } = await listDebtTarget({ section: "Boonphone" });

for (const ext of ["2187", "1496", "1517"]) {
  const c: any = rows.find((r: any) => r.contractExternalId === ext);
  if (!c) {
    console.log(`ext=${ext} not found`);
    continue;
  }
  console.log(`\n=== ${c.contractNo} ${c.customerName} (ext=${ext}, baseline=${c.installmentAmount}) ===`);
  for (const i of c.installments.slice(0, 3) as any[]) {
    console.log(
      `  period ${i.period}: amount=${i.amount} baseline=${i.baselineAmount} overpaidApplied=${i.overpaidApplied} isClosed=${i.isClosed}`,
    );
  }
}

process.exit(0);

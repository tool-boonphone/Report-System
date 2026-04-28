// Debug script: find violations in listDebtTarget
import { listDebtTarget } from '../server/debtDb.ts';

async function main() {
  const { rows } = await listDebtTarget({ section: 'Boonphone' });
  console.log(`Total rows: ${rows.length}`);
  
  const violations = [];
  for (const r of rows) {
    for (const c of r.installments ?? []) {
      if (
        !c.isClosed &&
        !c.isSuspended &&
        c.baselineAmount > 0 &&
        c.paid > 0.01 &&
        c.amount <= 0.01
      ) {
        violations.push({
          contractNo: r.contractNo,
          contractExternalId: r.contractExternalId,
          period: c.period,
          amount: c.amount,
          paid: c.paid,
          baselineAmount: c.baselineAmount,
          isClosed: c.isClosed,
          isSuspended: c.isSuspended,
        });
      }
    }
  }
  
  console.log(`\nViolations: ${violations.length}`);
  for (const v of violations) {
    console.log(JSON.stringify(v));
  }
  
  // Also show full installment data for violating contracts
  const violatingIds = new Set(violations.map(v => v.contractExternalId));
  for (const r of rows) {
    if (!violatingIds.has(r.contractExternalId)) continue;
    console.log(`\n=== ${r.contractNo} (${r.contractExternalId}) ===`);
    for (const c of r.installments ?? []) {
      console.log(`  period=${c.period} amount=${c.amount} paid=${c.paid} baseline=${c.baselineAmount} isClosed=${c.isClosed} isSuspended=${c.isSuspended}`);
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

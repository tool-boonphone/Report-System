/**
 * test-p63l.ts — เรียก listDebtCollected โดยตรงด้วย TypeScript
 * ตรวจสอบว่า carry rows ถูกสร้างสำหรับ CT0925-PKN001-15462-01
 */
import { listDebtCollected } from './server/debtDb';

async function main() {
  console.log('Testing listDebtCollected for Fastfone365...');
  const result = await listDebtCollected({ section: 'Fastfone365' });

  const target = result.rows.find((r: any) => r.contractNo === 'CT0925-PKN001-15462-01');
  if (!target) {
    console.log('Contract not found! Available contracts:', result.rows.slice(0, 3).map((r: any) => r.contractNo));
    process.exit(1);
  }

  console.log(`\n=== Contract: ${target.contractNo} ===`);
  console.log(`Total payments: ${target.payments.length}`);
  for (const pay of target.payments) {
    const isCarry = pay.receiptNo === '(carry)';
    console.log(`  period=${pay.period} | receipt=${pay.receiptNo ?? '(null)'} | paidAt=${pay.paidAt} | total=${pay.total} | overpaid=${pay.overpaid} | isClose=${pay.isCloseRow} ${isCarry ? '← CARRY ROW ✅' : ''}`);
  }

  // Verify carry rows exist
  const carryRows = target.payments.filter((p: any) => p.receiptNo === '(carry)');
  console.log(`\nCarry rows count: ${carryRows.length}`);
  if (carryRows.length === 2) {
    console.log('✅ PASS: 2 carry rows created (period 3 and 4)');
  } else {
    console.log(`❌ FAIL: Expected 2 carry rows, got ${carryRows.length}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

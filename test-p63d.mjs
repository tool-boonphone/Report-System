/**
 * test-p63d.mjs — ทดสอบ listDebtCollected โดยตรงผ่าน DB
 * ตรวจสอบว่า carry rows ถูกสร้างสำหรับงวด 3 และ 4 ของ CT0925-PKN001-15462-01
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load environment
import { config } from 'dotenv';
config({ path: '/home/ubuntu/report-system/.env' });

// Import debtDb functions directly
const { listDebtCollected } = await import('/home/ubuntu/report-system/server/debtDb.ts').catch(async () => {
  // Try compiled version
  return await import('/home/ubuntu/report-system/server/debtDb.js');
});

console.log('Testing listDebtCollected for Fastfone365...');
const result = await listDebtCollected({ section: 'Fastfone365' });

const target = result.rows.find(r => r.contractNo === 'CT0925-PKN001-15462-01');
if (!target) {
  console.log('Contract not found! Available contracts:', result.rows.slice(0, 3).map(r => r.contractNo));
  process.exit(1);
}

console.log(`\n=== Contract: ${target.contractNo} ===`);
console.log(`Total payments: ${target.payments.length}`);
for (const pay of target.payments) {
  const isCarry = pay.receiptNo === '(carry)';
  console.log(`  period=${pay.period} | receipt=${pay.receiptNo ?? '(null)'} | paidAt=${pay.paidAt} | total=${pay.total} | overpaid=${pay.overpaid} | isClose=${pay.isCloseRow} | remark=${pay.remark ?? ''} ${isCarry ? '← CARRY ROW ✅' : ''}`);
}

process.exit(0);

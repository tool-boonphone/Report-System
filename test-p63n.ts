/**
 * test-p63n.ts — Debug installments จาก listDebtTarget
 */
import { listDebtTarget } from './server/debtDb';
import { assignPayPeriods } from './server/debtDb';
import { getDb } from './server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) { console.log('No DB'); process.exit(1); }

  // Get baseRows for this contract only
  const { rows: baseRows } = await listDebtTarget({ section: 'Fastfone365' });
  const c = baseRows.find((r: any) => r.contractNo === 'CT0925-PKN001-15462-01');
  if (!c) {
    console.log('Contract not found in baseRows');
    process.exit(1);
  }
  console.log(`Found contract: ${c.contractNo} | installmentAmount: ${c.installmentAmount}`);
  console.log(`installments from listDebtTarget:`);
  for (const i of c.installments) {
    console.log(`  period=${i.period} | amount=${i.amount}`);
  }

  // Compare with DB installments
  const instResult = await db.execute(sql`
    SELECT period, amount FROM installments
    WHERE section = 'Fastfone365' AND contract_external_id = '16464'
    ORDER BY period
  `);
  const instRows: any[] = (instResult as any)[0] ?? instResult;
  console.log('\ninstallments from DB:');
  for (const r of instRows) {
    console.log(`  period=${r.period} | amount=${r.amount}`);
  }

  // Test assignPayPeriods with both
  const payments = [
    { receipt_no: 'TXRT0925-PKN001-15462-01-1', paid_at: '2025-09-20', total_paid_amount: 3901, principal_paid: 3901, interest_paid: 0, fee_paid: 0, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 70760, bad_debt_amount: 0, payment_external_id: '70760' },
    { receipt_no: 'TXRT0925-PKN001-15462-01-2', paid_at: '2025-10-09', total_paid_amount: 11703, principal_paid: 3901, interest_paid: 0, fee_paid: 0, overpaid_amount: 7802, close_installment_amount: 3901, payment_id: 75192, bad_debt_amount: 0, payment_external_id: '75192' },
    { receipt_no: 'TXRT0925-PKN001-15462-01-3', paid_at: '2025-12-05', total_paid_amount: 3901, principal_paid: 3901, interest_paid: 0, fee_paid: 0, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 87845, bad_debt_amount: 0, payment_external_id: '87845' },
    { receipt_no: 'TXRT0925-PKN001-15462-01-4', paid_at: '2026-02-28', total_paid_amount: 3901, principal_paid: 3901, interest_paid: 0, fee_paid: 0, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 108392, bad_debt_amount: 0, payment_external_id: '108392' },
    { receipt_no: 'TXRT0925-PKN001-15462-01-5', paid_at: '2026-04-03', total_paid_amount: 3901, principal_paid: 3901, interest_paid: 0, fee_paid: 0, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 117711, bad_debt_amount: 0, payment_external_id: '117711' },
    { receipt_no: 'TXRTC0925-PKN001-15462-01', paid_at: '2026-04-20', total_paid_amount: 3120.8, principal_paid: 3120.8, interest_paid: 0, fee_paid: 0, overpaid_amount: 0, close_installment_amount: 3120.8, payment_id: 120748, bad_debt_amount: 0, payment_external_id: '120748' },
  ];

  console.log('\n=== Test with listDebtTarget installments ===');
  const result1 = assignPayPeriods(payments as any, c.installments.map((i: any) => ({ period: i.period, amount: Number(i.amount) || 0 })));
  for (const p of result1) {
    console.log(`  period=${p.period} | receipt=${p.receipt_no} | overpaid=${p.overpaid_amount}`);
  }

  console.log('\n=== Test with DB installments ===');
  const result2 = assignPayPeriods(payments as any, instRows.map((r: any) => ({ period: r.period != null ? Number(r.period) : null, amount: r.amount != null ? Number(r.amount) : 0 })));
  for (const p of result2) {
    console.log(`  period=${p.period} | receipt=${p.receipt_no} | overpaid=${p.overpaid_amount}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * test-p63k.ts — ตรวจสอบ carry rows logic ใน listDebtCollected
 * โดยใช้ข้อมูลจาก DB โดยตรงและ simulate carry rows logic
 */
import { getDb } from './server/db';
import { sql } from 'drizzle-orm';
import { assignPayPeriods } from './server/debtDb';

async function main() {
  const db = await getDb();
  if (!db) { console.log('No DB'); process.exit(1); }

  // Get real payments (same query as listDebtCollected)
  const result = await db.execute(sql`
    SELECT contract_external_id,
           external_id AS payment_external_id,
           paid_at,
           CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.principal_paid')           AS DECIMAL(18,2)) AS principal_paid,
           CAST(JSON_EXTRACT(raw_json, '$.interest_paid')            AS DECIMAL(18,2)) AS interest_paid,
           CAST(JSON_EXTRACT(raw_json, '$.fee_paid')                 AS DECIMAL(18,2)) AS fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')          AS DECIMAL(18,2)) AS overpaid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
           CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')          AS DECIMAL(18,2)) AS bad_debt_amount,
           CAST(JSON_EXTRACT(raw_json, '$.payment_id')               AS UNSIGNED) AS payment_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark,
           status AS ff_status
      FROM payment_transactions
     WHERE section = 'Fastfone365'
       AND contract_external_id = '16464'
     ORDER BY contract_external_id, paid_at, payment_id
  `);

  const rows: any[] = (result as any)[0] ?? result;

  // Apply same filter as listDebtCollected
  const realPaymentsRaw = rows.filter((p: any) => {
    const payExtId = p.payment_external_id as string | null;
    const receiptNo = p.receipt_no as string | null;
    const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
    const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(String(receiptNo));
    return isNumericPayExt || isTxrtReceipt;
  });

  // Get installments
  const instResult = await db.execute(sql`
    SELECT period, amount FROM installments
    WHERE section = 'Fastfone365' AND contract_external_id = '16464'
    ORDER BY period
  `);
  const instRows: any[] = (instResult as any)[0] ?? instResult;
  const installmentList = instRows.map((r: any) => ({
    period: r.period != null ? Number(r.period) : null,
    amount: r.amount != null ? Number(r.amount) : 0,
  }));

  // Get installmentAmount (same as c.installmentAmount in listDebtCollected)
  const contractResult = await db.execute(sql`
    SELECT installment_amount FROM contracts
    WHERE section = 'Fastfone365' AND external_id = '16464'
    LIMIT 1
  `);
  const contractRows: any[] = (contractResult as any)[0] ?? contractResult;
  const installmentAmount = contractRows[0]?.installment_amount != null ? Number(contractRows[0].installment_amount) : null;
  console.log(`installmentAmount: ${installmentAmount}`);

  const paymentsMapped = realPaymentsRaw.map((r: any) => ({
    contract_external_id: '16464',
    period: null,
    payment_external_id: r.payment_external_id ?? null,
    paid_at: r.paid_at ?? null,
    total_paid_amount: r.total_paid_amount != null ? Number(r.total_paid_amount) : null,
    principal_paid: r.principal_paid != null ? Number(r.principal_paid) : null,
    interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
    fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
    penalty_paid: null,
    unlock_fee_paid: null,
    discount_amount: null,
    overpaid_amount: r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
    close_installment_amount: r.close_installment_amount != null ? Number(r.close_installment_amount) : null,
    bad_debt_amount: r.bad_debt_amount != null ? Number(r.bad_debt_amount) : null,
    payment_id: r.payment_id != null ? Number(r.payment_id) : null,
    receipt_no: r.receipt_no ?? null,
    remark: r.remark ?? null,
    ff_status: r.ff_status ?? null,
  }));

  // Run assignPayPeriods
  let tagged: any[] = assignPayPeriods(paymentsMapped as any, installmentList).map((p: any) => ({ ...p, isBadDebtRow: false }));

  console.log('\n=== assignPayPeriods result (before carry rows) ===');
  for (const p of tagged) {
    console.log(`  period=${p.period} | receipt=${p.receipt_no} | overpaid=${p.overpaid_amount} | isClose=${p.isCloseRow}`);
  }

  // Apply carry rows logic (same as listDebtCollected Phase 63)
  const baselineAmount = installmentAmount ?? 0;
  if (baselineAmount > 0) {
    const existingPeriods = new Set<number>();
    for (const p of tagged) {
      if (p.period != null && !p.isCloseRow && !p.isBadDebtRow) {
        existingPeriods.add(p.period);
      }
    }
    const normalPeriods = Array.from(existingPeriods).sort((a, b) => a - b);
    const maxNormal = normalPeriods.length > 0 ? normalPeriods[normalPeriods.length - 1] : 0;
    console.log(`\nmaxNormal=${maxNormal}, existingPeriods=${[...existingPeriods].sort((a,b)=>a-b).join(',')}`);
    
    if (maxNormal > 1) {
      const carryRows: any[] = [];
      for (let pNo = 1; pNo <= maxNormal; pNo++) {
        if (!existingPeriods.has(pNo)) {
          const prevPayments = tagged
            .filter((p: any) => p.period != null && p.period < pNo && !p.isCloseRow && !p.isBadDebtRow)
            .sort((a: any, b: any) => (b.period ?? 0) - (a.period ?? 0));
          const sourcePayment = prevPayments[0];
          const carryPaidAt = sourcePayment?.paid_at ?? null;
          const carryRow: any = {
            period: pNo,
            splitIndex: 0,
            isCloseRow: false,
            isBadDebtRow: false,
            paid_at: carryPaidAt,
            total_paid_amount: 0,
            principal_paid: 0,
            interest_paid: 0,
            fee_paid: 0,
            overpaid_amount: 0,
            receipt_no: '(carry)',
            remark: `(-หักชำระเกิน: ${baselineAmount.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`,
          };
          carryRows.push(carryRow);
          console.log(`  → Creating carry row for period=${pNo} (paidAt=${carryPaidAt})`);
        }
      }
      if (carryRows.length > 0) {
        tagged = [...tagged, ...carryRows].sort((a: any, b: any) => {
          const pa = a.period ?? 9999;
          const pb = b.period ?? 9999;
          if (pa !== pb) return pa - pb;
          const aIsCarry = a.receipt_no === '(carry)';
          const bIsCarry = b.receipt_no === '(carry)';
          if (aIsCarry && !bIsCarry) return 1;
          if (!aIsCarry && bIsCarry) return -1;
          return (a.splitIndex ?? 0) - (b.splitIndex ?? 0);
        });
      }
    }
  }

  console.log('\n=== Final result (with carry rows) ===');
  for (const p of tagged) {
    const isCarry = p.receipt_no === '(carry)';
    console.log(`  period=${p.period} | receipt=${p.receipt_no} | paidAt=${p.paid_at} | total=${p.total_paid_amount} ${isCarry ? '← CARRY ROW ✅' : ''}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * test-p63m.ts — Debug listDebtCollected สำหรับ contract เดียว
 * ตรวจสอบว่า carry rows ถูกสร้างหรือเปล่า
 */
import { getDb } from './server/db';
import { sql } from 'drizzle-orm';
import { assignPayPeriods } from './server/debtDb';
import { listDebtTarget } from './server/debtDb';

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
  console.log(`installments count: ${c.installments?.length}`);

  // Get raw payments
  const payRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           external_id AS payment_external_id,
           paid_at,
           CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.principal_paid')           AS DECIMAL(18,2)) AS principal_paid,
           CAST(JSON_EXTRACT(raw_json, '$.interest_paid')            AS DECIMAL(18,2)) AS interest_paid,
           CAST(JSON_EXTRACT(raw_json, '$.fee_paid')                 AS DECIMAL(18,2)) AS fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_paid')             AS DECIMAL(18,2)) AS penalty_paid,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')          AS DECIMAL(18,2)) AS unlock_fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.discount_amount')          AS DECIMAL(18,2)) AS discount_amount,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')          AS DECIMAL(18,2)) AS overpaid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
           CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')          AS DECIMAL(18,2)) AS bad_debt_amount,
           CAST(JSON_EXTRACT(raw_json, '$.payment_id')               AS UNSIGNED) AS payment_id,
           NULL AS installment_external_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark,
           status AS ff_status
      FROM payment_transactions
     WHERE section = 'Fastfone365'
     ORDER BY contract_external_id, paid_at, payment_id
  `);

  const pRows: any[] = (payRowsRaw as any)[0] ?? payRowsRaw;
  const payByContract = new Map<string, any[]>();
  for (const r of pRows) {
    const key = String(r.contract_external_id ?? '');
    if (!key) continue;
    if (!payByContract.has(key)) payByContract.set(key, []);
    payByContract.get(key)!.push({
      contract_external_id: key,
      period: null,
      payment_external_id: r.payment_external_id ?? null,
      paid_at: r.paid_at ?? null,
      total_paid_amount: r.total_paid_amount != null ? Number(r.total_paid_amount) : null,
      principal_paid: r.principal_paid != null ? Number(r.principal_paid) : null,
      interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
      fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
      penalty_paid: r.penalty_paid != null ? Number(r.penalty_paid) : null,
      unlock_fee_paid: r.unlock_fee_paid != null ? Number(r.unlock_fee_paid) : null,
      discount_amount: r.discount_amount != null ? Number(r.discount_amount) : null,
      overpaid_amount: r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
      close_installment_amount: r.close_installment_amount != null ? Number(r.close_installment_amount) : null,
      bad_debt_amount: r.bad_debt_amount != null ? Number(r.bad_debt_amount) : null,
      payment_id: r.payment_id != null ? Number(r.payment_id) : null,
      receipt_no: r.receipt_no ?? null,
      remark: r.remark ?? null,
      ff_status: r.ff_status ?? null,
    });
  }

  const rawPayments = payByContract.get(c.contractExternalId) ?? [];
  console.log(`rawPayments for ${c.contractExternalId}: ${rawPayments.length}`);

  // Apply same filter as listDebtCollected
  const realPaymentsRaw = rawPayments.filter((p: any) => {
    const payExtId = p.payment_external_id as string | null;
    const receiptNo = p.receipt_no as string | null;
    const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
    const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(String(receiptNo));
    return isNumericPayExt || isTxrtReceipt;
  });
  console.log(`realPaymentsRaw: ${realPaymentsRaw.length}`);
  for (const r of realPaymentsRaw) {
    console.log(`  ${r.paid_at} | receipt=${r.receipt_no} | overpaid=${r.overpaid_amount}`);
  }

  // Run assignPayPeriods
  const realAssigned = assignPayPeriods(
    realPaymentsRaw as any,
    c.installments.map((i: any) => ({ period: i.period, amount: Number(i.amount) || 0 })),
  );
  let tagged: any[] = realAssigned.map((p: any) => ({ ...p, isBadDebtRow: false }));

  console.log('\n=== assignPayPeriods result ===');
  for (const p of tagged) {
    console.log(`  period=${p.period} | receipt=${p.receipt_no} | overpaid=${p.overpaid_amount} | isClose=${p.isCloseRow}`);
  }

  // Apply carry rows logic
  const baselineAmount = c.installmentAmount ?? 0;
  console.log(`\nbaselineAmount: ${baselineAmount}`);
  if (baselineAmount > 0) {
    const existingPeriods = new Set<number>();
    for (const p of tagged) {
      if (p.period != null && !p.isCloseRow && !p.isBadDebtRow) {
        existingPeriods.add(p.period);
      }
    }
    const maxNormal = Math.max(...Array.from(existingPeriods));
    console.log(`maxNormal: ${maxNormal}, existingPeriods: ${[...existingPeriods].sort((a,b)=>a-b).join(',')}`);
    
    if (maxNormal > 1) {
      const carryRows: any[] = [];
      for (let pNo = 1; pNo <= maxNormal; pNo++) {
        if (!existingPeriods.has(pNo)) {
          console.log(`  → Creating carry row for period=${pNo}`);
          carryRows.push({ period: pNo, receipt_no: '(carry)', total_paid_amount: 0 });
        }
      }
      console.log(`carryRows created: ${carryRows.length}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

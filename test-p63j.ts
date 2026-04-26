/**
 * test-p63j.ts — Debug assignPayPeriods ด้วย data จริงจาก DB
 * ตรวจสอบ payment_id และ sort order
 */
import { getDb } from './server/db';
import { sql } from 'drizzle-orm';
import { assignPayPeriods } from './server/debtDb';

async function main() {
  const db = await getDb();
  if (!db) { console.log('No DB'); process.exit(1); }

  // Get raw payments (same query as listDebtCollected)
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

  console.log('=== Real payments (filtered) ===');
  for (const r of realPaymentsRaw) {
    const pif = Number(r.principal_paid??0)+Number(r.interest_paid??0)+Number(r.fee_paid??0);
    console.log(`  ${r.paid_at} | ext_id=${r.payment_external_id} | payment_id=${r.payment_id} | receipt=${r.receipt_no} | overpaid=${r.overpaid_amount} | pif=${pif} | close_inst=${r.close_installment_amount}`);
  }

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

  console.log('\n=== assignPayPeriods result ===');
  const tagged = assignPayPeriods(paymentsMapped as any, installmentList);
  for (const p of tagged) {
    console.log(`  period=${p.period} | receipt=${p.receipt_no} | overpaid=${p.overpaid_amount} | isClose=${p.isCloseRow}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

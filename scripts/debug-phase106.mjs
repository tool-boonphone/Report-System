import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดู payments ของ CT0824-NRT001-00023-01 (contract external_id = 36)
const [pays] = await conn.execute(
  `SELECT external_id AS payment_external_id, paid_at, 
   CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
   JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no
   FROM payment_transactions 
   WHERE contract_no = 'CT0824-NRT001-00023-01' 
   ORDER BY paid_at ASC`
);

console.log('=== All payments ===');
for (const p of pays) {
  const payExtId = p.payment_external_id;
  const receiptNo = p.receipt_no;
  const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
  const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
  const isReal = isNumericPayExt || isTxrtReceipt;
  console.log(`  paid_at=${p.paid_at} | ext_id=${payExtId} | total=${p.total_paid_amount} | receipt=${receiptNo} | isNumeric=${isNumericPayExt} | isTxrt=${isTxrtReceipt} | isReal=${isReal}`);
}

// กรองเฉพาะ real payments
const realPayments = pays.filter(p => {
  const payExtId = p.payment_external_id;
  const receiptNo = p.receipt_no;
  const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
  const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
  return isNumericPayExt || isTxrtReceipt;
});

console.log('\n=== Real payments ===');
for (const p of realPayments) {
  console.log(`  paid_at=${p.paid_at} | ext_id=${p.payment_external_id} | total=${p.total_paid_amount}`);
}

// Phase 106 logic
if (realPayments.length > 0) {
  const sorted = [...realPayments].sort((a, b) => {
    const da = (a.paid_at ?? '').substring(0, 10);
    const db2 = (b.paid_at ?? '').substring(0, 10);
    return da < db2 ? 1 : da > db2 ? -1 : 0;
  });
  const latestDate = (sorted[0].paid_at ?? '').substring(0, 10);
  const latestDatePayments = sorted.filter(p => (p.paid_at ?? '').substring(0, 10) === latestDate);
  const latestDateTotal = latestDatePayments.reduce((sum, p) => sum + Number(p.total_paid_amount ?? 0), 0);
  
  console.log('\n=== Phase 106 Result ===');
  console.log(`  latestDate=${latestDate}`);
  console.log(`  latestDatePayments count=${latestDatePayments.length}`);
  console.log(`  bad_debt_amount=${latestDateTotal}`);
  console.log(`  normalPayments (earlier dates):`);
  const normalPays = realPayments.filter(p => (p.paid_at ?? '').substring(0, 10) !== latestDate);
  for (const p of normalPays) {
    console.log(`    paid_at=${p.paid_at} | total=${p.total_paid_amount}`);
  }
}

await conn.end();

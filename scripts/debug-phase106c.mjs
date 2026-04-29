// Simulate listDebtCollected Phase 106 logic for CT1124-SKA002-3314-01
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 1. Get contract info (simulate listDebtTarget output)
const [contracts] = await conn.execute(`
  SELECT id, contract_no, external_id, status,
         bad_debt_amount, bad_debt_date,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.debtStatus')) AS debt_status_raw
  FROM contracts
  WHERE contract_no = 'CT1124-SKA002-3314-01'
`);
console.log('Contract:', JSON.stringify(contracts[0], null, 2));

// 2. Get payments (simulate payRowsRaw)
const [pays] = await conn.execute(`
  SELECT external_id AS payment_external_id,
         paid_at,
         CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no
  FROM payment_transactions
  WHERE contract_no = 'CT1124-SKA002-3314-01'
  ORDER BY paid_at, external_id
`);

// 3. Filter realPaymentsRaw
const realPaymentsRaw = pays.filter(p => {
  const payExtId = p.payment_external_id;
  const receiptNo = p.receipt_no;
  const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
  const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
  return isNumericPayExt || isTxrtReceipt;
});

console.log('\nrealPaymentsRaw:');
for (const p of realPaymentsRaw) {
  console.log(`  paid_at=${p.paid_at} | ext_id=${p.payment_external_id} | total=${p.total_paid_amount} | receipt=${p.receipt_no}`);
}

// 4. Phase 106 logic
const c = contracts[0];
// Simulate debtStatus from listDebtTarget
// Check what debtStatus would be
const contractStatus = c.status;
console.log('\ncontractStatus:', contractStatus);

// In listDebtTarget, debtStatus is derived from deriveDebtStatus
// For "หนี้เสีย" status, it returns "หนี้เสีย" directly
// So c.debtStatus should be "หนี้เสีย"
const debtStatus = contractStatus; // simplified

console.log('debtStatus:', debtStatus);
console.log('realPaymentsRaw.length:', realPaymentsRaw.length);
console.log('Condition (debtStatus === "หนี้เสีย"):', debtStatus === 'หนี้เสีย');

if (debtStatus === 'หนี้เสีย' && realPaymentsRaw.length > 0) {
  const sortedReal = [...realPaymentsRaw].sort((a, b) => {
    const da = (a.paid_at ?? '').substring(0, 10);
    const db2 = (b.paid_at ?? '').substring(0, 10);
    return da < db2 ? 1 : da > db2 ? -1 : 0;
  });
  const latestDate = (sortedReal[0].paid_at ?? '').substring(0, 10);
  const latestDatePayments = sortedReal.filter(p => (p.paid_at ?? '').substring(0, 10) === latestDate);
  const latestDateTotal = latestDatePayments.reduce((sum, p) => sum + Number(p.total_paid_amount ?? 0), 0);
  
  console.log('\n=== Phase 106 Result ===');
  console.log('latestDate:', latestDate);
  console.log('latestDatePayments count:', latestDatePayments.length);
  console.log('bad_debt_amount:', latestDateTotal);
  console.log('normalPayments (earlier dates):');
  const normalPays = realPaymentsRaw.filter(p => (p.paid_at ?? '').substring(0, 10) !== latestDate);
  for (const p of normalPays) {
    console.log(`  paid_at=${p.paid_at} | total=${p.total_paid_amount}`);
  }
} else {
  console.log('\nPhase 106 NOT triggered!');
  console.log('contractBadDebtAmount from DB:', c.bad_debt_amount);
}

await conn.end();

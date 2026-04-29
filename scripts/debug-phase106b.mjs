import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Simulate exactly what listDebtCollected does
const [pRows] = await conn.execute(`
  SELECT contract_external_id,
         external_id AS payment_external_id,
         paid_at,
         CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
         CAST(JSON_EXTRACT(raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
         CAST(JSON_EXTRACT(raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
         CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount') AS DECIMAL(18,2)) AS bad_debt_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no
    FROM payment_transactions
   WHERE contract_no IN ('CT0824-NRT001-00023-01', 'CT1124-BKK003-2988-01', 'CT1124-SKA002-3314-01')
   ORDER BY contract_external_id, paid_at
`);

// Group by contract
const byContract = {};
for (const r of pRows) {
  const key = String(r.contract_external_id ?? '');
  if (!byContract[key]) byContract[key] = [];
  byContract[key].push(r);
}

for (const [extId, pays] of Object.entries(byContract)) {
  console.log(`\n=== Contract ext_id=${extId} ===`);
  
  // Check paid_at type
  for (const p of pays) {
    console.log(`  paid_at type=${typeof p.paid_at} value=${p.paid_at} | constructor=${p.paid_at?.constructor?.name}`);
    const paidAtStr = p.paid_at instanceof Date 
      ? p.paid_at.toISOString().substring(0, 10)
      : String(p.paid_at ?? '').substring(0, 10);
    console.log(`  -> paidAtStr=${paidAtStr}`);
  }
  
  // Filter real payments
  const realPayments = pays.filter(p => {
    const payExtId = p.payment_external_id;
    const receiptNo = p.receipt_no;
    const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
    const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
    return isNumericPayExt || isTxrtReceipt;
  });
  
  console.log(`  realPayments count=${realPayments.length}`);
  
  if (realPayments.length > 0) {
    const sortedReal = [...realPayments].sort((a, b) => {
      const da = (a.paid_at instanceof Date ? a.paid_at.toISOString() : String(a.paid_at ?? '')).substring(0, 10);
      const db2 = (b.paid_at instanceof Date ? b.paid_at.toISOString() : String(b.paid_at ?? '')).substring(0, 10);
      return da < db2 ? 1 : da > db2 ? -1 : 0;
    });
    
    // Using substring(0,10) on raw paid_at (as current code does)
    const latestDateRaw = ((sortedReal[0]).paid_at ?? '').substring(0, 10);
    console.log(`  latestDate (raw substring)="${latestDateRaw}"`);
    
    // Using Date-aware conversion
    const latestDateSafe = (sortedReal[0].paid_at instanceof Date 
      ? sortedReal[0].paid_at.toISOString() 
      : String(sortedReal[0].paid_at ?? '')).substring(0, 10);
    console.log(`  latestDate (Date-aware)="${latestDateSafe}"`);
    
    const latestDateTotal = sortedReal
      .filter(p => {
        const d = (p.paid_at instanceof Date ? p.paid_at.toISOString() : String(p.paid_at ?? '')).substring(0, 10);
        return d === latestDateSafe;
      })
      .reduce((sum, p) => sum + Number(p.total_paid_amount ?? 0), 0);
    
    console.log(`  bad_debt_amount=${latestDateTotal}`);
    console.log(`  contractBadDebtDate="${latestDateSafe}" (truthy=${!!latestDateSafe})`);
  }
}

await conn.end();

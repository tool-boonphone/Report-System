import mysql from 'mysql2/promise';
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ตรวจสอบ 3 contracts ที่ผิด
const contractIds = ['3030', '36', '3426'];
for (const extId of contractIds) {
  const [rows] = await conn.execute(
    'SELECT contract_no, status, bad_debt_amount, bad_debt_date FROM contracts WHERE external_id = ?',
    [extId]
  );
  const c = rows[0];
  if (!c) { console.log(extId + ': NOT FOUND'); continue; }
  
  // ดู real payments
  const [payments] = await conn.execute(
    `SELECT external_id, paid_at, amount, JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) as receipt_no
     FROM payment_transactions 
     WHERE contract_external_id = ? AND section = 'Fastfone365'
     ORDER BY paid_at`,
    [extId]
  );
  
  const realPayments = payments.filter(p => {
    const isNumeric = p.external_id && /^\d+$/.test(String(p.external_id));
    const isTxrt = p.receipt_no && /^TXRT.*-\d+$/.test(p.receipt_no);
    return isNumeric || isTxrt;
  });
  
  // Phase 106: find latest date
  const sorted = [...realPayments].sort((a, b) => {
    const da = (a.paid_at ?? '').substring(0, 10);
    const db2 = (b.paid_at ?? '').substring(0, 10);
    return da < db2 ? 1 : da > db2 ? -1 : 0;
  });
  const latestDate = sorted.length > 0 ? sorted[0].paid_at.substring(0, 10) : null;
  const latestTotal = sorted.filter(p => p.paid_at.substring(0, 10) === latestDate).reduce((s, p) => s + Number(p.amount), 0);
  const normalPayments = sorted.filter(p => p.paid_at.substring(0, 10) !== latestDate);
  
  console.log(`\n=== ${extId} (${c.contract_no}) ===`);
  console.log(`  status=${c.status}`);
  console.log(`  DB bad_debt_amount=${c.bad_debt_amount}`);
  console.log(`  Phase106 bad_debt_amount=${latestTotal} on ${latestDate}`);
  console.log(`  Normal payments (${normalPayments.length}):`);
  for (const p of normalPayments) {
    console.log(`    paid_at=${p.paid_at.substring(0,10)} | amount=${p.amount}`);
  }
}

await conn.end();

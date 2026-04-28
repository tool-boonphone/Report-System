const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  // หา contract ก่อน - ดู columns ที่มี
  const [cols] = await conn.execute("SHOW COLUMNS FROM contracts LIKE '%period%'");
  console.log('Period columns:', cols.map(c => c.Field));

  const [contracts] = await conn.execute(
    'SELECT external_id, contract_no, status, installment_count, paid_installments FROM contracts WHERE contract_no = ? LIMIT 1',
    ['CT1225-CBI041-16897-02']
  );
  console.log('Contract:', JSON.stringify(contracts[0], null, 2));
  const extId = contracts[0] && contracts[0].external_id;
  if (!extId) { console.log('NOT FOUND'); await conn.end(); return; }

  // ดู installments ทั้งหมด
  const [rows] = await conn.execute(
    'SELECT period, due_date, amount, paid_amount, status FROM installments WHERE contract_external_id = ? ORDER BY period, amount DESC',
    [extId]
  );
  console.log('\nInstallments raw:');
  console.table(rows);

  // สรุปแบบ merge per period
  const byPeriod = new Map();
  for (const row of rows) {
    const p = row.period;
    const rowAmt = Number(row.amount || 0);
    const rowPaid = Number(row.paid_amount || 0);
    const existing = byPeriod.get(p);
    if (!existing) {
      byPeriod.set(p, { base: row, totalPaid: rowPaid });
    } else {
      existing.totalPaid += rowPaid;
      if (rowAmt > Number(existing.base.amount || 0)) existing.base = row;
    }
  }
  const merged = Array.from(byPeriod.values())
    .map(function(e) { return Object.assign({}, e.base, { paid_amount: e.totalPaid }); })
    .sort(function(a, b) { return (a.period || 0) - (b.period || 0); });

  console.log('\nMerged per period (logic ใหม่):');
  merged.forEach(function(r) {
    const outstanding = Number(r.amount) - Number(r.paid_amount);
    const isPaid = outstanding <= 0.001;
    console.log('  Period ' + String(r.period).padStart(2) + ' | amount: ' + String(r.amount).padStart(8) + ' | paid: ' + String(r.paid_amount).padStart(8) + ' | outstanding: ' + outstanding.toFixed(2).padStart(10) + ' | due: ' + r.due_date + ' | ' + (isPaid ? 'PAID' : 'UNPAID'));
  });

  const totalPeriods = merged.length;
  const paidPeriods = merged.filter(function(r) { return (Number(r.amount) - Number(r.paid_amount)) <= 0.001; }).length;
  console.log('\nสรุป: ทั้งหมด ' + totalPeriods + ' งวด | ชำระแล้ว ' + paidPeriods + ' งวด');

  // หางวดสุดท้ายที่ชำระ (งวดที่ paid_amount > 0 ใน raw rows)
  const paidRaw = rows.filter(function(r) { return Number(r.paid_amount) > 0; });
  if (paidRaw.length > 0) {
    const maxPaidPeriod = Math.max.apply(null, paidRaw.map(function(r) { return r.period || 0; }));
    console.log('งวดสุดท้ายที่มี paid_amount > 0: ' + maxPaidPeriod);
  }

  await conn.end();
}
main().catch(console.error);

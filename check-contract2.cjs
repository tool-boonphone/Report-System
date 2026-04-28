const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  // หา contract
  const [contracts] = await conn.execute(
    'SELECT external_id, contract_no, status, installment_count, paid_installments, installment_amount FROM contracts WHERE contract_no = ? LIMIT 1',
    ['CT1225-CBI041-16897-02']
  );
  const c = contracts[0];
  console.log('Contract:', c.contract_no, '| status:', c.status, '| งวดทั้งหมด:', c.installment_count, '| ผ่อนงวดละ:', c.installment_amount, '| paid_installments:', c.paid_installments);
  const extId = c.external_id;

  // ดู payment_transactions ทั้งหมด
  const [payments] = await conn.execute(
    'SELECT external_id, paid_at, amount, method, status FROM payment_transactions WHERE contract_external_id = ? ORDER BY paid_at',
    [extId]
  );
  console.log('\n=== payment_transactions ===');
  console.table(payments);

  // ดู installments raw ทั้งหมด
  const [instRows] = await conn.execute(
    'SELECT period, due_date, amount, paid_amount, status FROM installments WHERE contract_external_id = ? ORDER BY period, amount DESC',
    [extId]
  );
  console.log('\n=== installments raw ===');
  console.table(instRows);

  // Merge per period (logic ใหม่)
  const byPeriod = new Map();
  for (const row of instRows) {
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
    .map(e => Object.assign({}, e.base, { paid_amount: e.totalPaid }))
    .sort((a, b) => (a.period || 0) - (b.period || 0));

  const today = new Date('2026-04-28');
  const installmentAmt = Number(c.installment_amount);

  console.log('\n=== แจกแจงแต่ละงวด (งวดละ', installmentAmt, 'บาท) ===\n');

  for (const inst of merged) {
    const period = inst.period;
    const dueDate = inst.due_date;
    const amount = Number(inst.amount);
    const paid = Number(inst.paid_amount);
    const outstanding = amount - paid;
    const dueMs = dueDate ? Date.parse(dueDate + 'T00:00:00') : null;
    const isPastDue = dueMs ? today.getTime() > dueMs : false;
    const isPaid = outstanding <= 0.001;

    let type = '';
    if (!isPaid && !isPastDue) {
      type = 'ยังไม่ถึงกำหนด';
    } else if (!isPaid && isPastDue) {
      type = 'ค้างชำระ';
    } else if (isPaid && !isPastDue) {
      type = 'ปิดค่างวด (ล่วงหน้า)';
    } else {
      type = 'ชำระปกติ';
    }

    console.log('งวด ' + String(period).padStart(2) + ' | due: ' + dueDate + ' | amount: ' + String(amount).padStart(8) + ' | paid: ' + String(paid).padStart(8) + ' | outstanding: ' + outstanding.toFixed(2).padStart(9) + ' | ' + type);
  }

  await conn.end();
}
main().catch(console.error);

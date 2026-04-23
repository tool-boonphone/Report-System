import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: url.username, password: url.password,
  database: url.pathname.slice(1), ssl: { rejectUnauthorized: true }
});

// Find contracts for สุดใจ เกตุแย้ม
const [contracts] = await conn.execute(`
  SELECT c.external_id, c.contract_no, c.customer_name, c.section,
         c.finance_amount, c.installment_count, c.approve_date, c.status
  FROM contracts c
  WHERE c.customer_name LIKE '%สุดใจ%เกตุแย้ม%' OR c.customer_name LIKE '%เกตุแย้ม%สุดใจ%'
  ORDER BY c.section, c.external_id
`);

console.log(`พบ ${contracts.length} สัญญา สำหรับ สุดใจ เกตุแย้ม\n`);

for (const c of contracts) {
  console.log(`=== สัญญา ${c.contract_no} (ID: ${c.external_id}) [${c.section}] ===`);
  console.log(`  ชื่อ: ${c.customer_name}`);
  console.log(`  สถานะ: ${c.status}`);
  console.log(`  วงเงิน: ${c.finance_amount}, จำนวนงวด: ${c.installment_count}`);
  console.log(`  วันที่อนุมัติ: ${c.approve_date}`);

  // Get all installments
  const [installments] = await conn.execute(`
    SELECT i.period, i.due_date, i.amount, i.paid_amount,
           JSON_EXTRACT(i.raw_json, '$.penalty_due') as penalty_due,
           JSON_EXTRACT(i.raw_json, '$.unlock_fee_due') as unlock_fee_due
    FROM installments i
    WHERE i.section = ? AND i.contract_external_id = ?
    ORDER BY i.period
  `, [c.section, c.external_id]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let totalPaid = 0;
  let currentPeriod = null;
  let totalOutstanding = 0;

  for (const inst of installments) {
    const amount = Number(inst.amount ?? 0);
    const paid = Number(inst.paid_amount ?? 0);
    const dueDate = inst.due_date ? new Date(`${inst.due_date}T00:00:00`) : null;
    const isPast = dueDate && dueDate <= today;
    const isUnpaid = paid < amount - 0.5;
    const penalty = Number(inst.penalty_due ?? 0);
    const unlockFee = Number(inst.unlock_fee_due ?? 0);

    totalPaid += paid;

    if (isPast && isUnpaid && !currentPeriod) {
      currentPeriod = inst;
    }

    if (isPast && isUnpaid) {
      totalOutstanding += (amount - paid) + penalty + unlockFee;
    }
  }

  // Count payment transactions
  const [payments] = await conn.execute(`
    SELECT COUNT(*) as cnt, SUM(CAST(amount AS DECIMAL(18,2))) as total_paid
    FROM payment_transactions
    WHERE section = ? AND contract_external_id = ?
  `, [c.section, c.external_id]);

  console.log(`\n  งวดปัจจุบัน: ${currentPeriod ? `งวดที่ ${currentPeriod.period} (ครบกำหนด ${currentPeriod.due_date})` : 'ไม่มี (จ่ายครบแล้ว)'}`);
  console.log(`  ยอดค้างชำระ (งวดที่ผ่านมา): ${totalOutstanding.toFixed(2)} บาท`);
  console.log(`  ชำระมาแล้วทั้งหมด: ${totalPaid.toFixed(2)} บาท`);
  console.log(`  จำนวนครั้งที่ชำระ: ${payments[0].cnt} ครั้ง (รวม ${Number(payments[0].total_paid ?? 0).toFixed(2)} บาท)`);

  // Show all installments
  console.log(`\n  รายละเอียดทุกงวด:`);
  for (const inst of installments) {
    const amount = Number(inst.amount ?? 0);
    const paid = Number(inst.paid_amount ?? 0);
    const penalty = Number(inst.penalty_due ?? 0);
    const status = paid >= amount - 0.5 ? '✓ จ่ายแล้ว' : (inst.due_date && new Date(`${inst.due_date}T00:00:00`) <= today ? '⚠ ค้างชำระ' : '○ ยังไม่ถึงกำหนด');
    console.log(`    งวด ${inst.period}: due=${inst.due_date} amount=${amount} paid=${paid} penalty=${penalty} [${status}]`);
  }
  console.log('');
}

await conn.end();

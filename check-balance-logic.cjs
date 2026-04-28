const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  // ดึง installments ของสัญญา CT1225-CBI041-16897-02
  const [rows] = await conn.execute(
    `SELECT period, due_date, amount, paid_amount, raw_json
     FROM installments
     WHERE contract_external_id = '20742'
     ORDER BY period, amount DESC`
  );

  // Merge per period (logic ปัจจุบัน)
  const byPeriod = new Map();
  for (const row of rows) {
    const p = row.period;
    const rowAmt = Number(row.amount || 0);
    const rowPaid = Number(row.paid_amount || 0);
    const rj = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json;
    const rowDiscount = Number(rj?.discount || rj?.discount_planned || 0);
    const rowBalance = rj?.balance !== undefined ? Number(rj.balance) : null;

    const existing = byPeriod.get(p);
    if (!existing) {
      byPeriod.set(p, {
        base: row,
        totalPaid: rowPaid,
        totalDiscount: rowDiscount,
        minBalance: rowBalance,
        rj,
      });
    } else {
      existing.totalPaid += rowPaid;
      existing.totalDiscount = Math.max(existing.totalDiscount, rowDiscount);
      if (rowBalance !== null) {
        existing.minBalance = existing.minBalance === null ? rowBalance : Math.min(existing.minBalance, rowBalance);
      }
      if (rowAmt > Number(existing.base.amount || 0)) {
        existing.base = row;
        existing.rj = rj;
      }
    }
  }

  const merged = Array.from(byPeriod.values())
    .map(e => ({
      period: e.base.period,
      due_date: e.base.due_date,
      amount: Number(e.base.amount),
      paid_amount: e.totalPaid,
      discount: e.totalDiscount,
      balance: e.minBalance,
    }))
    .sort((a, b) => a.period - b.period);

  const today = new Date('2026-04-28');

  console.log('สัญญา CT1225-CBI041-16897-02 | งวดละ 6,825 บาท\n');
  console.log('='.repeat(120));
  console.log(
    'งวด'.padEnd(5) +
    'due_date'.padEnd(13) +
    'amount'.padStart(9) +
    'paid'.padStart(9) +
    'discount'.padStart(10) +
    'balance(API)'.padStart(14) +
    '  ' +
    'Logic เดิม (amount-paid)'.padEnd(28) +
    'Logic ใหม่ (balance จาก API)'.padEnd(30)
  );
  console.log('-'.repeat(120));

  for (const inst of merged) {
    const dueMs = Date.parse(inst.due_date + 'T00:00:00');
    const isPastDue = today.getTime() > dueMs;

    // Logic เดิม: outstanding = amount - paid
    const oldOutstanding = inst.amount - inst.paid_amount;
    let oldStatus = '';
    if (oldOutstanding <= 0.001) {
      oldStatus = isPastDue ? '✅ ชำระปกติ' : '🔒 ปิดค่างวด (ล่วงหน้า)';
    } else if (!isPastDue) {
      oldStatus = '⏳ ยังไม่ถึงกำหนด';
    } else {
      const days = Math.floor((today.getTime() - dueMs) / 86400000);
      oldStatus = `❌ ค้างชำระ ${days} วัน`;
    }

    // Logic ใหม่: ใช้ balance จาก raw_json
    const newOutstanding = inst.balance !== null ? inst.balance : (inst.amount - inst.paid_amount - inst.discount);
    let newStatus = '';
    if (newOutstanding <= 0.001) {
      newStatus = isPastDue ? '✅ ชำระปกติ' : '🔒 ปิดค่างวด (ล่วงหน้า)';
    } else if (!isPastDue) {
      newStatus = '⏳ ยังไม่ถึงกำหนด';
    } else {
      const days = Math.floor((today.getTime() - dueMs) / 86400000);
      newStatus = `❌ ค้างชำระ ${days} วัน`;
    }

    const changed = oldStatus !== newStatus ? ' ← เปลี่ยน!' : '';

    console.log(
      String(inst.period).padEnd(5) +
      inst.due_date.padEnd(13) +
      String(inst.amount).padStart(9) +
      String(inst.paid_amount).padStart(9) +
      String(inst.discount).padStart(10) +
      String(inst.balance !== null ? inst.balance : '-').padStart(14) +
      '  ' +
      oldStatus.padEnd(28) +
      newStatus.padEnd(30) +
      changed
    );
  }

  console.log('='.repeat(120));

  // หาสัญญาอื่นที่มี discount > 0 เพื่อแสดงกรณีเพิ่มเติม
  console.log('\n\n--- ตัวอย่างสัญญาอื่นที่มีส่วนลดปิดค่างวด (discount > 0 จาก raw_json) ---\n');
  const [discRows] = await conn.execute(`
    SELECT DISTINCT i.contract_no, i.contract_external_id
    FROM installments i
    WHERE JSON_EXTRACT(i.raw_json, '$.discount') > 0
       OR JSON_EXTRACT(i.raw_json, '$.discount_planned') > 0
    LIMIT 5
  `);
  console.log('สัญญาที่มีส่วนลด:', discRows.map(r => r.contract_no).join(', '));

  await conn.end();
}
main().catch(console.error);

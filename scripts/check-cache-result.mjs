/**
 * ตรวจสอบผลลัพธ์จาก listDebtCollectedStream โดยตรง
 * โดยจำลอง logic เดียวกับที่ server ใช้
 */
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ตรวจสอบ 3 contracts ที่ผิด (Fastfone365)
const contractIds = ['3030', '36', '3426'];
const contractNames = {
  '3030': 'CT1124-BKK003-2988-01',
  '36': 'CT0824-NRT001-00023-01',
  '3426': 'CT1124-SKA002-3314-01',
};

for (const extId of contractIds) {
  // ดู contract
  const [cRows] = await conn.execute(
    'SELECT contract_no, status, bad_debt_amount, bad_debt_date FROM contracts WHERE external_id = ? AND section = "Fastfone365"',
    [extId]
  );
  const c = cRows[0];
  if (!c) { console.log(extId + ': NOT FOUND in Fastfone365'); continue; }

  // ดู installments
  const [instRows] = await conn.execute(
    `SELECT period, status, amount, paid_amount FROM installments 
     WHERE contract_external_id = ? AND section = 'Fastfone365' 
     ORDER BY period`,
    [extId]
  );

  // ตรวจสอบ isBadDebtContract
  const SUSPEND_CODES = new Set(['ยกเลิกสัญญา', 'หนี้เสีย', 'ระงับสัญญา']);
  const hasSuspendedInstallment = instRows.some(i => SUSPEND_CODES.has(i.status ?? ''));
  const isBadDebtContract = c.status === 'หนี้เสีย' || hasSuspendedInstallment;

  // ดู real payments
  const [payRows] = await conn.execute(
    `SELECT external_id, paid_at, amount, JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) as receipt_no
     FROM payment_transactions 
     WHERE contract_external_id = ? AND section = 'Fastfone365'
     ORDER BY paid_at`,
    [extId]
  );

  const realPayments = payRows.filter(p => {
    const isNumeric = p.external_id && /^\d+$/.test(String(p.external_id));
    const isTxrt = p.receipt_no && /^TXRT.*-\d+$/.test(p.receipt_no);
    return isNumeric || isTxrt;
  });

  // Phase 106: find latest date
  let contractBadDebtAmount = c.bad_debt_amount ? Number(c.bad_debt_amount) : null;
  let contractBadDebtDate = c.bad_debt_date ?? null;

  if (isBadDebtContract && realPayments.length > 0) {
    const sorted = [...realPayments].sort((a, b) => {
      const da = (a.paid_at ?? '').substring(0, 10);
      const db2 = (b.paid_at ?? '').substring(0, 10);
      return da < db2 ? 1 : da > db2 ? -1 : 0;
    });
    const latestDate = sorted[0].paid_at.substring(0, 10);
    const latestTotal = sorted
      .filter(p => p.paid_at.substring(0, 10) === latestDate)
      .reduce((s, p) => s + Number(p.amount), 0);
    contractBadDebtAmount = latestTotal;
    contractBadDebtDate = latestDate;
  }

  console.log(`\n=== ${extId} (${c.contract_no}) ===`);
  console.log(`  contract.status=${c.status}`);
  console.log(`  isBadDebtContract=${isBadDebtContract} (hasSuspendedInstallment=${hasSuspendedInstallment})`);
  console.log(`  realPayments count=${realPayments.length}`);
  console.log(`  Phase106 bad_debt_amount=${contractBadDebtAmount} on ${contractBadDebtDate}`);
  
  // ตรวจสอบ expected
  const expected = { '3030': 3000, '36': 7000, '3426': 7400 };
  const ok = contractBadDebtAmount === expected[extId];
  console.log(`  Expected=${expected[extId]} → ${ok ? '✅ CORRECT' : '❌ WRONG'}`);
}

await conn.end();

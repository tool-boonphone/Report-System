/**
 * Debug script: ตรวจสอบ payments/TXRT/TXRTC ของสัญญา CT1225-AYA013-19847-01
 * Usage: npx tsx scripts/debug-contract-aya.mjs
 */
import mysql from "mysql2/promise";

const pool = await mysql.createPool(process.env.DATABASE_URL);

const CONTRACT_NO = "CT1225-AYA013-19847-01";

// 1. หา contract
const [contracts] = await pool.execute(
  `SELECT id, external_id, contract_no, installment_count, status, partner_status, section
   FROM contracts
   WHERE contract_no = ?
   LIMIT 5`,
  [CONTRACT_NO]
);

if (contracts.length === 0) {
  console.log("ไม่พบสัญญา:", CONTRACT_NO);
  await pool.end();
  process.exit(0);
}

const c = contracts[0];
console.log("=== Contract ===");
console.log(`contract_no: ${c.contract_no}`);
console.log(`external_id: ${c.external_id}`);
console.log(`installment_count (totalPeriods): ${c.installment_count}`);
console.log(`status: ${c.status}`);
console.log(`partner_status: ${c.partner_status}`);
console.log(`section: ${c.section}`);

const extId = c.external_id;
const totalPeriods = c.installment_count ?? 0;

// 2. ดึง installments (ใช้ external_id ของ contract)
const [insts] = await pool.execute(
  `SELECT id, external_id, contract_external_id, period, due_date, amount, paid_amount, status,
          JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
          CAST(JSON_EXTRACT(raw_json, '$.principal_due') AS DECIMAL(18,2)) AS principal_due,
          CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount
   FROM installments
   WHERE contract_external_id = ?
   ORDER BY period, id`,
  [extId]
);

console.log(`\n=== Installments (${insts.length} rows) ===`);
for (const r of insts) {
  console.log(
    `  period=${r.period} receipt_no=${r.receipt_no} amount=${r.amount} paid=${r.paid_amount} close_inst=${r.close_installment_amount} status=${r.status}`
  );
}

// 3. ดึง payments
const [payments] = await pool.execute(
  `SELECT id, external_id, contract_external_id, amount, status,
          JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
          CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount
   FROM payment_transactions
   WHERE contract_external_id = ?
   ORDER BY id`,
  [extId]
);

console.log(`\n=== Payments (${payments.length} rows) ===`);
for (const r of payments) {
  console.log(
    `  receipt_no=${r.receipt_no} amount=${r.amount} close_inst=${r.close_installment_amount} status=${r.status}`
  );
}

// 4. วิเคราะห์ TXRTC
const txrtcPayments = payments.filter(r => String(r.receipt_no ?? "").startsWith("TXRTC"));
const txrtPayments = payments.filter(r => {
  const rn = String(r.receipt_no ?? "");
  return rn.startsWith("TXRT") && !rn.startsWith("TXRTC");
});

console.log(`\nTXRT payments: ${txrtPayments.length}`);
console.log(`TXRTC payments: ${txrtcPayments.length}`);

if (txrtcPayments.length > 0) {
  console.log("\nTXRTC details:");
  for (const r of txrtcPayments) {
    console.log(`  receipt_no=${r.receipt_no} amount=${r.amount} close_inst=${r.close_installment_amount}`);
  }
}

// 5. วิเคราะห์ Pattern (simplified)
if (txrtcPayments.length === 0) {
  console.log("\n→ ไม่มี TXRTC → สัญญาปกติ ไม่มี 'ปิดค่างวดแล้ว'");
} else {
  // หา maxNormalPeriod จาก TXRT ปกติ
  const txrtPeriods = txrtPayments
    .map(r => {
      const rn = String(r.receipt_no ?? "");
      // parse suffix เช่น TXRT1225AYA01319847-01-3 → period = 3
      const parts = rn.split("-");
      const last = parts[parts.length - 1];
      return parseInt(last, 10);
    })
    .filter(n => !isNaN(n));
  
  const maxNormalPeriod = txrtPeriods.length > 0 ? Math.max(...txrtPeriods) : 0;
  
  console.log(`\nmaxNormalPeriod (จาก TXRT suffix): ${maxNormalPeriod}`);
  console.log(`totalPeriods: ${totalPeriods}`);
  
  if (maxNormalPeriod >= totalPeriods) {
    console.log(`\n→ Pattern 3: maxNormal(${maxNormalPeriod}) >= totalPeriods(${totalPeriods})`);
    console.log("   ทุกงวด = ยอดปกติ (ไม่มี 'ปิดค่างวดแล้ว' เลย)");
  } else if (maxNormalPeriod === 0) {
    console.log(`\n→ Pattern 1: maxNormal=0`);
    console.log(`   งวด 1 = ยอดปกติ, งวด 2..${totalPeriods} = 'ปิดค่างวดแล้ว'`);
  } else {
    console.log(`\n→ Pattern 2: maxNormal=${maxNormalPeriod}`);
    console.log(`   งวด 1..${maxNormalPeriod} = ยอดปกติ`);
    console.log(`   งวด ${maxNormalPeriod + 1}..${totalPeriods} = 'ปิดค่างวดแล้ว'`);
  }
}

await pool.end();

import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);

// ดึง installments ของสัญญา CT1225-AYA013-19847-01 (contract_external_id = 20980)
const [insts] = await pool.execute(
  `SELECT period, amount, paid_amount, status
   FROM installments
   WHERE contract_external_id = '20980'
   ORDER BY period ASC`,
  []
);

console.log("=== Installments ===");
for (const r of insts) {
  console.log(`  Period ${r.period}: amount=${r.amount}, paid=${r.paid_amount}, status=${r.status}`);
}

// ดึง TXRT payments
const [pays] = await pool.execute(
  `SELECT 
     JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
     amount,
     CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
     CAST(JSON_EXTRACT(raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
     CAST(JSON_EXTRACT(raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid
   FROM payment_transactions
   WHERE contract_external_id = '20980'
     AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRT%'
   ORDER BY JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no'))`,
  []
);

console.log("\n=== Payments ===");
for (const r of pays) {
  console.log(`  ${r.receipt_no}: amount=${r.amount}, close_inst=${r.close_installment_amount}, principal=${r.principal_paid}`);
}

// Simulate Phase 79B fix
const installmentList = insts.map(r => ({ period: Number(r.period), amount: Number(r.amount) }));
const txrtOnly = pays.filter(r => !r.receipt_no.startsWith('TXRTC'));

// Amount-based cursor walk
let cursor = 0;
let coveredCurrent = 0;
let suffixMatchesPeriod = true;
const contractNo = 'CT1225-AYA013-19847-01';
const prefix79b = 'TXRT' + contractNo.replace(/^CT/, '') + '-';

for (const tp of txrtOnly) {
  const suffix79b = tp.receipt_no.slice(prefix79b.length);
  const suffixNum = parseInt(suffix79b, 10);
  const expectedPeriod = installmentList[cursor]?.period ?? null;
  if (expectedPeriod !== suffixNum) {
    console.log(`\n  MISMATCH: ${tp.receipt_no} suffix=${suffixNum} but amount-based period=${expectedPeriod} → useSuffixPeriod=false`);
    suffixMatchesPeriod = false;
    break;
  }
  const consumed = Number(tp.close_installment_amount ?? 0);
  coveredCurrent += consumed;
  while (cursor < installmentList.length - 1 && installmentList[cursor].amount > 0 && coveredCurrent >= installmentList[cursor].amount - 0.5) {
    coveredCurrent -= installmentList[cursor].amount;
    cursor++;
  }
  if (coveredCurrent < 0) coveredCurrent = 0;
}

console.log(`\nuseSuffixPeriod: ${suffixMatchesPeriod}`);

// Now simulate amount-based walk with Phase 79 filter
cursor = 0;
coveredCurrent = 0;
const outerSet = new Set();
for (const tp of txrtOnly) {
  const period = installmentList[cursor]?.period ?? null;
  const closeAmt = Number(tp.close_installment_amount ?? 0);
  const principalPaid = Number(tp.principal_paid ?? 0);
  
  if (closeAmt === 0 && principalPaid === 0) {
    console.log(`  SKIP (Phase 79): ${tp.receipt_no} → period ${period} (close_inst=0, principal=0)`);
  } else {
    if (period != null) outerSet.add(period);
    console.log(`  ADD period ${period} from ${tp.receipt_no}`);
  }
  
  const consumed = closeAmt > 0 ? closeAmt : principalPaid > 0 ? principalPaid : Number(tp.amount);
  coveredCurrent += consumed;
  while (cursor < installmentList.length - 1 && installmentList[cursor].amount > 0 && coveredCurrent >= installmentList[cursor].amount - 0.5) {
    coveredCurrent -= installmentList[cursor].amount;
    cursor++;
  }
  if (coveredCurrent < 0) coveredCurrent = 0;
}

const maxNormal = outerSet.size > 0 ? Math.max(...outerSet) : 0;
console.log(`\nnormalPeriods: ${[...outerSet].sort((a,b)=>a-b).join(', ')}`);
console.log(`maxNormalPeriod: ${maxNormal}`);
console.log(`→ งวด 1..${maxNormal} ยอดปกติ (สีเขียว), งวด ${maxNormal+1}..${installmentList.length} ปิดค่างวดแล้ว`);

await pool.end();

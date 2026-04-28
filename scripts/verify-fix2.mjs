import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);

const [insts] = await pool.execute(
  `SELECT period, MAX(amount) AS amount
   FROM installments
   WHERE contract_external_id = '20980'
   GROUP BY period
   ORDER BY period ASC`,
  []
);

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

// Dedup schedule
const scheduleCheck = insts.map(r => ({ period: Number(r.period), amount: Number(r.amount) }));
const txrtOnly = pays.filter(r => !r.receipt_no.startsWith('TXRTC'));
const contractNo = 'CT1225-AYA013-19847-01';
const prefix79b = 'TXRT' + contractNo.replace(/^CT/, '') + '-';

// Phase 79B: validate suffix vs amount-based period
let cursor = 0;
let coveredCurrent = 0;
let suffixMatchesPeriod = true;

for (const tp of txrtOnly) {
  const suffix79b = tp.receipt_no.slice(prefix79b.length);
  const suffixNum = parseInt(suffix79b, 10);
  const expectedPeriod = scheduleCheck[cursor]?.period ?? null;
  if (expectedPeriod !== suffixNum) {
    console.log(`  MISMATCH: ${tp.receipt_no} suffix=${suffixNum} but amount-based period=${expectedPeriod}`);
    suffixMatchesPeriod = false;
    break;
  } else {
    console.log(`  MATCH: ${tp.receipt_no} suffix=${suffixNum} = period=${expectedPeriod}`);
  }
  const closeAmt = Number(tp.close_installment_amount ?? 0);
  const pif = Number(tp.principal_paid ?? 0) + Number(tp.interest_paid ?? 0);
  const consumed = closeAmt > 0 ? closeAmt : pif > 0 ? pif : Number(tp.amount);
  coveredCurrent += consumed;
  while (cursor < scheduleCheck.length - 1 && scheduleCheck[cursor].amount > 0 && coveredCurrent >= scheduleCheck[cursor].amount - 0.5) {
    coveredCurrent -= scheduleCheck[cursor].amount;
    cursor++;
  }
  if (coveredCurrent < 0) coveredCurrent = 0;
}

console.log(`\nuseSuffixPeriod: ${suffixMatchesPeriod}`);

// Amount-based walk + Phase 79 filter
cursor = 0;
coveredCurrent = 0;
const outerSet = new Set();
for (const tp of txrtOnly) {
  const period = scheduleCheck[cursor]?.period ?? null;
  const closeAmt = Number(tp.close_installment_amount ?? 0);
  const principalPaid = Number(tp.principal_paid ?? 0);
  
  const closeAmtVal = tp.close_installment_amount;
  if (closeAmtVal !== null) {
    if (Number(closeAmtVal) === 0) {
      console.log(`  SKIP (Phase 79): ${tp.receipt_no} → period ${period} (close_inst=0)`);
    } else {
      if (period != null) outerSet.add(period);
      console.log(`  ADD period ${period} from ${tp.receipt_no}`);
    }
  } else {
    if (principalPaid === 0) {
      console.log(`  SKIP (Phase 79 fallback): ${tp.receipt_no} → period ${period} (principal=0)`);
    } else {
      if (period != null) outerSet.add(period);
      console.log(`  ADD period ${period} from ${tp.receipt_no}`);
    }
  }
  
  const consumed = closeAmt > 0 ? closeAmt : principalPaid > 0 ? principalPaid : Number(tp.amount);
  coveredCurrent += consumed;
  while (cursor < scheduleCheck.length - 1 && scheduleCheck[cursor].amount > 0 && coveredCurrent >= scheduleCheck[cursor].amount - 0.5) {
    coveredCurrent -= scheduleCheck[cursor].amount;
    cursor++;
  }
  if (coveredCurrent < 0) coveredCurrent = 0;
}

const maxNormal = outerSet.size > 0 ? Math.max(...outerSet) : 0;
console.log(`\nnormalPeriods: ${[...outerSet].sort((a,b)=>a-b).join(', ')}`);
console.log(`maxNormalPeriod: ${maxNormal}`);
console.log(`→ งวด 1..${maxNormal} ยอดปกติ (สีเขียว), งวด ${maxNormal+1}..${scheduleCheck.length} ปิดค่างวดแล้ว`);

await pool.end();

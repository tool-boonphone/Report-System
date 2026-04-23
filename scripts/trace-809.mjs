import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: url.username, password: url.password,
  database: url.pathname.slice(1), ssl: { rejectUnauthorized: true }
});

// Get ALL installments for contract 809 to trace the computation
const [rows] = await conn.execute(`
  SELECT i.period, i.due_date, i.amount, i.paid_amount,
         JSON_EXTRACT(i.raw_json, '$.principal_due') as principal_due,
         JSON_EXTRACT(i.raw_json, '$.interest_due') as interest_due,
         JSON_EXTRACT(i.raw_json, '$.fee_due') as fee_due,
         JSON_EXTRACT(i.raw_json, '$.penalty_due') as penalty_due,
         JSON_EXTRACT(i.raw_json, '$.overpaid_amount') as overpaid_amount,
         c.finance_amount, c.installment_count
  FROM installments i
  JOIN contracts c ON c.external_id = i.contract_external_id AND c.section = i.section
  WHERE i.section = 'Boonphone' AND i.contract_external_id = '809'
  ORDER BY i.period
`);

console.log('Contract 809 all installments:');
for (const r of rows) {
  console.log(`  P${r.period} due=${r.due_date} amount=${r.amount} paid=${r.paid_amount} principal=${r.principal_due} interest=${r.interest_due} fee=${r.fee_due} penalty=${r.penalty_due} overpaid=${r.overpaid_amount}`);
}

// Trace the computation for period 2
const c = rows[0]; // contract info
const financeAmt = Number(c.finance_amount);
const periods = Number(c.installment_count);
console.log(`\nfinance_amount=${financeAmt}, installment_count=${periods}`);

const basePrincipal = Math.ceil(financeAmt / periods);
const baseFee = 100;
console.log(`basePrincipal=ceil(${financeAmt}/${periods})=${basePrincipal}`);

// For period 1:
const p1 = rows.find(r => r.period === 1);
const p1Amount = Number(p1.amount);
const p1Paid = Number(p1.paid_amount);
const p1Baseline = basePrincipal + baseFee + Math.max(0, p1Amount - basePrincipal - baseFee); // approx
console.log(`\nPeriod 1: amount=${p1Amount}, paid=${p1Paid}`);
console.log(`  paidInFullButZeroedByApi = !isClosed && amount<=0.009 && paid>0.009 = ${p1Amount <= 0.009 && p1Paid > 0.009}`);

// Check if period 1 has overpaid_amount in raw_json
const p1Overpaid = Number(p1.overpaid_amount ?? 0);
console.log(`  overpaid_amount in raw_json = ${p1Overpaid}`);
console.log(`  paid > amount? ${p1Paid > p1Amount} (${p1Paid} > ${p1Amount})`);

// For period 2:
const p2 = rows.find(r => r.period === 2);
const p2Amount = Number(p2.amount);
const p2Paid = Number(p2.paid_amount);
const p2Overpaid = Number(p2.overpaid_amount ?? 0);
console.log(`\nPeriod 2: amount=${p2Amount}, paid=${p2Paid}, overpaid_in_raw=${p2Overpaid}`);

// The overpaid carry logic: if p1.paid > p1.amount → overpaidApplied = p1.paid - p1.amount
const overpaidCarry = Math.max(0, p1Paid - p1Amount);
console.log(`  overpaidCarry from period 1 = max(0, ${p1Paid} - ${p1Amount}) = ${overpaidCarry}`);

// Now compute period 2 with overpaid carry
const p2RawPrincipal = Number(p2.principal_due ?? 0);
const p2RawInterest = Number(p2.interest_due ?? 0);
const p2RawFee = Number(p2.fee_due ?? 0);
const p2BaseInterest = p2Amount - basePrincipal - baseFee; // approx baseline interest
const p2Baseline = basePrincipal + baseFee + p2BaseInterest;

console.log(`  p2 baseline ≈ ${p2Baseline}`);
console.log(`  effectiveBaseline = max(0, ${p2Baseline} - ${overpaidCarry}) = ${Math.max(0, p2Baseline - overpaidCarry)}`);

if (p2Baseline > 0.009) {
  const ratio = Math.max(0, p2Baseline - overpaidCarry) / p2Baseline;
  const effPrincipal = Math.max(0, basePrincipal * ratio);
  const effInterest = Math.max(0, p2BaseInterest * ratio);
  const effFee = Math.max(0, baseFee * ratio);
  console.log(`  ratio = ${ratio.toFixed(4)}`);
  console.log(`  effectivePrincipal = ${effPrincipal.toFixed(2)}`);
  console.log(`  effectiveInterest = ${effInterest.toFixed(2)}`);
  console.log(`  effectiveFee = ${effFee.toFixed(2)}`);
  
  // Then scale to fit apiAmount
  const apiAmount = p2Amount > 0.009 ? p2Amount : null;
  const netBaseline = apiAmount != null ? Math.max(0, apiAmount - 0 - 0) : Math.max(0, p2Baseline - overpaidCarry);
  const formulaTotal = effPrincipal + effInterest + effFee;
  const scale = formulaTotal > 0.009 && netBaseline > 0.009 ? netBaseline / formulaTotal : 1;
  console.log(`  apiAmount=${apiAmount}, netBaseline=${netBaseline}, formulaTotal=${formulaTotal.toFixed(2)}, scale=${scale.toFixed(4)}`);
  console.log(`  FINAL principal=${(effPrincipal * scale).toFixed(2)}, interest=${(effInterest * scale).toFixed(2)}, fee=${(effFee * scale).toFixed(2)}`);
  console.log(`  FINAL amount=${apiAmount ?? (effPrincipal * scale + effInterest * scale + effFee * scale)}`);
}

await conn.end();

import mysql from 'mysql2/promise';

const conn_str = process.env.DATABASE_URL;
const conn = await mysql.createConnection(conn_str);

// Get contract external_id
const [cRows] = await conn.execute(`
  SELECT external_id, installment_amount, installment_count, finance_amount, status
  FROM contracts 
  WHERE contract_no = 'CT0925-PKN001-15462-01' LIMIT 1
`);
const c = cRows[0];
const extId = String(c.external_id);
const baselineAmount = Number(c.installment_amount);
console.log('extId:', extId, 'baselineAmount:', baselineAmount, 'status:', c.status);

// Get installments
const [instRows] = await conn.execute(`
  SELECT period, due_date, 
         CAST(amount AS DECIMAL(18,2)) AS amount,
         CAST(paid_amount AS DECIMAL(18,2)) AS paid_amount,
         status AS inst_status,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS installment_status_code
  FROM installments
  WHERE contract_external_id = ?
  ORDER BY period
`, [extId]);

console.log('\nInstallments:');
for (const r of instRows) {
  console.log(`  period ${r.period}: amount=${r.amount}, paid=${r.paid_amount}, status=${r.inst_status}, code=${r.installment_status_code}`);
}

// Get payments with receipt_no
const [payRows] = await conn.execute(`
  SELECT contract_external_id,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
         CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount,
         CAST(amount AS DECIMAL(18,2)) AS amount,
         paid_at
  FROM payment_transactions
  WHERE contract_external_id = ?
  AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) IS NOT NULL
  ORDER BY paid_at
`, [extId]);

// Build closedByContract and overpaidByContractPeriod
const normalPeriodsByContract = new Map();
const closeDatesByContract = new Map();
const overpaidByContractPeriod = new Map();

for (const pr of payRows) {
  const key = String(pr.contract_external_id);
  const receipt = String(pr.receipt_no);
  if (receipt.startsWith('TXRTC')) {
    const arr = closeDatesByContract.get(key) || [];
    arr.push(pr.paid_at);
    closeDatesByContract.set(key, arr);
  } else {
    const m = /-0\d-(\d+)/.exec(receipt);
    if (!m) continue;
    const period = Number(m[1]);
    const set = normalPeriodsByContract.get(key) || new Set();
    set.add(period);
    normalPeriodsByContract.set(key, set);
    const overpaid = Number(pr.overpaid_amount ?? 0);
    if (overpaid > 0) {
      let periodMap = overpaidByContractPeriod.get(key);
      if (!periodMap) {
        periodMap = new Map();
        overpaidByContractPeriod.set(key, periodMap);
      }
      const existing = periodMap.get(period);
      periodMap.set(period, {
        amount: (existing?.amount ?? 0) + overpaid,
        paidAt: existing?.paidAt ?? (pr.paid_at ? String(pr.paid_at) : null),
      });
    }
  }
}

const closedByContract = new Map();
for (const key of closeDatesByContract.keys()) {
  const normalPeriods = normalPeriodsByContract.get(key);
  const maxNormalPeriod = normalPeriods && normalPeriods.size > 0 ? Math.max(...normalPeriods) : 0;
  closedByContract.set(key, maxNormalPeriod);
}

const maxClosedPeriod = closedByContract.get(extId) ?? 0;
console.log('\nmaxClosedPeriod:', maxClosedPeriod);
console.log('overpaidByContractPeriod:', Object.fromEntries([...overpaidByContractPeriod.entries()].map(([k, v]) => [k, Object.fromEntries(v)])));

// Build carryForPeriod
const carryForPeriod = new Map();
const periodMap = overpaidByContractPeriod.get(extId);
if (periodMap && baselineAmount != null && baselineAmount > 0) {
  const overpaidEntries = Array.from(periodMap.entries()).sort((a, b) => a[0] - b[0]);
  const sortedPeriods = instRows.map(r => r.period != null ? Number(r.period) : 0).filter(p => p > 0).sort((a, b) => a - b);
  
  for (const [srcPeriod, { amount: overpaidAmt, paidAt: srcPaidAt }] of overpaidEntries) {
    let remainingCarry = overpaidAmt;
    for (const targetPeriod of sortedPeriods) {
      if (targetPeriod <= srcPeriod) continue;
      if (remainingCarry < 0.009) break;
      const targetInst = instRows.find(r => Number(r.period) === targetPeriod);
      if (targetInst == null) continue;
      const targetPaid = Number(targetInst.paid_amount ?? 0);
      const targetIsClosed = closedByContract.has(extId) && maxClosedPeriod > 0 && targetPeriod > 1 && targetPeriod >= maxClosedPeriod;
      const targetIsSuspended = false;
      if (targetIsClosed || targetIsSuspended) continue;
      const targetRawAmount = Number(targetInst.amount ?? 0);
      const targetPaidInFullWithReduced = (targetRawAmount > 0.009) && (baselineAmount > 0) &&
        (targetRawAmount < baselineAmount - 0.5) && (targetPaid >= targetRawAmount - 0.5);
      if (targetPaidInFullWithReduced) continue;
      const carryUsed = Math.min(remainingCarry, baselineAmount);
      const existing = carryForPeriod.get(targetPeriod);
      carryForPeriod.set(targetPeriod, {
        carryUsed: (existing?.carryUsed ?? 0) + carryUsed,
        sourcePaidAt: existing?.sourcePaidAt ?? srcPaidAt,
      });
      remainingCarry = Math.max(0, remainingCarry - carryUsed);
    }
  }
}

console.log('\ncarryForPeriod:');
for (const [k, v] of carryForPeriod.entries()) {
  console.log(`  period ${k}: carryUsed=${v.carryUsed}`);
}

// Now simulate processContract for each period
console.log('\nPeriod analysis:');
for (const r of instRows) {
  const periodNo = Number(r.period);
  const paid = Number(r.paid_amount ?? 0);
  const rawAmount = Number(r.amount ?? 0);
  const isClosed = closedByContract.has(extId) && maxClosedPeriod > 0 && periodNo > 1 && periodNo >= maxClosedPeriod;
  const isSuspended = false;
  
  let overpaidApplied = 0;
  let overpaidCarryLabel = null;
  if (!isClosed && !isSuspended && periodNo > 0) {
    const carryEntry = carryForPeriod.get(periodNo);
    if (carryEntry && carryEntry.carryUsed > 0.009) {
      overpaidApplied = carryEntry.carryUsed;
      overpaidCarryLabel = `(-หักชำระเกิน: ${Math.round(carryEntry.carryUsed).toLocaleString('th-TH')})`;
    }
  }
  
  const isFullyCoveredByCarry = overpaidApplied > 0.009 && baselineAmount > 0 && overpaidApplied >= baselineAmount - 0.5 && paid < 0.009;
  
  let displayAmount = rawAmount;
  if (isClosed || isSuspended) {
    displayAmount = 0;
  } else if (isFullyCoveredByCarry) {
    displayAmount = 0;
  }
  
  console.log(`  period ${periodNo}: isClosed=${isClosed}, overpaidApplied=${overpaidApplied}, isFullyCoveredByCarry=${isFullyCoveredByCarry}, displayAmount=${displayAmount}, label=${overpaidCarryLabel}`);
}

await conn.end();

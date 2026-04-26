import mysql from 'mysql2/promise';

const conn_str = process.env.DATABASE_URL;
const conn = await mysql.createConnection(conn_str);

// Check TXRTC receipts for this contract
const [rows] = await conn.execute(`
  SELECT contract_external_id, 
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
         paid_at
  FROM payment_transactions
  WHERE contract_external_id = (SELECT external_id FROM contracts WHERE contract_no = 'CT0925-PKN001-15462-01' LIMIT 1)
  AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) IS NOT NULL
  ORDER BY paid_at
`);

// Simulate closedByContract logic
const normalPeriodsByContract = new Map();
const closeDatesByContract = new Map();

for (const pr of rows) {
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
  }
}

console.log('normalPeriodsByContract:', Object.fromEntries([...normalPeriodsByContract.entries()].map(([k, v]) => [k, Array.from(v)])));
console.log('closeDatesByContract keys:', Array.from(closeDatesByContract.keys()));

const closedByContract = new Map();
for (const key of closeDatesByContract.keys()) {
  const normalPeriods = normalPeriodsByContract.get(key);
  const maxNormalPeriod = normalPeriods && normalPeriods.size > 0 ? Math.max(...normalPeriods) : 0;
  closedByContract.set(key, maxNormalPeriod);
  console.log(`closedByContract[${key}] = maxNormalPeriod = ${maxNormalPeriod}`);
}

// Now simulate carryForPeriod with closedByContract
const extId = Array.from(closedByContract.keys())[0];
const maxClosedPeriod = closedByContract.get(extId) ?? 0;
console.log(`\nextId: ${extId}, maxClosedPeriod: ${maxClosedPeriod}`);

// installments from DB
const instList = [
  { period: 1, due_date: '2025-10-15', amount: 3901, paid_amount: 3901 },
  { period: 2, due_date: '2025-11-15', amount: 3901, paid_amount: 3901 },
  { period: 3, due_date: '2025-12-15', amount: 3901, paid_amount: 3901 },
  { period: 4, due_date: '2026-01-15', amount: 3901, paid_amount: 3901 },
  { period: 5, due_date: '2026-02-15', amount: 3901, paid_amount: 3901 },
  { period: 6, due_date: '2026-03-15', amount: 3901, paid_amount: 3901 },
  { period: 7, due_date: '2026-04-15', amount: 3901, paid_amount: 3901 },
  { period: 8, due_date: '2026-05-15', amount: 3901, paid_amount: 3120.80 },
];

const baselineAmount = 3901;
const overpaidByContractPeriod = new Map();
const innerMap = new Map();
innerMap.set(2, { amount: 7802, paidAt: '2025-10-09' });
overpaidByContractPeriod.set(extId, innerMap);

const carryForPeriod = new Map();
const periodMap = overpaidByContractPeriod.get(extId);
if (periodMap && baselineAmount != null && baselineAmount > 0) {
  const overpaidEntries = Array.from(periodMap.entries()).sort((a, b) => a[0] - b[0]);
  const sortedPeriods = instList.map(r => r.period != null ? Number(r.period) : 0).filter(p => p > 0).sort((a, b) => a - b);
  
  for (const [srcPeriod, { amount: overpaidAmt, paidAt: srcPaidAt }] of overpaidEntries) {
    let remainingCarry = overpaidAmt;
    console.log(`\nsrcPeriod: ${srcPeriod}, overpaidAmt: ${overpaidAmt}`);
    for (const targetPeriod of sortedPeriods) {
      if (targetPeriod <= srcPeriod) continue;
      if (remainingCarry < 0.009) break;
      const targetInst = instList.find(r => Number(r.period) === targetPeriod);
      if (targetInst == null) continue;
      const targetPaid = Number(targetInst.paid_amount ?? 0);
      // Check isClosed
      const targetIsClosed = closedByContract.has(extId) && maxClosedPeriod > 0 && targetPeriod > 1 && targetPeriod >= maxClosedPeriod;
      const targetIsSuspended = false; // not suspended
      console.log(`  targetPeriod: ${targetPeriod}, targetIsClosed: ${targetIsClosed} (maxClosedPeriod=${maxClosedPeriod})`);
      if (targetIsClosed || targetIsSuspended) {
        console.log(`  -> SKIP (closed or suspended)`);
        continue;
      }
      const targetRawAmount = Number(targetInst.amount ?? 0);
      const targetPaidInFullWithReduced = (targetRawAmount > 0.009) && (baselineAmount > 0) &&
        (targetRawAmount < baselineAmount - 0.5) && (targetPaid >= targetRawAmount - 0.5);
      if (targetPaidInFullWithReduced) {
        console.log(`  -> SKIP (paidInFullWithReduced)`);
        continue;
      }
      const carryUsed = Math.min(remainingCarry, baselineAmount);
      const existing = carryForPeriod.get(targetPeriod);
      carryForPeriod.set(targetPeriod, {
        carryUsed: (existing?.carryUsed ?? 0) + carryUsed,
        sourcePaidAt: existing?.sourcePaidAt ?? srcPaidAt,
      });
      remainingCarry = Math.max(0, remainingCarry - carryUsed);
      console.log(`  carryUsed: ${carryUsed}, remainingCarry after: ${remainingCarry}`);
    }
  }
}

console.log('\ncarryForPeriod:');
for (const [k, v] of carryForPeriod.entries()) {
  console.log(`  period ${k}: carryUsed=${v.carryUsed}`);
}

await conn.end();

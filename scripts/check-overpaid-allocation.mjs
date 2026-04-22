// Check whether Boonphone API already deducts overpaid_amount from the next
// installment's `amount`, or whether we have to do it ourselves.
//
// Approach:
//   1. Find payments with overpaid_amount > 0 along with (contract_external_id, period).
//   2. For each, fetch the NEXT installment (period+1) of the same contract and
//      compare its `amount` against:
//        - contracts.installment_amount  (baseline)
//        - installments of earlier periods (also baseline)
//      If amount(N+1) < baseline → API has already deducted.
//      If amount(N+1) == baseline → we need to deduct ourselves.
//
// Usage: node scripts/check-overpaid-allocation.mjs
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection({
  uri: url,
  ssl: { rejectUnauthorized: false },
});

// 1. Pull payments with overpaid > 0 (limit a handful per contract)
const [payRows] = await conn.query(`
  SELECT pt.contract_external_id,
         pt.paid_at,
         CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid,
         CAST(JSON_EXTRACT(pt.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
         JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) AS receipt_no
    FROM payment_transactions pt
   WHERE pt.section = 'Boonphone'
     AND CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) > 0
   ORDER BY pt.contract_external_id, pt.paid_at
   LIMIT 500
`);
console.log(`found ${payRows.length} overpaid payments (sample 500)`);

// 2. For each payment, load installments for that contract
const grouped = new Map();
for (const r of payRows) {
  const k = String(r.contract_external_id);
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(r);
}

// Only analyze first ~20 distinct contracts for readability
const contractsToCheck = [...grouped.keys()].slice(0, 500);

let apiDeducted = 0;
let apiNotDeducted = 0;
let inconclusive = 0;
const samples = [];

for (const extId of contractsToCheck) {
  const [instRows] = await conn.query(
    `SELECT period,
            CAST(amount AS DECIMAL(18,2)) AS amount,
            CAST(JSON_EXTRACT(raw_json, '$.principal_due') AS DECIMAL(18,2)) AS principal_due,
            CAST(JSON_EXTRACT(raw_json, '$.interest_due') AS DECIMAL(18,2)) AS interest_due,
            CAST(JSON_EXTRACT(raw_json, '$.fee_due') AS DECIMAL(18,2)) AS fee_due
       FROM installments
      WHERE section = 'Boonphone' AND contract_external_id = ?
      ORDER BY period`,
    [extId],
  );
  const [cRows] = await conn.query(
    `SELECT installment_amount FROM contracts WHERE section='Boonphone' AND external_id = ?`,
    [extId],
  );
  const baseline = cRows[0]?.installment_amount != null ? Number(cRows[0].installment_amount) : null;

  // Derive: for each overpaid payment, look up the NEXT installment and compare.
  const payments = grouped.get(extId) ?? [];
  for (const p of payments) {
    // Guess period from receipt_no suffix "-N" if present, else skip
    let periodFromReceipt = null;
    const m = p.receipt_no ? String(p.receipt_no).match(/-(\d+)$/) : null;
    if (m) periodFromReceipt = Number(m[1]);

    // Use periodFromReceipt if available; otherwise find the installment whose
    // amount approximately equals the principal+interest+fee paid in this tx.
    const period = periodFromReceipt;
    if (!period) continue;
    const next = instRows.find((i) => Number(i.period) === period + 1);
    if (!next) continue;

    const amt = Number(next.amount);
    const diff = baseline != null ? amt - baseline : null;

    let verdict;
    if (diff != null && diff < -0.5) {
      verdict = "API_DEDUCTED";
      apiDeducted += 1;
    } else if (diff != null && Math.abs(diff) <= 0.5) {
      verdict = "API_NOT_DEDUCTED";
      apiNotDeducted += 1;
    } else {
      verdict = "INCONCLUSIVE";
      inconclusive += 1;
    }

    if (samples.length < 10) {
      samples.push({
        contract: extId,
        period_paid: period,
        overpaid: Number(p.overpaid),
        close_amt: Number(p.close_amt || 0),
        next_period: period + 1,
        next_amount: amt,
        baseline_installment_amount: baseline,
        diff_vs_baseline: diff,
        verdict,
      });
    }
  }
}

console.log("\n=== Sample rows ===");
console.table(samples);
console.log("\n=== Tally ===");
console.log({ apiDeducted, apiNotDeducted, inconclusive });

await conn.end();

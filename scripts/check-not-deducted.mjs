import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});

// Re-run the scan and keep only NOT-DEDUCTED cases with full details
const [payRows] = await conn.query(`
  SELECT pt.contract_external_id,
         pt.paid_at,
         CAST(JSON_EXTRACT(pt.raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid,
         CAST(JSON_EXTRACT(pt.raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
         CAST(JSON_EXTRACT(pt.raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
         CAST(JSON_EXTRACT(pt.raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
         CAST(JSON_EXTRACT(pt.raw_json, '$.fee_paid') AS DECIMAL(18,2)) AS fee_paid,
         JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) AS receipt_no
    FROM payment_transactions pt
   WHERE pt.section='Boonphone'
     AND CAST(JSON_EXTRACT(pt.raw_json,'$.overpaid_amount') AS DECIMAL(18,2)) > 0
   ORDER BY pt.contract_external_id, pt.paid_at
`);

const grouped = new Map();
for (const r of payRows) {
  const k = String(r.contract_external_id);
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(r);
}

const notDeducted = [];
for (const [extId, payments] of grouped) {
  const [instRows] = await conn.query(
    `SELECT period, CAST(amount AS DECIMAL(18,2)) AS amount FROM installments WHERE section='Boonphone' AND contract_external_id=? ORDER BY period`,
    [extId]);
  const [cRows] = await conn.query(
    `SELECT installment_amount FROM contracts WHERE section='Boonphone' AND external_id=?`,[extId]);
  const baseline = cRows[0]?.installment_amount != null ? Number(cRows[0].installment_amount) : null;
  for (const p of payments) {
    const m = p.receipt_no ? String(p.receipt_no).match(/-(\d+)$/) : null;
    if (!m) continue;
    const period = Number(m[1]);
    const next = instRows.find(i => Number(i.period)===period+1);
    if (!next) continue;
    const amt = Number(next.amount);
    if (baseline != null && Math.abs(amt - baseline) <= 0.5 && Number(p.overpaid) > 0.5) {
      notDeducted.push({
        contract: extId,
        period, next_period: period+1,
        overpaid: Number(p.overpaid),
        next_amount: amt,
        baseline,
        all_installments: instRows.slice(0, Math.min(8, instRows.length)).map(i=>({p:Number(i.period),a:Number(i.amount)})),
        receipt: p.receipt_no,
      });
    }
  }
}
console.log('NOT_DEDUCTED cases:', notDeducted.length);
console.log(JSON.stringify(notDeducted.slice(0, 20), null, 2));
await conn.end();

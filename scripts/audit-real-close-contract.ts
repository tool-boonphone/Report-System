import 'dotenv/config';
import mysql from 'mysql2/promise';

const c = await mysql.createConnection(process.env.DATABASE_URL);

// Inspect raw_json keys to find any close-contract / prepay field.
console.log('--- Distinct top-level keys in payment_transactions.raw_json ---');
const [keys] = await c.execute(`
  SELECT DISTINCT k.key_name
    FROM payment_transactions p,
         JSON_TABLE(JSON_KEYS(p.raw_json), '$[*]' COLUMNS (
           key_name VARCHAR(100) PATH '$'
         )) k
   WHERE p.section = 'Boonphone'
   LIMIT 200
`).catch(() => [[]]);
console.log(keys);

// Look for payments where amount >> baseline (strong close-contract signal).
console.log('\n--- Payments where paid >> baseline (candidate close-contract) ---');
const [big] = await c.execute(`
  SELECT p.contract_external_id,
         CAST(ct.installment_amount AS DECIMAL(18,2)) AS baseline,
         CAST(p.amount AS DECIMAL(18,2)) AS paid_amount,
         ROUND(CAST(p.amount AS DECIMAL(18,2)) / CAST(ct.installment_amount AS DECIMAL(18,2)), 2) AS multiplier,
         JSON_UNQUOTE(JSON_EXTRACT(p.raw_json, '$.receipt_no')) AS receipt_no,
         JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS close_inst,
         JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS overpaid,
         p.paid_at
    FROM payment_transactions p
    JOIN contracts ct ON ct.external_id = p.contract_external_id AND ct.section = p.section
   WHERE p.section = 'Boonphone'
     AND CAST(ct.installment_amount AS DECIMAL(18,2)) > 0
     AND CAST(p.amount AS DECIMAL(18,2)) > CAST(ct.installment_amount AS DECIMAL(18,2)) * 2
   ORDER BY multiplier DESC
   LIMIT 15
`);
console.table(big);

// Also show a full raw_json for one big payment so we can eyeball other fields.
console.log('\n--- Full raw_json of biggest payment ---');
const [biggest]: any = await c.execute(`
  SELECT p.contract_external_id, p.amount, p.raw_json
    FROM payment_transactions p
    JOIN contracts ct ON ct.external_id = p.contract_external_id AND ct.section = p.section
   WHERE p.section = 'Boonphone'
     AND CAST(ct.installment_amount AS DECIMAL(18,2)) > 0
     AND CAST(p.amount AS DECIMAL(18,2)) > CAST(ct.installment_amount AS DECIMAL(18,2)) * 2
   ORDER BY p.amount DESC
   LIMIT 1
`);
if (Array.isArray(biggest) && biggest[0]) {
  console.log('contract:', biggest[0].contract_external_id, 'amount:', biggest[0].amount);
  console.log(biggest[0].raw_json);
}

await c.end();

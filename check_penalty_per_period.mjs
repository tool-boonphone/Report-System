import { createConnection } from 'mysql2/promise';

const url = process.env.DATABASE_URL;
const urlObj = new URL(url);
const conn = await createConnection({
  host: urlObj.hostname,
  port: +urlObj.port,
  user: urlObj.username,
  password: urlObj.password,
  database: urlObj.pathname.slice(1).split('?')[0],
  ssl: { rejectUnauthorized: false }
});

// Find a contract with penalty_due > 0 and check all periods
const [rows] = await conn.query(`
  SELECT i.contract_external_id, i.period, i.due_date,
    CAST(JSON_EXTRACT(i.raw_json, '$.penalty_due') AS DECIMAL(18,2)) as penalty_due,
    CAST(JSON_EXTRACT(i.raw_json, '$.unlock_fee_due') AS DECIMAL(18,2)) as unlock_fee_due,
    CAST(JSON_EXTRACT(i.raw_json, '$.amount') AS DECIMAL(18,2)) as amount,
    CAST(JSON_EXTRACT(i.raw_json, '$.paid_amount') AS DECIMAL(18,2)) as paid_amount
  FROM bp_installments i
  WHERE i.contract_external_id = 1001
  ORDER BY i.period
`);
console.log('Contract 1001 - all periods:');
console.table(rows);

// Also check a contract with mixed penalty_due (some periods have it, some don't)
const [rows2] = await conn.query(`
  SELECT i.contract_external_id, i.period, i.due_date,
    CAST(JSON_EXTRACT(i.raw_json, '$.penalty_due') AS DECIMAL(18,2)) as penalty_due,
    CAST(JSON_EXTRACT(i.raw_json, '$.unlock_fee_due') AS DECIMAL(18,2)) as unlock_fee_due,
    CAST(JSON_EXTRACT(i.raw_json, '$.amount') AS DECIMAL(18,2)) as amount
  FROM bp_installments i
  WHERE i.contract_external_id IN (
    SELECT DISTINCT contract_external_id FROM bp_installments
    WHERE CAST(JSON_EXTRACT(raw_json, '$.penalty_due') AS DECIMAL(18,2)) > 0
    LIMIT 1
  )
  ORDER BY i.period
  LIMIT 12
`);
console.log('\nFirst contract with penalty_due > 0:');
console.table(rows2);

await conn.end();

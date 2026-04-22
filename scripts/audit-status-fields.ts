/**
 * Audit: find all fields inside bp_contracts.raw_json and installments.raw_json
 * that could indicate "ระงับสัญญา" (suspended) or "หนี้เสีย" (bad debt) status
 * and their status-change dates. Also list sample contracts per status so the
 * backend can correctly derive the from-period.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL!);
const pool = mysql.createPool({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  // 1. Distinct status values present in bp_contracts
  const [statusRows] = await pool.query<any[]>(`
    SELECT contract_status, debt_status, COUNT(*) AS cnt
    FROM contracts
    GROUP BY contract_status, debt_status
    ORDER BY cnt DESC
  `);
  console.log("\n=== bp_contracts — distinct contract_status / debt_status ===");
  console.table(statusRows);

  // 2. Look at raw_json keys for one suspended and one bad-debt sample
  const [cols] = await pool.query<any[]>(`
    SHOW COLUMNS FROM contracts
  `);
  console.log("\n=== bp_contracts columns ===");
  console.log(cols.map((c: any) => c.Field).join(", "));

  // 3. Try several candidate status codes commonly used
  const candidates = [
    "SUSPENDED",
    "suspended",
    "BAD_DEBT",
    "bad_debt",
    "ระงับสัญญา",
    "หนี้เสีย",
  ];
  for (const c of candidates) {
    const [sampleRows] = await pool.query<any[]>(
      `
      SELECT contract_no, contract_external_id, contract_status, debt_status,
             JSON_EXTRACT(raw_json, '$.suspend_date') AS suspend_date,
             JSON_EXTRACT(raw_json, '$.bad_debt_date') AS bad_debt_date,
             JSON_EXTRACT(raw_json, '$.suspended_at') AS suspended_at,
             JSON_EXTRACT(raw_json, '$.status_change_date') AS status_change_date,
             JSON_EXTRACT(raw_json, '$.closed_at') AS closed_at
      FROM contracts
      WHERE contract_status = ? OR debt_status = ?
      LIMIT 3
    `,
      [c, c],
    );
    if (sampleRows.length > 0) {
      console.log(`\n=== Sample rows for status = "${c}" ===`);
      console.table(sampleRows);
    }
  }

  // 4. Dump raw_json top-level keys for ANY suspended/bad-debt contract
  const [anyRow] = await pool.query<any[]>(`
    SELECT contract_no, contract_external_id, contract_status, debt_status, raw_json
    FROM contracts
    WHERE contract_status LIKE '%suspend%'
       OR contract_status LIKE '%bad%'
       OR contract_status LIKE '%ระงับ%'
       OR contract_status LIKE '%เสีย%'
       OR debt_status LIKE '%suspend%'
       OR debt_status LIKE '%bad%'
       OR debt_status LIKE '%ระงับ%'
       OR debt_status LIKE '%เสีย%'
    LIMIT 5
  `);
  console.log(`\n=== Contracts matching suspend/bad-debt pattern (${anyRow.length} found) ===`);
  for (const r of anyRow) {
    console.log(`\n${r.contract_no} (ext=${r.contract_external_id})`);
    console.log(`  contract_status=${r.contract_status}, debt_status=${r.debt_status}`);
    const raw = typeof r.raw_json === "string" ? JSON.parse(r.raw_json) : r.raw_json;
    const topKeys = Object.keys(raw || {}).filter((k) =>
      /(status|date|suspend|bad|debt|close|end)/i.test(k),
    );
    console.log(`  raw_json matching keys:`);
    for (const k of topKeys) {
      console.log(`    ${k} = ${JSON.stringify(raw[k])}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

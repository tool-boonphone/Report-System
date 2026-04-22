/**
 * Audit script: inspect raw_json of payment_transactions + installments
 * to find arrears/penalty/split fields that Boonphone API sends.
 *
 * Run: pnpm tsx scripts/audit-payment-fields.ts
 */
import mysql from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

const DB_URL = process.env.DATABASE_URL!;

async function main() {
  const conn = await mysql.createConnection(DB_URL);

  // 0. Columns
  const [ptCols] = await conn.query("DESCRIBE payment_transactions") as any[];
  console.log("\n=== payment_transactions columns ===");
  console.log((ptCols as any[]).map((r: any) => r.Field).join(", "));

  const [instCols] = await conn.query("DESCRIBE installments") as any[];
  console.log("\n=== installments columns ===");
  console.log((instCols as any[]).map((r: any) => r.Field).join(", "));

  // 1. Sample 5 payments — use actual columns: id, section, external_id, contract_no, paid_at, amount, raw_json
  const [rows] = await conn.query(`
    SELECT id, section, contract_no, paid_at, amount, raw_json
    FROM payment_transactions
    WHERE amount > 0
    ORDER BY paid_at DESC
    LIMIT 5
  `) as any[];

  console.log("\n=== Sample payments (top 5) ===");
  for (const r of rows as any[]) {
    console.log(`\n--- id:${r.id} section:${r.section} contract:${r.contract_no} amount:${r.amount} paid_at:${r.paid_at} ---`);
    let raw: any = {};
    try { raw = typeof r.raw_json === "string" ? JSON.parse(r.raw_json) : r.raw_json; } catch {}
    console.log("  All raw_json keys:", Object.keys(raw).join(", "));
    // Show all non-null/non-zero values
    for (const [k, v] of Object.entries(raw)) {
      if (v !== null && v !== "" && v !== 0 && v !== "0" && v !== "0.00") {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  // 2. Find payment with penalty > 0 in raw_json
  const [penaltyRows] = await conn.query(`
    SELECT id, section, contract_no, paid_at, amount, raw_json
    FROM payment_transactions
    WHERE JSON_EXTRACT(raw_json, '$.penalty_paid') > 0
    ORDER BY paid_at DESC
    LIMIT 3
  `) as any[];

  console.log("\n=== Payments with penalty_paid > 0 in raw_json (top 3) ===");
  if ((penaltyRows as any[]).length === 0) {
    console.log("  (none found — trying different key names...)");
    // Try other penalty key names
    for (const key of ["penalty", "fine", "overdue_fee", "late_fee", "ค่าปรับ"]) {
      const [pr] = await conn.query(`
        SELECT id, contract_no, amount, raw_json
        FROM payment_transactions
        WHERE JSON_EXTRACT(raw_json, '$.${key}') > 0
        LIMIT 1
      `) as any[];
      if ((pr as any[]).length > 0) {
        console.log(`  Found with key '${key}':`, (pr as any[])[0].contract_no);
      }
    }
  }
  for (const r of penaltyRows as any[]) {
    console.log(`\n--- id:${r.id} contract:${r.contract_no} amount:${r.amount} ---`);
    let raw: any = {};
    try { raw = typeof r.raw_json === "string" ? JSON.parse(r.raw_json) : r.raw_json; } catch {}
    for (const [k, v] of Object.entries(raw)) {
      if (v !== null && v !== "" && v !== 0 && v !== "0" && v !== "0.00") {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  // 3. Sample installments — show columns + raw_json keys
  const [instRows] = await conn.query(`
    SELECT *
    FROM installments
    WHERE source = 'boonphone'
    ORDER BY due_date DESC
    LIMIT 2
  `) as any[];

  console.log("\n=== Sample installments (top 2) ===");
  for (const r of instRows as any[]) {
    const { raw_json, ...rest } = r;
    console.log(`\n--- ${JSON.stringify(rest)} ---`);
    let raw: any = {};
    try { raw = typeof raw_json === "string" ? JSON.parse(raw_json) : raw_json; } catch {}
    console.log("  All raw_json keys:", Object.keys(raw).join(", "));
    const interesting = Object.entries(raw).filter(([k]) =>
      /arrear|outstanding|penalty|remain|overdue|balance|carry|accum|total|amount|principal|interest|fee/i.test(k)
    );
    if (interesting.length) {
      console.log("  Interesting keys:");
      for (const [k, v] of interesting) console.log(`    ${k}: ${v}`);
    }
  }

  // 4. Check if installments has source column
  const hasSource = (instCols as any[]).some((r: any) => r.Field === "source");
  if (!hasSource) {
    console.log("\n  (installments has no 'source' column — querying without filter)");
    const [instRows2] = await conn.query(`
      SELECT * FROM installments ORDER BY due_date DESC LIMIT 2
    `) as any[];
    for (const r of instRows2 as any[]) {
      const { raw_json, ...rest } = r;
      console.log(`\n--- ${JSON.stringify(rest)} ---`);
      let raw: any = {};
      try { raw = typeof raw_json === "string" ? JSON.parse(raw_json) : raw_json; } catch {}
      console.log("  All raw_json keys:", Object.keys(raw).join(", "));
    }
  }

  await conn.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Audit installments table columns and raw_json structure.
 * Run: pnpm tsx scripts/audit-installments.ts
 */
import mysql from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  // Columns
  const [cols] = await conn.query("DESCRIBE installments") as any[];
  console.log("\n=== installments columns ===");
  console.log((cols as any[]).map((r: any) => r.Field).join(", "));

  // Sample 3 rows
  const [rows] = await conn.query(
    "SELECT * FROM installments ORDER BY due_date DESC LIMIT 3"
  ) as any[];

  console.log("\n=== Sample installments (top 3) ===");
  for (const r of rows as any[]) {
    const { raw_json, ...rest } = r;
    console.log(`\n--- ${JSON.stringify(rest)} ---`);
    let raw: any = {};
    try { raw = typeof raw_json === "string" ? JSON.parse(raw_json) : raw_json; } catch {}
    console.log("  keys:", Object.keys(raw).join(", "));
    for (const [k, v] of Object.entries(raw)) {
      if (v !== null && v !== "" && v !== 0 && v !== "0" && v !== "0.00") {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  // Check if there are arrears-related fields in installments raw_json
  const [arrearRows] = await conn.query(`
    SELECT id, raw_json
    FROM installments
    WHERE JSON_EXTRACT(raw_json, '$.arrears_amount') > 0
       OR JSON_EXTRACT(raw_json, '$.outstanding_amount') > 0
       OR JSON_EXTRACT(raw_json, '$.overdue_amount') > 0
    LIMIT 3
  `) as any[];

  console.log("\n=== Installments with arrears in raw_json ===");
  if ((arrearRows as any[]).length === 0) {
    console.log("  (none found — arrears not stored in installments raw_json)");
  }
  for (const r of arrearRows as any[]) {
    let raw: any = {};
    try { raw = typeof r.raw_json === "string" ? JSON.parse(r.raw_json) : r.raw_json; } catch {}
    console.log(`  id:${r.id}`, JSON.stringify(raw));
  }

  // Check contracts table for arrears fields
  const [contractCols] = await conn.query("DESCRIBE contracts") as any[];
  console.log("\n=== contracts columns ===");
  console.log((contractCols as any[]).map((r: any) => r.Field).join(", "));

  // Sample contract raw_json
  const [contractRows] = await conn.query(
    "SELECT * FROM contracts ORDER BY created_at DESC LIMIT 2"
  ) as any[];
  console.log("\n=== Sample contracts raw_json keys ===");
  for (const r of contractRows as any[]) {
    const { raw_json, ...rest } = r;
    let raw: any = {};
    try { raw = typeof raw_json === "string" ? JSON.parse(raw_json) : raw_json; } catch {}
    console.log(`  contract: ${r.contract_no}`);
    const arrearKeys = Object.entries(raw).filter(([k]) =>
      /arrear|outstanding|penalty|remain|overdue|balance|carry|accum|total_due|ค้าง/i.test(k)
    );
    if (arrearKeys.length) {
      for (const [k, v] of arrearKeys) console.log(`    ${k}: ${v}`);
    } else {
      console.log("  (no arrear keys in contract raw_json)");
    }
  }

  await conn.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

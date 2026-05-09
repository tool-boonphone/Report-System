/**
 * triggerPopulate.mjs — Trigger populateDebtCache for both sections directly
 * Run: node scripts/triggerPopulate.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Load env
const dotenv = require("dotenv");
dotenv.config({ path: "/home/ubuntu/report-system/.env" });

// We need to import the compiled server code — use ts-node/esm or compile first
// Instead, call the HTTP endpoint with a service token approach
// Since we can't easily import TS directly, use the internal DB approach

const mysql = require("mysql2/promise");

async function clearAndLog(section) {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [r1] = await conn.execute(`SELECT COUNT(*) AS cnt FROM debt_target_cache WHERE section = ?`, [section]);
  const [r2] = await conn.execute(`SELECT COUNT(*) AS cnt FROM debt_collected_cache WHERE section = ?`, [section]);
  console.log(`[${section}] target_cache: ${r1[0].cnt} rows, collected_cache: ${r2[0].cnt} rows`);
  await conn.end();
}

async function main() {
  console.log("=== Cache status before populate ===");
  await clearAndLog("Fastfone365");
  await clearAndLog("Boonphone");
}

main().catch(console.error);

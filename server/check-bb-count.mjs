import { createConnection } from "mysql2/promise";
import * as dotenv from "dotenv";
import { readFileSync } from "fs";

// Load env
try {
  const env = readFileSync("/home/ubuntu/report-system/.env", "utf-8");
  env.split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim();
  });
} catch {}

const url = process.env.DATABASE_URL;
if (!url) { console.log("no DATABASE_URL"); process.exit(1); }

const conn = await createConnection(url);
const [r1] = await conn.execute("SELECT COUNT(DISTINCT contract_external_id) AS cnt FROM debt_collected_cache WHERE section = 'Boonphone'");
const [r2] = await conn.execute("SELECT COUNT(DISTINCT contract_external_id) AS cnt FROM debt_target_cache WHERE section = 'Boonphone'");
console.log("collected distinct contracts:", r1[0]?.cnt);
console.log("target distinct contracts:", r2[0]?.cnt);

// Check first 5 contract_external_id in collected
const [r3] = await conn.execute("SELECT DISTINCT contract_external_id FROM debt_collected_cache WHERE section = 'Boonphone' LIMIT 5");
console.log("sample collected IDs:", r3.map(r => r.contract_external_id));

await conn.end();

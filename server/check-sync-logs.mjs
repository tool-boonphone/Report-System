import { createConnection } from "mysql2/promise";
import { readFileSync } from "fs";

let envStr = "";
try { envStr = readFileSync("/home/ubuntu/report-system/.env", "utf-8"); } catch {}
envStr.split("\n").forEach((line) => {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
});

const conn = await createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute(
  "SELECT * FROM sync_logs ORDER BY started_at DESC LIMIT 20"
);
rows.forEach((r) =>
  console.log(
    r.section?.padEnd(15),
    r.stage?.padEnd(20),
    r.status?.padEnd(12),
    r.started_at?.toISOString?.()?.slice(0, 19)
  )
);
await conn.end();

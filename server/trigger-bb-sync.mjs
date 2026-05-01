/**
 * Trigger Boonphone sync manually
 * Usage: node server/trigger-bb-sync.mjs
 */
import { createConnection } from "mysql2/promise";
import { readFileSync } from "fs";
import { execSync } from "child_process";

// Load env
let envStr = "";
try { envStr = readFileSync("/home/ubuntu/report-system/.env", "utf-8"); } catch {}
envStr.split("\n").forEach((line) => {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
});

// Clear stale in_progress lock for Boonphone
const conn = await createConnection(process.env.DATABASE_URL);
const [stale] = await conn.execute(
  "SELECT id FROM sync_logs WHERE section = 'Boonphone' AND status = 'in_progress'"
);
if (stale.length > 0) {
  console.log(`Clearing ${stale.length} stale in_progress locks for Boonphone...`);
  await conn.execute(
    "UPDATE sync_logs SET status = 'error', error_message = 'Manually cleared stale lock' WHERE section = 'Boonphone' AND status = 'in_progress'"
  );
}
await conn.end();
console.log("Stale locks cleared. Starting Boonphone sync...");

// Trigger sync in background
import { spawn } from "child_process";
const child = spawn(
  "npx", ["tsx", "server/sync/run-manual-sync.ts", "Boonphone"],
  {
    cwd: "/home/ubuntu/report-system",
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  }
);

child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));

child.on("exit", (code) => {
  console.log(`Boonphone sync exited with code ${code}`);
  process.exit(0);
});

console.log(`Boonphone sync started (PID: ${child.pid})`);

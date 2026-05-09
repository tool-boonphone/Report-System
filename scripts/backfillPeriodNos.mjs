/**
 * backfillPeriodNos.mjs
 *
 * One-time backfill script: คำนวณ period_no/sub_no สำหรับ payment_transactions ทั้งหมด
 * Run: node scripts/backfillPeriodNos.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Load environment variables from .env
import { config } from "dotenv";
config({ path: path.join(projectRoot, ".env") });

// Use tsx to run TypeScript directly
import { execSync } from "child_process";

const tsScript = path.join(projectRoot, "scripts", "backfillPeriodNos.ts");

console.log("Running backfill via tsx...");
execSync(`npx tsx ${tsScript}`, {
  stdio: "inherit",
  cwd: projectRoot,
  env: process.env,
});

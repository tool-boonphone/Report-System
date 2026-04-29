/**
 * One-shot script: re-run computeAndStoreBadDebt for all sections
 * to populate bad_debt_updated_by / bad_debt_updated_at in contracts table.
 *
 * Usage: node run-bad-debt-sync.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Use tsx to handle TypeScript
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Load dotenv
try {
  const dotenv = require("dotenv");
  dotenv.config();
} catch {}

// Use ts-node/esm or tsx
import { execSync } from "node:child_process";

const result = execSync(
  "npx tsx server/sync/run-bad-debt.ts",
  { cwd: "/home/ubuntu/report-system", stdio: "inherit", encoding: "utf8" }
);

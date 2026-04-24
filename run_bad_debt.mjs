/**
 * One-off script to compute and store bad-debt summaries for all contracts.
 * Run: node run_bad_debt.mjs
 */
import { computeAndStoreBadDebt } from "./server/sync/runner.ts";

console.log("Starting computeAndStoreBadDebt for Fastfone365...");
await computeAndStoreBadDebt("Fastfone365");
console.log("Starting computeAndStoreBadDebt for Boonphone...");
await computeAndStoreBadDebt("Boonphone");
console.log("Done!");
process.exit(0);

/**
 * One-shot script: re-run computeAndStoreBadDebt for all sections
 * to populate bad_debt_updated_by / bad_debt_updated_at in contracts table.
 *
 * Usage: npx tsx server/sync/run-bad-debt.ts
 */
import { computeAndStoreBadDebt } from "./runner";

async function main() {
  console.log("[run-bad-debt] Starting computeAndStoreBadDebt for Fastfone365...");
  await computeAndStoreBadDebt("Fastfone365");
  console.log("[run-bad-debt] Fastfone365 done.");

  console.log("[run-bad-debt] Starting computeAndStoreBadDebt for Boonphone...");
  await computeAndStoreBadDebt("Boonphone");
  console.log("[run-bad-debt] Boonphone done.");

  console.log("[run-bad-debt] All sections complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[run-bad-debt] Error:", err);
  process.exit(1);
});

/**
 * scripts/rebuild-income-summary.ts
 * Populate income_monthly_summary table for both sections.
 * Run: npx tsx scripts/rebuild-income-summary.ts
 */
import { rebuildIncomeMonthlySummary } from "../server/accountingDb";

async function main() {
  console.log("Rebuilding income_monthly_summary for Boonphone...");
  const bp = await rebuildIncomeMonthlySummary("Boonphone");
  console.log(`Boonphone: ${bp} rows`);

  console.log("Rebuilding income_monthly_summary for Fastfone365...");
  const ff = await rebuildIncomeMonthlySummary("Fastfone365");
  console.log(`Fastfone365: ${ff} rows`);

  console.log("Done!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

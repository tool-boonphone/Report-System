/**
 * One-off script: trigger Boonphone sync directly
 * Run: pnpm tsx trigger-bp-sync.ts
 */
import { runSectionSync } from "./server/sync/runner";

console.log("[trigger] Starting Boonphone sync...");
runSectionSync("Boonphone", "manual")
  .then((result) => {
    console.log("[trigger] Sync completed:", JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("[trigger] Sync failed:", err?.message ?? err);
    process.exit(1);
  });

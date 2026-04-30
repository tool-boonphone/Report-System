import { populateDebtCache } from "../server/sync/populateCache";

async function main() {
  console.log("[debug] Starting Fastfone365 populate...");
  const start = Date.now();
  try {
    const result = await populateDebtCache("Fastfone365");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[debug] Done in ${elapsed}s — target=${result.targetRows}, collected=${result.collectedRows}`);
  } catch (err: any) {
    console.error("[debug] FAILED:", err?.message ?? err);
    console.error(err?.stack);
  }
  process.exit(0);
}
main();

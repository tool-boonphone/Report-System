import { populateDebtCache } from "../server/sync/populateCache";

async function main() {
  console.log("[debug] Starting Fastfone365 populate...");
  const start = Date.now();
  try {
    const result = await populateDebtCache("Fastfone365");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[debug] Done in ${elapsed}s — target=${result.targetRows}, collected=${result.collectedRows}`);
  } catch (err: any) {
    // Print full error details
    console.error("[debug] FAILED:", err?.message ?? err);
    if (err?.code) console.error("[debug] code:", err.code);
    if (err?.errno) console.error("[debug] errno:", err.errno);
    if (err?.sqlState) console.error("[debug] sqlState:", err.sqlState);
    if (err?.sqlMessage) console.error("[debug] sqlMessage:", err.sqlMessage);
    // Don't print stack (too verbose)
  }
  process.exit(0);
}
main();

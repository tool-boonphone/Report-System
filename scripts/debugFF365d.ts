import { populateDebtCache } from "../server/sync/populateCache";

async function main() {
  console.log("[debug] Starting Fastfone365 populate...");
  const start = Date.now();
  try {
    const result = await populateDebtCache("Fastfone365");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[debug] Done in ${elapsed}s — target=${result.targetRows}, collected=${result.collectedRows}`);
  } catch (err: any) {
    // Print all error properties
    console.error("[debug] FAILED:", err?.message ?? err);
    // Check cause
    if (err?.cause) {
      const cause = err.cause;
      console.error("[debug] cause.message:", cause?.message);
      console.error("[debug] cause.code:", cause?.code);
      console.error("[debug] cause.errno:", cause?.errno);
      console.error("[debug] cause.sqlState:", cause?.sqlState);
      console.error("[debug] cause.sqlMessage:", cause?.sqlMessage);
      console.error("[debug] cause.sql:", cause?.sql?.substring(0, 200));
    }
    // Check query
    if (err?.query) console.error("[debug] query:", err.query?.substring(0, 200));
    // Check all keys
    console.error("[debug] err keys:", Object.keys(err ?? {}));
  }
  process.exit(0);
}
main();

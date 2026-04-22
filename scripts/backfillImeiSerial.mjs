/**
 * One-off backfill for IMEI / Serial No columns on the Contracts table.
 *
 * Usage:
 *   node --experimental-specifier-resolution=node \
 *        --loader tsx scripts/backfillImeiSerial.mjs
 *
 * or (preferred):
 *   npx tsx scripts/backfillImeiSerial.mjs
 *
 * Pulls `contract?action=detail&id=X` for every contract whose `imei` is still
 * NULL/empty and patches imei + serial_no. Safe to re-run: rows already filled
 * are skipped by the WHERE clause.
 */
import { runSectionSync } from "../server/sync/runner.ts";

const section = process.argv[2] || "Boonphone";
console.log(`[backfill] starting full sync for ${section} (includes imei/serial backfill step)…`);
const t0 = Date.now();
const result = await runSectionSync(section, "manual");
console.log(
  `[backfill] done in ${Math.round((Date.now() - t0) / 1000)}s →`,
  result,
);
process.exit(result.ok ? 0 : 1);

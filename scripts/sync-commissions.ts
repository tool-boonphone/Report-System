/**
 * sync-commissions.ts
 * ดึงข้อมูล commissions จาก API ทั้ง Boonphone และ Fastfone365 แล้ว upsert ลง DB
 *
 * รันด้วย:
 *   cd /home/ubuntu/Report-System
 *   npx dotenv -e .env.local -- node_modules/.bin/tsx scripts/sync-commissions.ts
 */

import { PartnerClient, PartnerApiError } from "../server/api/partnerClient";
import { mapCommission } from "../server/api/mappers";
import { upsertCommissions } from "../server/sync/dbUpsert";
import type { SectionKey } from "../shared/const";

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function logSection(title: string) {
  log(`\n${"─".repeat(60)}`);
  log(`  ${title}`);
  log(`${"─".repeat(60)}`);
}

async function syncCommissionsForSection(
  section: SectionKey,
  baseUrl: string,
  username: string,
  password: string,
): Promise<number> {
  logSection(`Commissions: ${section}`);
  log(`  API URL: ${baseUrl}`);
  log(`  Username: ${username}`);

  const client = new PartnerClient({
    section,
    baseUrl,
    username,
    password,
    timeoutMs: 60_000,
  });

  // Login
  log("  Logging in...");
  await client.login();
  log("  Login OK ✓");

  const buffer: any[] = [];
  let rowCount = 0;

  try {
    await client.forEachPage<any>(
      "commission",
      (d) => d?.commissions,
      { action: "all" },
      async (items, page, totalPages) => {
        for (const it of items) {
          buffer.push(mapCommission(section, it));
        }
        if (buffer.length >= 500) {
          rowCount += await upsertCommissions(buffer.splice(0, buffer.length), section);
        }
        log(`  page ${page}/${totalPages} — ${items.length} items (upserted so far: ${rowCount})`);
      },
      200,
      60_000,
    );
  } catch (err: any) {
    if (err instanceof PartnerApiError && err.status === 404) {
      log(`  WARN: commissions endpoint not available (404)`);
    } else {
      throw err;
    }
  }

  // flush remaining
  if (buffer.length > 0) {
    rowCount += await upsertCommissions(buffer, section);
  }

  log(`  ✓ Commissions done: ${rowCount} rows upserted for ${section}`);
  return rowCount;
}

async function main() {
  const startTime = Date.now();
  log("=== Sync Commissions Script ===");

  // ─── Boonphone ─────────────────────────────────────────────────────────────
  const bpApiUrl = process.env.BOONPHONE_API_URL;
  const bpUsername = process.env.BOONPHONE_USERNAME;
  const bpPassword = process.env.BOONPHONE_PASSWORD;
  const bpDbUrl = process.env.BOONPHONE_DATABASE_URL;

  if (!bpApiUrl || !bpUsername || !bpPassword || !bpDbUrl) {
    log("ERROR: Missing Boonphone env vars (BOONPHONE_API_URL, BOONPHONE_USERNAME, BOONPHONE_PASSWORD, BOONPHONE_DATABASE_URL)");
    process.exit(1);
  }

  // ─── Fastfone365 ───────────────────────────────────────────────────────────
  const ffApiUrl = process.env.FASTFONE_API_URL;
  const ffUsername = process.env.FASTFONE_USERNAME;
  const ffPassword = process.env.FASTFONE_PASSWORD;
  const ffDbUrl = process.env.FASTFONE_DATABASE_URL;

  if (!ffApiUrl || !ffUsername || !ffPassword || !ffDbUrl) {
    log("ERROR: Missing Fastfone365 env vars (FASTFONE_API_URL, FASTFONE_USERNAME, FASTFONE_PASSWORD, FASTFONE_DATABASE_URL)");
    process.exit(1);
  }

  log(`BOONPHONE_DATABASE_URL: ${bpDbUrl.replace(/:([^:@]+)@/, ":***@")}`);
  log(`FASTFONE_DATABASE_URL:  ${ffDbUrl.replace(/:([^:@]+)@/, ":***@")}`);

  let bpCount = 0;
  let ffCount = 0;

  // Sync Boonphone
  try {
    bpCount = await syncCommissionsForSection("Boonphone", bpApiUrl, bpUsername, bpPassword);
  } catch (err: any) {
    log(`ERROR: Boonphone commissions failed: ${err?.message ?? err}`);
    console.error(err);
  }

  // Sync Fastfone365
  try {
    ffCount = await syncCommissionsForSection("Fastfone365", ffApiUrl, ffUsername, ffPassword);
  } catch (err: any) {
    log(`ERROR: Fastfone365 commissions failed: ${err?.message ?? err}`);
    console.error(err);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logSection(`DONE`);
  log(`  Boonphone:   ${bpCount} rows`);
  log(`  Fastfone365: ${ffCount} rows`);
  log(`  Total time:  ${elapsed}s`);

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});

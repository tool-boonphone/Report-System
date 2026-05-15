/**
 * scripts/sync-boonphone.ts
 *
 * Standalone sync script สำหรับ Boonphone — รันได้โดยไม่ต้องผ่าน UI
 *
 * วิธีรัน:
 *   DATABASE_URL="..." BOONPHONE_API_URL="..." BOONPHONE_USERNAME="..." BOONPHONE_PASSWORD="..." \
 *   npx tsx scripts/sync-boonphone.ts
 *
 * ขั้นตอน:
 *   1. partners    → in-memory map
 *   2. customers   → upsert cached_customers
 *   3. contracts   → upsert contracts
 *   4. installments → upsert installments
 *   5. payments    → upsert payment_transactions + fillPeriodNos
 *   6. commissions → upsert commissions (รายจ่าย)
 *   7. bad_debt    → compute & store
 *   8. populate    → debt_target_cache + debt_collected_cache
 *   9. build exports → pre-build Excel
 */

// ─── Load .env if present ────────────────────────────────────────────────────
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });

import { PartnerClient, PartnerApiError } from "../server/api/partnerClient";
import {
  mapContractListItem,
  mapCustomerProfile,
  mapInstallment,
  mapPayment,
  mapCommission,
  type CustomerListItem,
  type PartnerListItem,
} from "../server/api/mappers";
import {
  upsertContracts,
  upsertInstallments,
  upsertPayments,
  upsertCachedCustomers,
  upsertCommissions,
  loadCachedCustomersBySection,
} from "../server/sync/dbUpsert";
import { fillPeriodNosForSection } from "../server/sync/fillPeriodNos";
import { populateDebtCache } from "../server/sync/populateCache";
import { buildAllDebtExports } from "../server/debtExportBuilder";
import { invalidateDebtCache } from "../server/debtCache";
import { computeAndStoreBadDebt } from "../server/sync/runner";
import type { SectionKey } from "../shared/const";

const SECTION: SectionKey = "Boonphone";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function logSection(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─── Build client ─────────────────────────────────────────────────────────────

function buildClient(): PartnerClient {
  const baseUrl = process.env.BOONPHONE_API_URL;
  const username = process.env.BOONPHONE_USERNAME;
  const password = process.env.BOONPHONE_PASSWORD;
  if (!baseUrl || !username || !password) {
    throw new Error(
      "Missing env: BOONPHONE_API_URL, BOONPHONE_USERNAME, BOONPHONE_PASSWORD"
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing env: DATABASE_URL");
  }
  return new PartnerClient({ section: SECTION, baseUrl, username, password, timeoutMs: 30_000 });
}

// ─── Stage 1: Partners ────────────────────────────────────────────────────────

async function syncPartners(client: PartnerClient): Promise<Map<string, PartnerListItem>> {
  logSection("Stage 1: Partners");
  const byId = new Map<string, PartnerListItem>();

  await client.forEachPage<PartnerListItem>(
    "partner",
    (d) => d?.partners,
    { action: "all" },
    (items, page, totalPages) => {
      for (const p of items) byId.set(String(p.partner_id), p);
      log(`  page ${page}/${totalPages} — ${items.length} items`);
    },
    200,
  );

  log(`Partners done: ${byId.size} total`);
  return byId;
}

// ─── Stage 2: Customers ───────────────────────────────────────────────────────

async function syncCustomers(
  client: PartnerClient
): Promise<Map<string, CustomerListItem>> {
  logSection("Stage 2: Customers");
  const byId = new Map<string, CustomerListItem>();
  let totalUpserted = 0;

  await client.forEachPage<CustomerListItem>(
    "customer",
    (d) => d?.customers,
    { action: "all" },
    async (items, page, totalPages) => {
      const dbRows = items.map((it) => ({
        section: SECTION,
        customerId: String(it.customer_id),
        customerCode: it.customer_code ?? null,
        fullName: it.full_name ?? null,
        nationality: it.nationality ?? null,
        idDocumentNo: it.id_document_no ?? null,
        gender: it.gender ?? null,
        ageYears: it.age_years != null ? Number(it.age_years) : null,
        occupationTitle: it.occupation_title ?? null,
        monthlyIncome: it.monthly_income != null ? String(it.monthly_income) : null,
        workplaceName: it.workplace_name ?? null,
        mobilePhone: it.mobile_phone ?? null,
        idcardDistrict: it.idcard_district ?? null,
        idcardProvince: it.idcard_province ?? null,
        currentDistrict: it.current_district ?? null,
        currentProvince: it.current_province ?? null,
        workDistrict: it.work_district ?? null,
        workProvince: it.work_province ?? null,
      }));
      await upsertCachedCustomers(dbRows);
      totalUpserted += dbRows.length;
      for (const it of items) byId.set(String(it.customer_id), it);
      log(`  page ${page}/${totalPages} — ${items.length} items (total upserted: ${totalUpserted})`);
    },
    500,
    30_000,
  );

  log(`Customers done: ${byId.size} fetched, ${totalUpserted} upserted`);
  return byId;
}

// ─── Stage 3: Contracts ───────────────────────────────────────────────────────

async function syncContracts(
  client: PartnerClient,
  partnersById: Map<string, PartnerListItem>,
  customersById: Map<string, CustomerListItem>
): Promise<number> {
  logSection("Stage 3: Contracts");
  const buffer: any[] = [];
  let rowCount = 0;

  await client.forEachPage<any>(
    "contract",
    (d) => d?.contracts,
    { action: "all" },
    async (items, page, totalPages) => {
      for (const it of items) {
        const row = mapContractListItem(SECTION, it);
        // Enrich partner fields
        const partner = partnersById.get(String(it.partner_id));
        if (partner) {
          const combined = partner.partner_code && partner.partner_name
            ? `${partner.partner_code} : ${partner.partner_name}`
            : partner.partner_code ?? null;
          (row as any).partnerCode = combined && combined.length > 255 ? combined.slice(0, 255) : combined;
          (row as any).partnerName = partner.partner_name ?? null;
          (row as any).partnerProvince = partner.partner_province ?? null;
          (row as any).partnerStatus = partner.partner_status === "active" ? "ใช้งาน" : partner.partner_status ?? null;
        }
        // Enrich customer fields
        const customer = customersById.get(String(it.customer_id));
        if (customer) Object.assign(row, mapCustomerProfile(customer));
        buffer.push(row);
      }
      if (buffer.length >= 500) rowCount += await upsertContracts(buffer.splice(0, buffer.length));
      log(`  page ${page}/${totalPages} — ${items.length} items (upserted: ${rowCount})`);
    },
    200,
    undefined,
    1,
  );

  if (buffer.length) rowCount += await upsertContracts(buffer);
  log(`Contracts done: ${rowCount} upserted`);
  return rowCount;
}

// ─── Stage 4: Installments ────────────────────────────────────────────────────

async function syncInstallments(client: PartnerClient): Promise<number> {
  logSection("Stage 4: Installments");
  const buffer: any[] = [];
  let rowCount = 0;

  try {
    await client.forEachPage<any>(
      "contract",
      (d) => d?.installments,
      { action: "installments" },
      async (items, page, totalPages) => {
        for (const it of items) buffer.push(mapInstallment(SECTION, it));
        if (buffer.length >= 1000) rowCount += await upsertInstallments(buffer.splice(0, buffer.length));
        log(`  page ${page}/${totalPages} — ${items.length} items`);
      },
      500,
    );
  } catch (err: any) {
    if (err instanceof PartnerApiError && err.status === 404) {
      log(`WARN: installments endpoint not available (404)`);
    } else {
      throw err;
    }
  }

  if (buffer.length) rowCount += await upsertInstallments(buffer);
  log(`Installments done: ${rowCount} upserted`);
  return rowCount;
}

// ─── Stage 5: Payments ────────────────────────────────────────────────────────

async function syncPayments(client: PartnerClient): Promise<number> {
  logSection("Stage 5: Payments");
  const buffer: any[] = [];
  let rowCount = 0;

  await client.forEachPage<any>(
    "payment",
    (d) => d?.transactions,
    { action: "transactions" },
    async (items, page, totalPages) => {
      for (const it of items) buffer.push(mapPayment(SECTION, it));
      if (buffer.length >= 1000) rowCount += await upsertPayments(buffer.splice(0, buffer.length));
      log(`  page ${page}/${totalPages} — ${items.length} items (upserted: ${rowCount})`);
    },
    1000,
    30_000,
  );

  if (buffer.length) rowCount += await upsertPayments(buffer);
  log(`Payments done: ${rowCount} upserted`);
  return rowCount;
}

// ─── Stage 6: Commissions ────────────────────────────────────────────────────

async function syncCommissions(client: PartnerClient): Promise<number> {
  logSection("Stage 6: Commissions (รายจ่าย)");
  const buffer: any[] = [];
  let rowCount = 0;

  try {
    await client.forEachPage<any>(
      "commission",
      (d) => d?.commissions,
      { action: "all" },
      async (items, page, totalPages) => {
        for (const it of items) buffer.push(mapCommission(SECTION, it));
        if (buffer.length >= 500) rowCount += await upsertCommissions(buffer.splice(0, buffer.length));
        log(`  page ${page}/${totalPages} — ${items.length} items (upserted: ${rowCount})`);
      },
      200,
      30_000,
    );
  } catch (err: any) {
    if (err instanceof PartnerApiError && err.status === 404) {
      log(`WARN: commissions endpoint not available (404)`);
    } else {
      throw err;
    }
  }

  if (buffer.length) rowCount += await upsertCommissions(buffer);
  log(`Commissions done: ${rowCount} upserted`);
  return rowCount;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  log(`=== Boonphone Sync Script ===`);
  log(`DATABASE_URL: ${process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ":***@")}`);
  log(`API URL: ${process.env.BOONPHONE_API_URL}`);

  const client = buildClient();

  // Login test
  log("\nTesting API login...");
  await client.login();
  log("Login OK ✓");

  // Stage 1: Partners
  const partnersById = await syncPartners(client);

  // Stage 2: Customers
  let customersById: Map<string, CustomerListItem>;
  try {
    customersById = await syncCustomers(client);
  } catch (err: any) {
    log(`WARN: customers failed (${err?.message}) — loading from DB cache`);
    const dbMap = await loadCachedCustomersBySection(SECTION);
    // Convert AnyRow map to CustomerListItem map
    customersById = new Map<string, CustomerListItem>();
    for (const [id, row] of Array.from(dbMap.entries())) {
      customersById.set(id, {
        customer_id: row.customerId,
        customer_code: row.customerCode ?? undefined,
        full_name: row.fullName ?? undefined,
        nationality: row.nationality ?? undefined,
        id_document_no: row.idDocumentNo ?? undefined,
        gender: row.gender ?? undefined,
        age_years: row.ageYears ?? undefined,
        occupation_title: row.occupationTitle ?? undefined,
        monthly_income: row.monthlyIncome ?? undefined,
        workplace_name: row.workplaceName ?? undefined,
        mobile_phone: row.mobilePhone ?? undefined,
        idcard_district: row.idcardDistrict ?? undefined,
        idcard_province: row.idcardProvince ?? undefined,
        current_district: row.currentDistrict ?? undefined,
        current_province: row.currentProvince ?? undefined,
        work_district: row.workDistrict ?? undefined,
        work_province: row.workProvince ?? undefined,
      } as CustomerListItem);
    }
    log(`Loaded ${customersById.size} customers from DB cache`);
  }

  // Stage 3: Contracts
  await syncContracts(client, partnersById, customersById);

  // Stage 4: Installments (best-effort)
  try {
    await syncInstallments(client);
  } catch (err: any) {
    log(`WARN: installments failed (non-fatal): ${err?.message}`);
  }

  // Stage 5: Payments (best-effort)
  let payFailed = false;
  try {
    await syncPayments(client);
  } catch (err: any) {
    payFailed = true;
    log(`WARN: payments failed (non-fatal): ${err?.message}`);
  }

  // Fill period_no / sub_no
  if (!payFailed) {
    logSection("Stage 5b: Fill period_no / sub_no");
    try {
      const filled = await fillPeriodNosForSection(SECTION);
      log(`Filled period_no/sub_no for ${filled} rows`);
    } catch (err: any) {
      log(`WARN: fillPeriodNos failed (non-fatal): ${err?.message}`);
    }
  }

  // Stage 6: Commissions (best-effort)
  try {
    await syncCommissions(client);
  } catch (err: any) {
    log(`WARN: commissions failed (non-fatal): ${err?.message}`);
  }

  // Stage 7: Bad-debt computation
  logSection("Stage 7: Bad-debt computation");
  try {
    await computeAndStoreBadDebt(SECTION);
    log("Bad-debt computed ✓");
  } catch (err: any) {
    log(`WARN: bad-debt failed (non-fatal): ${err?.message}`);
  }

  // Stage 7: Populate debt cache
  logSection("Stage 7: Populate debt cache");
  try {
    invalidateDebtCache(SECTION);
    const cacheResult = await populateDebtCache(SECTION);
    log(`Debt cache populated: ${JSON.stringify(cacheResult)}`);
  } catch (err: any) {
    const cause = err?.cause ?? err;
    log(`WARN: populateDebtCache failed (non-fatal): ${err?.message}`);
    log(`  cause: ${cause?.message ?? cause}`);
  }

  // Stage 8: Build Excel exports
  logSection("Stage 8: Build Excel exports");
  try {
    await buildAllDebtExports(SECTION);
    log("Excel exports built ✓");
  } catch (err: any) {
    const cause2 = err?.cause ?? err;
    log(`WARN: buildAllDebtExports failed (non-fatal): ${err?.message}`);
    log(`  cause: ${cause2?.message ?? cause2}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logSection(`DONE — Total time: ${elapsed}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});

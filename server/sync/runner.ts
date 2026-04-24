/**
 * Sync runner — pulls one section (Boonphone or Fastfone365) from the partner
 * API into our DB. Follows the `external-api-db-sync-patterns` skill:
 *  - per-section `_isSyncing` lock to avoid concurrent runs
 *  - overall timeout via Promise.race
 *  - batched pagination with retry
 *  - per-entity sync log rows for auditability.
 */

import { buildClientFromEnv, PartnerClient, PartnerApiError } from "../api/partnerClient";
import {
  mapContractListItem,
  mapContractDetailOverrides,
  mapCustomerProfile,
  mapInstallment,
  mapPayment,
  type CustomerListItem,
  type PartnerListItem,
} from "../api/mappers";
import {
  upsertContracts,
  upsertInstallments,
  upsertPayments,
} from "./dbUpsert";
import {
  insertSyncLog,
  finishSyncLog,
} from "./syncLog";
import type { SectionKey, SyncTrigger } from "../../shared/const";

const OVERALL_TIMEOUT_MS = 90 * 60 * 1000; // 90 minutes ceiling per section (Fastfone365 has 17k contracts)
// A sync row older than this with status=in_progress is treated as abandoned.
const STALE_INPROGRESS_MS = OVERALL_TIMEOUT_MS + 5 * 60 * 1000;

/** Stages in order — used to compute progress %. */
export const SYNC_STAGES = [
  "partners",
  "customers",
  "contracts",
  "installments",
  "payments",
] as const;
export type SyncStage = (typeof SYNC_STAGES)[number];

export interface SyncLockInfo {
  startedAt: number;
  triggeredBy: SyncTrigger;
  /** 0-100 */
  progress: number;
  /** Human-readable current stage name */
  currentStage: string;
  /** Index of current stage (0-based) */
  stageIndex: number;
  /** Total number of stages */
  totalStages: number;
}

type LockMap = Record<string, SyncLockInfo | null>;
const _locks: LockMap = { Boonphone: null, Fastfone365: null };

export function getSyncStatus(section: SectionKey): SyncLockInfo | null {
  return _locks[section];
}

/** Update progress for a running sync. */
function setStage(section: SectionKey, stageIndex: number) {
  const lock = _locks[section];
  if (!lock) return;
  const totalStages = SYNC_STAGES.length;
  // progress: stage 0 starts at 5%, each stage adds (90/totalStages)%
  // stage 0=partners: 5%, 1=customers: 23%, 2=contracts: 41%, 3=installments: 59%, 4=payments: 77%
  // After all stages done: 100%
  const progress = Math.round(5 + (stageIndex / totalStages) * 90);
  _locks[section] = {
    ...lock,
    progress,
    stageIndex,
    currentStage: SYNC_STAGES[stageIndex] ?? "finishing",
    totalStages,
  };
}

export function isSyncRunning(section: SectionKey): boolean {
  return _locks[section] !== null;
}

/**
 * Cross-process DB lock check: looks for another sync run with entity='all' for
 * the same section that is still in_progress and was started recently. Because
 * `sync_logs` lives in shared MySQL, every process (dev server scheduler,
 * manual trigger, one-off script) sees the same state.
 */
async function isSectionLockedInDb(section: SectionKey): Promise<boolean> {
  try {
    const { getDb } = await import("../db");
    const { syncLogs } = await import("../../drizzle/schema");
    const { and, eq, gt } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return false;
    const threshold = new Date(Date.now() - STALE_INPROGRESS_MS);
    const rows = await db
      .select({ id: syncLogs.id })
      .from(syncLogs)
      .where(
        and(
          eq(syncLogs.section, section),
          eq(syncLogs.entity, "all"),
          eq(syncLogs.status, "in_progress"),
          gt(syncLogs.startedAt, threshold),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    // If the lock check itself fails, don't block the sync — fail open.
    return false;
  }
}

/** Run one full sync for a section. Returns a summary. */
export async function runSectionSync(
  section: SectionKey,
  triggeredBy: SyncTrigger,
): Promise<{ ok: boolean; rowCount: number; message?: string }> {
  if (_locks[section]) {
    return {
      ok: false,
      rowCount: 0,
      message: `[${section}] sync already in progress`,
    };
  }
  if (await isSectionLockedInDb(section)) {
    return {
      ok: false,
      rowCount: 0,
      message: `[${section}] sync already in progress (another process)`,
    };
  }
  const client = buildClientFromEnv(section);
  if (!client || !client.isConfigured()) {
    return {
      ok: false,
      rowCount: 0,
      message: `[${section}] API credentials are not configured`,
    };
  }
  _locks[section] = {
    startedAt: Date.now(),
    triggeredBy,
    progress: 0,
    currentStage: "เริ่มต้น",
    stageIndex: -1,
    totalStages: SYNC_STAGES.length,
  };
  try {
    const work = doSync(client, section, triggeredBy);
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`[${section}] sync exceeded ${OVERALL_TIMEOUT_MS}ms`)),
        OVERALL_TIMEOUT_MS,
      ),
    );
    return await Promise.race([work, timeout]);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[sync] ${section} failed:`, msg);
    return { ok: false, rowCount: 0, message: msg };
  } finally {
    _locks[section] = null;
  }
}

async function doSync(
  client: PartnerClient,
  section: SectionKey,
  triggeredBy: SyncTrigger,
): Promise<{ ok: boolean; rowCount: number }> {
  const overall = await insertSyncLog({ section, entity: "all", triggeredBy });

  let overallRows = 0;
  try {
    // 1) Partners — for province + status columns. Lightweight, sync in full.
    setStage(section, 0);
    const partnersById = await syncPartners(client, section);

    // 2) Customers — for "age". Cache map to enrich contract rows.
    setStage(section, 1);
    const customersById = await syncCustomers(client, section);

    // 3) Contracts — list + detail enrichment.
    setStage(section, 2);
    const contractRows = await syncContracts(
      client,
      section,
      partnersById,
      customersById,
    );
    overallRows += contractRows;

    // 4) Installments
    setStage(section, 3);
    const instRows = await syncInstallments(client, section);
    overallRows += instRows;

    // 5) Payment Transactions
    setStage(section, 4);
    const payRows = await syncPayments(client, section);
    overallRows += payRows;

    await finishSyncLog({
      id: overall.id,
      status: "success",
      rowCount: overallRows,
    });
    return { ok: true, rowCount: overallRows };
  } catch (err: any) {
    await finishSyncLog({
      id: overall.id,
      status: "error",
      rowCount: overallRows,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

/* ------------------------------------------------------------------------- */
/* Per-entity sync steps                                                      */
/* ------------------------------------------------------------------------- */

async function syncPartners(
  client: PartnerClient,
  section: SectionKey,
): Promise<Map<string, PartnerListItem>> {
  const log = await insertSyncLog({
    section,
    entity: "partners",
    triggeredBy: "on-demand",
  });
  try {
    const byId = new Map<string, PartnerListItem>();
    await client.forEachPage<PartnerListItem>(
      "partner",
      (d) => d?.partners,
      { action: "all" },
      async (items) => {
        for (const it of items) {
          byId.set(String(it.partner_id), it);
        }
      },
      200,
    );
    await finishSyncLog({ id: log.id, status: "success", rowCount: byId.size });
    return byId;
  } catch (err: any) {
    await finishSyncLog({
      id: log.id,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

async function syncCustomers(
  client: PartnerClient,
  section: SectionKey,
): Promise<Map<string, CustomerListItem>> {
  const log = await insertSyncLog({
    section,
    entity: "customers",
    triggeredBy: "on-demand",
  });
  try {
    const byId = new Map<string, CustomerListItem>();
    await client.forEachPage<CustomerListItem>(
      "customer",
      (d) => d?.customers,
      { action: "all" },
      async (items) => {
        for (const it of items) {
          byId.set(String(it.customer_id), it);
        }
      },
      200,
    );
    await finishSyncLog({ id: log.id, status: "success", rowCount: byId.size });
    return byId;
  } catch (err: any) {
    await finishSyncLog({
      id: log.id,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

async function syncContracts(
  client: PartnerClient,
  section: SectionKey,
  partnersById: Map<string, PartnerListItem>,
  customersById: Map<string, CustomerListItem>,
): Promise<number> {
  const log = await insertSyncLog({
    section,
    entity: "contracts",
    triggeredBy: "on-demand",
  });
  let rowCount = 0;
  try {
    const buffer: any[] = [];
    await client.forEachPage<any>(
      "contract",
      (d) => d?.contracts,
      { action: "all" },
      async (items) => {
        for (const it of items) {
          const row: any = mapContractListItem(section, it);
          // Enrich with partner fields we already have.
          const partner = partnersById.get(String(it.partner_id));
          if (partner) {
            {
              const combined = partner.partner_code && partner.partner_name
                ? `${partner.partner_code} : ${partner.partner_name}`
                : partner.partner_code ?? null;
              // Truncate to column limit (varchar 255)
              row.partnerCode = combined && combined.length > 255 ? combined.slice(0, 255) : combined;
            }
            row.partnerName = partner.partner_name ?? null;
            row.partnerProvince = partner.partner_province ?? null;
            row.partnerStatus =
              partner.partner_status === "active" ? "ใช้งาน" : partner.partner_status ?? null;
          }
          // Enrich with customer profile (name, national id, age, address, ...)
          // The contract list endpoint only exposes customer_id, so we merge
          // the full profile from the already-fetched customer map.
          const customer = customersById.get(String(it.customer_id));
          if (customer) {
            Object.assign(row, mapCustomerProfile(customer));
          }
          buffer.push(row);
        }
        if (buffer.length >= 500) {
          rowCount += await upsertContracts(buffer.splice(0, buffer.length));
        }
      },
      200,
    );
    // Flush remainder
    if (buffer.length) {
      rowCount += await upsertContracts(buffer);
    }

    // --- IMEI / Serial backfill ---------------------------------------------
    // The list endpoint does not return IMEI/serial; those only appear in the
    // detail endpoint under `contract.product`. We therefore collect the set
    // of contract IDs we just upserted and call `contract?action=detail&id=X`
    // with bounded concurrency to merge the two extra columns.
    // NOTE: Skip for Fastfone365 — syncInstallmentsFromDetail() already calls
    // the same detail endpoint for every contract, so IMEI will be picked up
    // there instead. Running both would double the API calls (~17k requests).
    if (section !== "Fastfone365") {
      try {
        const enriched = await enrichContractsWithDeviceIds(
          client,
          section,
        );
        rowCount += enriched;
      } catch (err: any) {
        // Backfill failure must NOT abort the whole contracts sync; we already
        // have the list-level columns. Log and continue.
        console.warn(
          `[sync] ${section} imei/serial backfill skipped:`,
          err?.message ?? err,
        );
      }
    }

    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({
      id: log.id,
      status: "error",
      rowCount,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

async function syncInstallments(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const log = await insertSyncLog({
    section,
    entity: "installments",
    triggeredBy: "on-demand",
  });
  let rowCount = 0;
  try {
    // Fastfone365 has no standalone installment endpoint.
    // Installments are embedded inside the contract detail response.
    if (section === "Fastfone365") {
      rowCount = await syncInstallmentsFromDetail(client, section);
    } else {
      // Boonphone: use the dedicated installment bulk endpoint.
      const buffer: any[] = [];
      try {
        await client.forEachPage<any>(
          "contract",
          (d) => d?.installments,
          { action: "installments" },
          async (items) => {
            for (const it of items) buffer.push(mapInstallment(section, it));
            if (buffer.length >= 1000) {
              rowCount += await upsertInstallments(
                buffer.splice(0, buffer.length),
              );
            }
          },
          500,
        );
      } catch (err) {
        // Endpoint may not exist on every deployment; degrade gracefully.
        if (err instanceof PartnerApiError && err.status === 404) {
          console.warn(`[sync] ${section} installments endpoint not available`);
        } else {
          throw err;
        }
      }
      if (buffer.length) rowCount += await upsertInstallments(buffer);
    }
    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({
      id: log.id,
      status: "error",
      rowCount,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

async function syncPayments(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const log = await insertSyncLog({
    section,
    entity: "payments",
    triggeredBy: "on-demand",
  });
  let rowCount = 0;
  try {
    // Fastfone365 has no standalone payment endpoint.
    // Payment data is derived from paid installments already stored in DB.
    if (section === "Fastfone365") {
      rowCount = await syncPaymentsFromInstallments(section);
    } else {
      // Boonphone: use the dedicated payment bulk endpoint.
      const buffer: any[] = [];
      await client.forEachPage<any>(
        "payment",
        (d) => d?.transactions,
        { action: "transactions" },
        async (items) => {
          for (const it of items) buffer.push(mapPayment(section, it));
          if (buffer.length >= 1000) {
            rowCount += await upsertPayments(buffer.splice(0, buffer.length));
          }
        },
        500,
      );
      if (buffer.length) rowCount += await upsertPayments(buffer);
    }
    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({
      id: log.id,
      status: "error",
      rowCount,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

/**
 * Fetch `contract?action=detail&id=X` for every Boonphone/Fastfone365 contract
 * that still has a null/empty `imei` in our DB and upsert just the imei +
 * serial columns. Uses a small worker pool to respect partner rate limits.
 *
 * Kept deliberately simple: we only request detail for rows missing the
 * device identifiers, so a second full-sync after this one is a no-op and
 * all subsequent syncs only touch newly added contracts.
 */
async function enrichContractsWithDeviceIds(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const { getDb } = await import("../db");
  const { contracts } = await import("../../drizzle/schema");
  const { and, eq, or, isNull, sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return 0;

  const targets = await db
    .select({ externalId: contracts.externalId })
    .from(contracts)
    .where(
      and(
        eq(contracts.section, section),
        or(isNull(contracts.imei), eq(contracts.imei, "")),
      ),
    );
  if (targets.length === 0) return 0;

  const CONCURRENCY = 5;
  const FLUSH_EVERY = 200;
  const updates: Array<{ section: SectionKey; externalId: string; imei: string | null; serialNo: string | null }> = [];
  let flushed = 0;

  async function flush() {
    if (updates.length === 0) return;
    // Use raw SQL UPDATE ... WHERE: we only want to patch 2 columns, not
    // re-run the full 40-column upsert path.
    const batch = updates.splice(0, updates.length);
    for (const row of batch) {
      await db!
        .update(contracts)
        .set({
          imei: row.imei,
          serialNo: row.serialNo,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(contracts.section, row.section),
            eq(contracts.externalId, row.externalId),
          ),
        );
    }
    flushed += batch.length;
  }

  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const my = idx++;
      const extId = targets[my].externalId;
      try {
        const data: any = await client.get("contract", {
          action: "detail",
          id: extId,
        });
        const product = data?.contract?.product ?? {};
        const imei = product.imei ? String(product.imei) : null;
        const serial = product.serial_no ? String(product.serial_no) : null;
        // Skip if the API has no data either — avoids a pointless UPDATE.
        if (imei || serial) {
          updates.push({ section, externalId: extId, imei, serialNo: serial });
        }
        if (updates.length >= FLUSH_EVERY) await flush();
      } catch {
        // swallow per-row errors; continue with next
      }
    }
  }
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker()),
  );
  await flush();
  return flushed;
}

/**
 * Fastfone365-specific: fetch installments from contract detail endpoint.
 * Loops through all contracts in DB and fetches detail for each, extracting
 * the embedded installments array. Uses bounded concurrency (5 workers).
 */
async function syncInstallmentsFromDetail(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const { getDb } = await import("../db");
  const { contracts: contractsTable } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return 0;

  // Get all contract IDs for this section
  const targets = await db
    .select({ externalId: contractsTable.externalId, contractNo: contractsTable.contractNo })
    .from(contractsTable)
    .where(eq(contractsTable.section, section));

  if (targets.length === 0) return 0;

  const CONCURRENCY = 5;
  const FLUSH_EVERY = 500;
  const buffer: any[] = [];
  let flushed = 0;
  let idx = 0;

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    flushed += await upsertInstallments(batch);
  }

  async function worker() {
    while (idx < targets.length) {
      const my = idx++;
      const { externalId, contractNo } = targets[my];
      try {
        const data: any = await client.get("contract", {
          action: "detail",
          id: externalId,
        });
        const rawInstallments: any[] = data?.contract?.installments ?? [];
        for (const inst of rawInstallments) {
          // Map Fastfone365 installment shape: { no, due_date, amount, paid, balance, mulct, discount, status }
          const period = inst.no ?? inst.period;
          const externalInstId = `${externalId}-${period}`;
          buffer.push({
            section,
            externalId: externalInstId,
            contractExternalId: String(externalId),
            contractNo: contractNo ?? null,
            period: period ? parseInt(String(period), 10) : null,
            dueDate: inst.due_date ? inst.due_date.slice(0, 10) : null,
            amount: inst.amount != null ? Number(inst.amount).toFixed(2) : null,
            paidAmount: inst.paid != null ? Number(inst.paid).toFixed(2) : "0",
            status: inst.status ?? null,
            rawJson: inst,
          });
        }
        if (buffer.length >= FLUSH_EVERY) await flush();
      } catch {
        // swallow per-contract errors; continue with next
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await flush();
  return flushed;
}

/**
 * Fastfone365-specific: derive payment records from paid installments.
 * Since Fastfone365 has no standalone payment endpoint, we create synthetic
 * payment_transactions rows from installments where paid_amount > 0.
 * Each paid installment becomes one payment record.
 */
async function syncPaymentsFromInstallments(
  section: SectionKey,
): Promise<number> {
  const { getDb } = await import("../db");
  const { installments: instTable } = await import("../../drizzle/schema");
  const { and, eq, gt, sql: drizzleSql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return 0;

  // Fetch all paid installments for this section
  const paidInsts = await db
    .select()
    .from(instTable)
    .where(
      and(
        eq(instTable.section, section),
        gt(instTable.paidAmount, drizzleSql`0`),
      ),
    );

  if (paidInsts.length === 0) return 0;

  const buffer: any[] = [];
  for (const inst of paidInsts) {
    // Use installment externalId as payment externalId (1:1 mapping)
    const rawJson = inst.rawJson as any;
    const paidAt = rawJson?.updated_at
      ? String(rawJson.updated_at).slice(0, 10)
      : inst.dueDate ?? null;

    buffer.push({
      section,
      externalId: `pay-${inst.externalId}`,
      contractExternalId: inst.contractExternalId ?? null,
      contractNo: inst.contractNo ?? null,
      customerName: null,
      paidAt,
      amount: inst.paidAmount,
      method: null,
      status: inst.status ?? null,
      rawJson: { source: "installment", installmentExternalId: inst.externalId },
    });
  }

  return await upsertPayments(buffer);
}

// Re-export mapper for tests
export { mapContractDetailOverrides };

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

const OVERALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes ceiling per section
// A sync row older than this with status=in_progress is treated as abandoned.
const STALE_INPROGRESS_MS = OVERALL_TIMEOUT_MS + 5 * 60 * 1000;

type LockMap = Record<string, { startedAt: number; triggeredBy: SyncTrigger } | null>;
const _locks: LockMap = { Boonphone: null, Fastfone365: null };

export function getSyncStatus(section: SectionKey) {
  return _locks[section];
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
  _locks[section] = { startedAt: Date.now(), triggeredBy };
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
    const partnersById = await syncPartners(client, section);

    // 2) Customers — for "age". Cache map to enrich contract rows.
    const customersById = await syncCustomers(client, section);

    // 3) Contracts — list + detail enrichment.
    const contractRows = await syncContracts(
      client,
      section,
      partnersById,
      customersById,
    );
    overallRows += contractRows;

    // 4) Installments
    const instRows = await syncInstallments(client, section);
    overallRows += instRows;

    // 5) Payment Transactions
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
  _customersById: Map<string, CustomerListItem>,
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
            row.partnerCode =
              partner.partner_code && partner.partner_name
                ? `${partner.partner_code} : ${partner.partner_name}`
                : partner.partner_code ?? null;
            row.partnerName = partner.partner_name ?? null;
            row.partnerProvince = partner.partner_province ?? null;
            row.partnerStatus =
              partner.partner_status === "active" ? "ใช้งาน" : partner.partner_status ?? null;
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

// Re-export mapper for tests
export { mapContractDetailOverrides };

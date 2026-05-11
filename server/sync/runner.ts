/**
 * Sync runner — pulls one section (Boonphone or Fastfone365) from the partner
 * API into our DB. Follows the `external-api-db-sync-patterns` skill:
 *  - per-section `_isSyncing` lock to avoid concurrent runs
 *  - overall timeout via Promise.race
 *  - batched pagination with retry
 *  - per-entity sync log rows for auditability.
 */

import { buildClientFromEnv, PartnerClient, PartnerApiError } from "../api/partnerClient";
import { deriveBadDebtDate } from "../debtDb";
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
  updateSyncLogStage,
} from "./syncLog";
import type { SectionKey, SyncTrigger } from "../../shared/const";
import { invalidateDebtCache } from "../debtCache";
import { buildAllDebtExports } from "../debtExportBuilder";
import { fillPeriodNosForSection } from "./fillPeriodNos";
import { populateDebtCache } from "./populateCache";

const OVERALL_TIMEOUT_MS = 180 * 60 * 1000; // 180 minutes ceiling per section (Fastfone365 has 17k contracts + enrichment)
// A sync row older than this with status=in_progress is treated as abandoned.
const STALE_INPROGRESS_MS = OVERALL_TIMEOUT_MS + 5 * 60 * 1000;

/** Stages in order — used to compute progress %. */
export const SYNC_STAGES = [
  "partners",
  "customers",
  "contracts",
  "installments",
  "payments",
  "bad_debt",
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
// Track the overall sync log ID per section for DB stage updates
const _overallLogId: Record<string, number> = { Boonphone: 0, Fastfone365: 0 };

export function getSyncStatus(section: SectionKey): SyncLockInfo | null {
  return _locks[section];
}

/** Update progress for a running sync — writes to both in-memory lock and DB. */
function setStage(section: SectionKey, stageIndex: number) {
  const lock = _locks[section];
  if (!lock) return;
  const totalStages = SYNC_STAGES.length;
  // progress: stage 0 starts at 5%, each stage adds (90/totalStages)%
  // stage 0=partners: 5%, 1=customers: 23%, 2=contracts: 41%, 3=installments: 59%, 4=payments: 77%
  // After all stages done: 100%
  const progress = Math.round(5 + (stageIndex / totalStages) * 90);
  const currentStage = SYNC_STAGES[stageIndex] ?? "finishing";
  _locks[section] = {
    ...lock,
    progress,
    stageIndex,
    currentStage,
    totalStages,
  };
  // Write to DB so other Cloud Run instances can read the same status
  const logId = _overallLogId[section];
  if (logId) {
    updateSyncLogStage({ id: logId, currentStage, progress }).catch(() => {});
  }
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
  // Store log ID so setStage() can write progress to DB (cross-instance visibility)
  _overallLogId[section] = overall.id;

  // Global self-ping: Cloud Run kills idle instances after ~60s of no HTTP traffic.
  // Keep a single interval alive for the ENTIRE sync (all stages) so Cloud Run
  // never sees the process as idle — regardless of which stage is running.
  const selfPingBaseUrl = process.env.SELF_PING_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const globalSelfPing = setInterval(() => {
    fetch(`${selfPingBaseUrl}/api/ping`).catch(() => {});
  }, 8_000);

  let overallRows = 0;
  try {
    // 1) Partners — for province + status columns. Lightweight, sync in full.
    setStage(section, 0);
    const partnersById = await syncPartners(client, section);

    // 2) Customers — for "age". Cache map to enrich contract rows.
    // Best-effort: Fastfone365 customers endpoint can be slow/hang on some pages.
    // If it fails, we proceed with an empty map so contracts still sync.
    setStage(section, 1);
    let customersById = new Map<string, CustomerListItem>();
    try {
      customersById = await syncCustomers(client, section);
    } catch (custErr: any) {
      console.warn(`[runner] ${section}: customers sync failed (non-fatal), proceeding with empty map:`, custErr?.message ?? custErr);
    }

    // 3) Contracts — list + detail enrichment.
    setStage(section, 2);
    const contractRows = await syncContracts(
      client,
      section,
      partnersById,
      customersById,
    );
    overallRows += contractRows;

    // 4) Installments — best-effort: if this fails (e.g. Cloud Run timeout),
    // we still proceed to populate cache from whatever data is already in DB.
    setStage(section, 3);
    let instFailed = false;
    try {
      const instRows = await syncInstallments(client, section);
      overallRows += instRows;
    } catch (instErr: any) {
      instFailed = true;
      console.warn(`[runner] ${section}: installments sync failed (non-fatal for cache):`, instErr?.message ?? instErr);
    }

    // 5) Payment Transactions — best-effort similarly
    setStage(section, 4);
    let payFailed = false;
    try {
      const payRows = await syncPayments(client, section);
      overallRows += payRows;
    } catch (payErr: any) {
      payFailed = true;
      console.warn(`[runner] ${section}: payments sync failed (non-fatal for cache):`, payErr?.message ?? payErr);
    }

    // 5b) Fill period_no / sub_no for all payment_transactions of this section.
    // Best-effort: if this fails, log and continue (cache will still use old assignPayPeriods).
    if (!payFailed) {
      try {
        const fillCount = await fillPeriodNosForSection(section);
        console.log(`[runner] ${section}: filled period_no/sub_no for ${fillCount} payment rows`);
      } catch (fillErr: any) {
        console.warn(`[runner] ${section}: fillPeriodNos failed (non-fatal):`, fillErr?.message ?? fillErr);
      }
    }

    // 6) Compute & store bad-debt summary per contract
    setStage(section, 5);
    await computeAndStoreBadDebt(section);

    const syncStatus = (instFailed || payFailed) ? "partial" : "success";
    await finishSyncLog({
      id: overall.id,
      status: syncStatus === "partial" ? "error" : "success",
      rowCount: overallRows,
      errorMessage: syncStatus === "partial"
        ? `Partial sync: installments=${instFailed ? 'failed' : 'ok'}, payments=${payFailed ? 'failed' : 'ok'}`
        : undefined,
    });
    // Invalidate debt report cache so next request gets fresh data after sync
    invalidateDebtCache(section);

    // Populate DB cache tables (debt_target_cache + debt_collected_cache)
    // Always runs — even if installments/payments failed — so cache stays fresh
    // from whatever data is already in DB (previous successful sync).
    try {
      const cacheResult = await populateDebtCache(section);
      console.log(
        `[runner] ${section}: cache populated — target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`,
      );
    } catch (cacheErr: any) {
      // Cache population failure is non-fatal — log and continue
      console.error(`[runner] ${section}: cache population failed:`, cacheErr?.message ?? cacheErr);
    }

    // Pre-build Excel exports (target + collected) and upload to S3.
    // Non-fatal: errors are logged but don't block the sync result.
    try {
      await buildAllDebtExports(section);
    } catch (exportErr: any) {
      console.error(`[runner] ${section}: pre-build export failed:`, exportErr?.message ?? exportErr);
    }

    // Post-sync cleanup: ลบ payment_transactions ที่ created_at = วันที่ sync รัน
    // เพื่อให้ข้อมูลในระบบมีเฉพาะถึงเมื่อวาน (วันที่ sync รันถือว่ายังไม่ครบวัน)
    try {
      await cleanupTodayPayments(section);
    } catch (cleanupErr: any) {
      console.warn(`[runner] ${section}: post-sync cleanup failed (non-fatal):`, cleanupErr?.message ?? cleanupErr);
    }

    clearInterval(globalSelfPing);
    return { ok: true, rowCount: overallRows };
  } catch (err: any) {
    clearInterval(globalSelfPing);
    // Even on hard failure, try to populate cache from existing DB data
    try {
      console.log(`[runner] ${section}: attempting cache populate after sync failure...`);
      const cacheResult = await populateDebtCache(section);
      console.log(`[runner] ${section}: post-failure cache populated — target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);
    } catch (cacheErr: any) {
      console.error(`[runner] ${section}: post-failure cache populate failed:`, cacheErr?.message ?? cacheErr);
    }
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
    // Use limit=500 with 60s timeout per request.
    // Tested: limit=500 responds in ~5.5s/page (Boonphone & Fastfone365), well within 60s.
    // Previously limit=200 (~3s/page) but limit=500 reduces pages by 60% (Boonphone 24→10, FF365 112→45).
    //
    // Sub-progress: customers stage spans 20%→40% of overall progress.
    // We update DB every page so the UI shows live progress instead of freezing at 20%.
    const STAGE_START = 20; // % when customers stage begins
    const STAGE_END = 40;   // % when customers stage ends (contracts stage starts)
    const logId = _overallLogId[section];

    // Note: self-ping is now handled globally in doSync() to cover ALL stages.
    await client.forEachPage<CustomerListItem>(
      "customer",
      (d) => d?.customers,
      { action: "all" },
      async (items, page, totalPages) => {
        for (const it of items) {
          byId.set(String(it.customer_id), it);
        }
        // Update sub-progress in DB every page so UI doesn't freeze
        if (logId && totalPages > 0) {
          const subPct = Math.min(page / totalPages, 1);
          const progress = Math.round(STAGE_START + subPct * (STAGE_END - STAGE_START));
          const currentStage = `customers (${page}/${totalPages})`;
          // Update in-memory lock too
          const lock = _locks[section];
          if (lock) {
            _locks[section] = { ...lock, progress, currentStage };
          }
          updateSyncLogStage({ id: logId, currentStage, progress }).catch(() => {});
        }
      },
    500,
    30_000, // 30s per-request timeout — fail fast if API hangs (was 60s but caused Cloud Run kills)
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
    // Both Boonphone and Fastfone365 use the same detail endpoint.
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
    // Both Boonphone and Fastfone365 use the same bulk installments endpoint.
    // GET /api/v1/contract?action=installments
    // Response fields are identical: installment_status_code, principal_due, interest_due, etc.
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
    // NOTE: installments updated_by enrichment ถูก disable แล้ว
    // API ใหม่ stamp created_by/updated_by ไว้ที่ payment_transactions โดยตรง
    // ทั้ง Boonphone และ FF365 ใช้ API เดียวกัน ดังนั้น updated_by ใน report
    // จะดึงจาก payment_transactions.updated_by แทน (แม่นยำกว่า ไม่ต้องเดาจากวันที่)
    // enrichInstallmentsWithUpdatedBy(client, section) — ไม่เรียกอีกต่อไป
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
    // Both Boonphone and Fastfone365 use the same payment transactions endpoint.
    // GET /api/v1/payment?action=transactions
    // Response fields are identical: principal_paid, interest_paid, fee_paid, etc.
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

/**
 * Fetch `contract?action=detail&id=X` for every contract whose installments
 * still have null updated_by in our DB and patch just those two columns.
 *
 * Both Boonphone and FF365 bulk installments endpoint omits updated_by/updated_at.
 * The detail endpoint returns installments[].updated_by and .updated_at for
 * paid periods. We only fetch detail for contracts that have at least one
 * installment with null updated_by to avoid redundant API calls on re-sync.
 */
async function enrichInstallmentsWithUpdatedBy(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const { getDb } = await import("../db");
  const { installments } = await import("../../drizzle/schema");
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return 0;

  // Find distinct contract IDs that have at least one installment with null updated_by
  const rows = await db
    .selectDistinct({ contractExternalId: installments.contractExternalId })
    .from(installments)
    .where(
      and(
        eq(installments.section, section),
        isNull(installments.updatedBy),
      ),
    );
  if (rows.length === 0) return 0;

  const contractIds = rows.map((r) => r.contractExternalId);
  const CONCURRENCY = 5;
  const FLUSH_EVERY = 200;
  type EnrichRow = { contractExternalId: string; period: number; updatedBy: string | null; updatedAt: string | null };
  // Map: contractExternalId → Array<{ period, updatedBy, updatedAt }>
  const updates: Array<EnrichRow> = [];
  let flushed = 0;

  // Open a single persistent connection for all flush operations
  const mysqlLib = await import("mysql2/promise");
  const enrichConn = await mysqlLib.default.createConnection(process.env.DATABASE_URL!);

  async function flush() {
    if (updates.length === 0) return;
    const batch = updates.splice(0, updates.length).filter((r: EnrichRow) => r.updatedBy || r.updatedAt);
    if (batch.length === 0) return;
    // Group by contractExternalId for batch UPDATE efficiency
    const grouped = new Map<string, EnrichRow[]>();
    for (const r of batch) {
      if (!grouped.has(r.contractExternalId)) grouped.set(r.contractExternalId, []);
      grouped.get(r.contractExternalId)!.push(r);
    }
    for (const contractExtId of Array.from(grouped.keys())) {
      const batchRows = grouped.get(contractExtId)!;
      if (batchRows.length === 0) continue;
      // Build CASE WHEN for updatedBy and updatedAt
      const periodList = batchRows.map((r: EnrichRow) => r.period).join(",");
      const caseUpdatedBy = batchRows.map((r: EnrichRow) => `WHEN period = ${r.period} THEN ${r.updatedBy ? enrichConn.escape(r.updatedBy) : 'NULL'}`).join(" ");
      const caseUpdatedAt = batchRows.map((r: EnrichRow) => `WHEN period = ${r.period} THEN ${r.updatedAt ? enrichConn.escape(r.updatedAt) : 'NULL'}`).join(" ");
      await enrichConn.execute(
        `UPDATE installments SET 
          updated_by = CASE ${caseUpdatedBy} ELSE updated_by END,
          updated_at = CASE ${caseUpdatedAt} ELSE updated_at END,
          synced_at = CURRENT_TIMESTAMP
        WHERE section = ? AND contract_external_id = ? AND period IN (${periodList})`,
        [section, contractExtId]
      );
    }
    flushed += batch.length;
  }

  let idx = 0;
  async function worker() {
    while (idx < contractIds.length) {
      const my = idx++;
      const contractExtId = contractIds[my];
      try {
        const data: any = await client.get("contract", {
          action: "detail",
          id: contractExtId,
        });
        const detailInsts: any[] = data?.contract?.installments ?? [];
        for (const inst of detailInsts) {
          const period = inst.no ?? inst.installment_no ?? inst.period;
          const updatedBy = inst.updated_by ? String(inst.updated_by) : null;
          const updatedAt = inst.updated_at ? String(inst.updated_at) : null;
          if (period != null && (updatedBy || updatedAt)) {
            updates.push({
              contractExternalId: contractExtId,
              period: Number(period),
              updatedBy,
              updatedAt,
            });
          }
        }
        if (updates.length >= FLUSH_EVERY) await flush();
      } catch {
        // swallow per-row errors; continue with next contract
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => worker()),
    );
    await flush();
  } finally {
    await enrichConn.end();
  }
  console.log(`[sync] ${section} installments updated_by enriched: ${flushed} rows from ${contractIds.length} contracts`);
  return flushed;
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
  const { and, eq, or, isNull } = await import("drizzle-orm");
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

  // Use a single dedicated MySQL connection for all UPDATE queries
  // to avoid exhausting the connection pool during enrichment.
  const mysql = await import("mysql2/promise");
  const enrichConn = await mysql.createConnection(process.env.DATABASE_URL!);

  const CONCURRENCY = 5;
  const FLUSH_EVERY = 200;
  const updates: Array<{ externalId: string; imei: string | null; serialNo: string | null }> = [];
  let flushed = 0;

  async function flush() {
    if (updates.length === 0) return;
    const batch = updates.splice(0, updates.length);
    for (const row of batch) {
      await enrichConn.execute(
        `UPDATE contracts SET imei = ?, serial_no = ?, synced_at = CURRENT_TIMESTAMP
         WHERE section = ? AND external_id = ?`,
        [row.imei, row.serialNo, section, row.externalId],
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
          updates.push({ externalId: extId, imei, serialNo: serial });
        }
        if (updates.length >= FLUSH_EVERY) await flush();
      } catch {
        // swallow per-row errors; continue with next
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => worker()),
    );
    await flush();
  } finally {
    await enrichConn.end();
  }
  return flushed;
}


/**
 * Compute and persist bad-debt summary columns on contracts table.

/**
 * Compute and persist bad-debt summary columns on contracts table.
 *
 * Business rules (confirmed 2026-04-24):
 *   1. contract.status = "หนี้เสีย" → bad-debt confirmed (device sold, applies to both Boonphone & FF365)
 *   2. contract.status = "ระงับสัญญา" → device returned but NOT sold yet → no bad-debt amount
 *
 * Stores:
 *   bad_debt_amount       = SUM of all bad-debt payments (total_paid_amount where isBadDebt)
 *   bad_debt_date         = YYYY-MM-DD of the latest bad-debt payment (deriveBadDebtDate)
 *   suspended_from_period = first installment period with suspend/cancel status code
 */
async function computeAndStoreBadDebt(section: SectionKey): Promise<void> {
  const { getDb } = await import("../db");
  const { contracts, installments, paymentTransactions } = await import("../../drizzle/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return;

  // ---- 1) Fetch bad-debt contracts ----
  // "หนี้เสีย" = confirmed bad-debt (device sold) for both Boonphone and Fastfone365.
  const targetContracts = await db
    .select({
      externalId: contracts.externalId,
      status: contracts.status,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.section, section),
        eq(contracts.status, "หนี้เสีย"),
      ),
    );

  if (targetContracts.length === 0) return;

  // ---- 2) Fetch installments for these contracts ----
  const extIds = targetContracts.map((c) => c.externalId);
  // Process in chunks to avoid huge IN() clauses
  const CHUNK = 500;

  // Suspend codes: same for both Boonphone and Fastfone365.
  // installment_status_code values that indicate a suspended/bad-debt installment.
  const suspendCodes = ["ระงับสัญญา", "หนี้เสีย"];

  // Map: externalId → { suspendedFromPeriod, suspendedAt }
  const suspendMap = new Map<string, { period: number; date: string | null }>();

  for (let i = 0; i < extIds.length; i += CHUNK) {
    const slice = extIds.slice(i, i + CHUNK);
    const inClause = slice.map((id) => sql`${id}`).reduce((acc, cur, idx) => idx === 0 ? cur : sql`${acc}, ${cur}`);
    const instRows = await db.execute(sql`
      SELECT contract_external_id,
             period,
             due_date,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS status_code
        FROM ${installments}
       WHERE section = ${section}
         AND contract_external_id IN (${inClause})
       ORDER BY contract_external_id, period
    `);
    const rows: any[] = (instRows as any)[0] ?? instRows;
    for (const r of rows) {
      const extId = String(r.contract_external_id ?? "");
      if (!extId) continue;
      if (suspendMap.has(extId)) continue; // already found first suspended period
      const code = r.status_code ?? "";
      if (suspendCodes.includes(code)) {
        suspendMap.set(extId, {
          period: Number(r.period ?? 1),
          date: r.due_date ?? null,
        });
      }
    }
    // Fallback: contracts with no matching installment status → period 1
    for (const extId of slice) {
      if (!suspendMap.has(extId)) {
        // find period 1 due_date from rows
        const p1 = rows.find((r) => String(r.contract_external_id) === extId && Number(r.period) === 1);
        suspendMap.set(extId, { period: 1, date: p1?.due_date ?? null });
      }
    }
  }

  // ---- 3) Fetch payments for these contracts ----
  // Map: externalId → Array<{ payment_external_id, paid_at, created_at, total_paid_amount, ff_status, updated_by, updated_at }>
  // payment_external_id: numeric string = real payment from API; "pay-*" prefix = synthetic from installments
  // real payments have total_paid_amount from raw_json; synthetic payments have null
  // updated_by: FF365 ใช้ CTE + MIN(CONCAT) approach เพื่อหา installment ที่ใกล้ payment_date มากที่สุด
  //   Boonphone: updated_by ยังไม่มีใน installments DB (ยังไม่ได้ sync)
  const payMap = new Map<string, Array<{ payment_external_id: string; paid_at: string | null; created_at: string | null; total_paid_amount: number; ff_status: string | null; updated_by: string | null; updated_at: string | null }>>();

  for (let i = 0; i < extIds.length; i += CHUNK) {
    const slice = extIds.slice(i, i + CHUNK);
    // ใช้ updated_by/updated_at จาก column โดยตรง แทน CTE JOIN installments
    // (column ถูกบันทึกตอน sync payments จาก API แล้ว)
    const payRows = await db
      .select({
        contractExternalId: paymentTransactions.contractExternalId,
        externalId: paymentTransactions.externalId,
        paidAt: paymentTransactions.paidAt,
        createdAt: paymentTransactions.createdAt,
        amount: paymentTransactions.amount,
        status: paymentTransactions.status,
        updatedBy: paymentTransactions.updatedBy,
        updatedAt: paymentTransactions.updatedAt,
        rawJson: paymentTransactions.rawJson,
      })
      .from(paymentTransactions)
      .where(
        sql`${paymentTransactions.section} = ${section} AND ${paymentTransactions.contractExternalId} IN (${sql.raw(slice.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(","))})`
      )
      .orderBy(paymentTransactions.contractExternalId, paymentTransactions.paidAt);
    for (const r of payRows) {
      const extId = String(r.contractExternalId ?? "");
      if (!extId) continue;
      if (!payMap.has(extId)) payMap.set(extId, []);
      const raw: any = r.rawJson ?? {};
      payMap.get(extId)!.push({
        payment_external_id: String(r.externalId ?? ""),
        paid_at: r.paidAt ?? null,
        created_at: r.createdAt ? String(r.createdAt) : null,
        total_paid_amount: Number(raw.total_paid_amount ?? r.amount ?? 0),
        ff_status: r.status ?? null,
        updated_by: r.updatedBy ?? null,
        updated_at: r.updatedAt ?? null,
      });
    }
  }

  // ---- 4) Compute bad-debt per contract and UPDATE ----
  const BATCH = 200;
  let batch: Array<{ externalId: string; amount: number; date: string | null; period: number; updatedBy: string | null; updatedAt: string | null }> = [];

  async function flushBatch() {
    if (!batch.length) return;
    for (const row of batch) {
      await db!.execute(sql`
        UPDATE ${contracts}
           SET bad_debt_amount = ${row.amount},
               bad_debt_date   = ${row.date},
               suspended_from_period = ${row.period},
               bad_debt_updated_by = ${row.updatedBy},
               bad_debt_updated_at = ${row.updatedAt}
         WHERE section = ${section}
           AND external_id = ${row.externalId}
      `);
    }
    batch = [];
  }

  for (const c of targetContracts) {
    const extId = c.externalId;
    const suspend = suspendMap.get(extId) ?? { period: 1, date: null };
    const payments = payMap.get(extId) ?? [];

    // Determine bad-debt amount and date from real payments.
    // Phase 106/107 Iron Rules (confirmed 2026-04-29):
    //   Rule 1: ถ้ามียอดชำระแค่ยอดเดียว → ยอดนั้นคือ bad_debt_amount
    //   Rule 2: ยอดสุดท้ายที่ชำระเข้ามา (วันที่ล่าสุด) → คือ bad_debt_amount
    //   Rule 3: ถ้าวันที่ล่าสุดมีหลาย payment → เอายอดรวมทั้งหมดของวันนั้น
    //
    // Example: CT1124-SKA002-3314-01
    //   real payments วันที่ 2025-04-04: 2436, 2436, 2436, 92 (รวม 7,400) ← bad_debt_amount
    //   real payment วันที่ 2024-12-24: 2,986 ← ค่างวดปกติ
    //
    // Example: CT0126-SRI001-21064-01
    //   real 103766: 1,499 (2026-02-10) = ชำระงวดปกติ
    //   real 115702: 8,000 (2026-03-23) = ยอดขายเครื่อง ← bad_debt_amount
    const realBadDebtPayments = payments.filter(
      (p) => !p.payment_external_id.startsWith("pay-") && p.total_paid_amount > 0
    );

    if (realBadDebtPayments.length === 0) continue;

    // Sort by paid_at DESC, created_at DESC เหมือน bad_debt_last_days subquery ใน accountingDb.ts
    // เพื่อให้ logic ตรงกันกับหน้ารายรับ
    const sortedReal = [...realBadDebtPayments].sort((a, b) => {
      const paidCmp = (b.paid_at ?? "").localeCompare(a.paid_at ?? "");
      if (paidCmp !== 0) return paidCmp;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    // latestDate = วันที่ล่าสุด (YYYY-MM-DD)
    const latestDate = sortedReal[0].paid_at
      ? String(sortedReal[0].paid_at).substring(0, 10)
      : null;
    // latestCreatedAt = created_at ของ row ที่ล่าสุด (ใช้ระบุ DATE เท่านั้น ไม่ใช้ timestamp เป๊ะ)
    const latestCreatedAt = sortedReal[0].created_at ?? null;
    // latestCreatedDate = DATE portion ของ created_at ของ row ล่าสุด (YYYY-MM-DD)
    const latestCreatedDate = latestCreatedAt ? String(latestCreatedAt).substring(0, 10) : null;
    // latestUpdatedBy = updated_by ของ row ล่าสุด
    const latestUpdatedBy = sortedReal[0].updated_by ?? null;
    // Rule 3: sum ของทุก real payment ที่อยู่ใน batch เดียวกัน
    // batch เดียวกัน = paid_at วันเดียวกัน + DATE(created_at) วันเดียวกัน + updated_by คนเดียวกัน
    // (admin อาจบันทึกหลาย payments ในช่วงเวลาสั้นๆ ทำให้ created_at ต่างกัน 1-2 นาที)
    const latestDatePayments = latestDate
      ? realBadDebtPayments.filter((p) => {
          if (!p.paid_at) return false;
          const sameDate = String(p.paid_at).substring(0, 10) === latestDate;
          if (!sameDate) return false;
          // DATE(created_at) ต้องตรงกัน
          const pCreatedDate = p.created_at ? String(p.created_at).substring(0, 10) : null;
          if (latestCreatedDate && pCreatedDate && pCreatedDate !== latestCreatedDate) return false;
          // updated_by ต้องตรงกัน (ถ้า latestUpdatedBy มีค่า)
          if (latestUpdatedBy && p.updated_by !== latestUpdatedBy) return false;
          return true;
        })
      : [sortedReal[0]];
    const totalBadDebt = latestDatePayments.reduce((sum, p) => sum + p.total_paid_amount, 0);
    // bad_debt_date = วันที่ล่าสุด (slip date for bank reconciliation)
    const badDebtDate = latestDate ?? suspend.date;

    // updated_by/updated_at = จากรายการชำระสุดท้ายของสัญญา (ใช้ latestDatePayments ซึ่งเป็นรายการของยอดขายเครื่อง)
    // เลือกรายการที่มี updated_by ก่อน ถ้าไม่มีให้ใช้รายการแรก
    const latestWithUpdatedBy = latestDatePayments.find((p) => p.updated_by) ?? latestDatePayments[0];
    const badDebtUpdatedBy = latestWithUpdatedBy?.updated_by ?? null;
    const badDebtUpdatedAt = latestWithUpdatedBy?.updated_at ?? null;

    batch.push({
      externalId: extId,
      amount: totalBadDebt,
      date: badDebtDate,
      period: suspend.period,
      updatedBy: badDebtUpdatedBy,
      updatedAt: badDebtUpdatedAt,
    });

    if (batch.length >= BATCH) await flushBatch();
  }
  await flushBatch();

  console.log(`[computeAndStoreBadDebt] ${section}: updated ${targetContracts.length} bad-debt contracts`);
}

/**
 * Post-sync cleanup: ลบ payment_transactions ที่ DATE(created_at) = วันที่ sync รัน (Asia/Bangkok)
 * เพื่อให้ระบบแสดงข้อมูลถึงแค่เมื่อวาน (วันที่ sync ยังไม่ครบวัน จึงตัดออก)
 * หลังลบแล้วจะ re-populate cache ใหม่เพื่อให้ยอดใน cache ตรงกับข้อมูลที่เหลือ
 */
async function cleanupTodayPayments(section: SectionKey): Promise<void> {
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return;

  // คำนวณวันที่ปัจจุบันใน Asia/Bangkok (YYYY-MM-DD)
  const bangkokFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayBangkok = bangkokFmt.format(new Date()); // e.g. "2026-05-11"

  // ลบ payment_transactions ที่ DATE(created_at) = วันนี้ (Bangkok)
  // created_at เก็บเป็น varchar(32) ใน DB เช่น "2026-05-11 10:30:00"
  const { sql } = await import("drizzle-orm");
  const result = await db.execute(
    sql`DELETE FROM payment_transactions
        WHERE section = ${section}
          AND LEFT(created_at, 10) = ${todayBangkok}`
  );
  const deleted = (result as any)?.[0]?.affectedRows ?? 0;
  console.log(`[runner] ${section}: post-sync cleanup deleted ${deleted} payment_transactions with created_at = ${todayBangkok}`);

  if (deleted > 0) {
    // Re-populate cache หลังลบเพื่อให้ยอดใน cache ตรงกับข้อมูลที่เหลือ
    try {
      const cacheResult = await populateDebtCache(section);
      console.log(`[runner] ${section}: post-cleanup cache re-populated — target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);
    } catch (cacheErr: any) {
      console.warn(`[runner] ${section}: post-cleanup cache re-populate failed:`, cacheErr?.message ?? cacheErr);
    }
  }
}

// Re-export mapper for tests
export { mapContractDetailOverrides, computeAndStoreBadDebt };

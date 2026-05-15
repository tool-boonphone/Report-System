/**
 * Sync runner -- pulls one section (Boonphone or Fastfone365) from the partner
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
  upsertCachedCustomers,
  loadCachedCustomersBySection,
} from "./dbUpsert";
import {
  insertSyncLog,
  finishSyncLog,
  updateSyncLogStage,
  getLastCustomersResumePage,
  getLastContractsResumePage,
} from "./syncLog";
import type { SectionKey, SyncTrigger } from "../../shared/const";
import { invalidateDebtCache } from "../debtCache";
import { buildAllDebtExports } from "../debtExportBuilder";
import { fillPeriodNosForSection } from "./fillPeriodNos";
import { populateDebtCache } from "./populateCache";
import { pgRows } from "../db";

const OVERALL_TIMEOUT_MS = 180 * 60 * 1000; // 180 minutes ceiling per section (Fastfone365 has 17k contracts + enrichment)
// A sync row older than this with status=in_progress is treated as abandoned.
const STALE_INPROGRESS_MS = OVERALL_TIMEOUT_MS + 5 * 60 * 1000;

/** Stages in order -- used to compute progress %. */
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
// Cancellation flags -- set to true to request cancellation of running sync
const _cancelRequested: Record<string, boolean> = { Boonphone: false, Fastfone365: false };

/** Request cancellation of a running sync for a section. */
export function requestCancelSync(section: SectionKey): boolean {
  if (!_locks[section]) return false; // not running
  _cancelRequested[section] = true;
  return true;
}

/** Check if cancellation has been requested for a section. */
export function isCancelRequested(section: SectionKey): boolean {
  return _cancelRequested[section] === true;
}

export function getSyncStatus(section: SectionKey): SyncLockInfo | null {
  return _locks[section];
}

/** Update progress for a running sync -- writes to both in-memory lock and DB. */
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

/**
 * Update sub-progress within a stage — shows "contracts (1500/17809)" in UI.
 * Called every N rows to give real-time feedback without flooding DB.
 * Only updates in-memory lock (no DB write) for performance.
 */
function setSubProgress(
  section: SectionKey,
  stageName: string,
  current: number,
  total: number,
) {
  const lock = _locks[section];
  if (!lock) return;
  // Compute fine-grained progress within the stage band
  const stageIndex = SYNC_STAGES.indexOf(stageName as any);
  const totalStages = SYNC_STAGES.length;
  const stageStart = Math.round(5 + (stageIndex / totalStages) * 90);
  const stageEnd = Math.round(5 + ((stageIndex + 1) / totalStages) * 90);
  const subFraction = total > 0 ? current / total : 0;
  const progress = Math.min(stageEnd - 1, Math.round(stageStart + subFraction * (stageEnd - stageStart)));
  const currentStage = total > 0 ? `${stageName} (${current}/${total})` : stageName;
  _locks[section] = { ...lock, progress, currentStage };
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
    // If the lock check itself fails, don't block the sync -- fail open.
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
  // Reset cancel flag before starting
  _cancelRequested[section] = false;
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
  // never sees the process as idle -- regardless of which stage is running.
  const selfPingBaseUrl = process.env.SELF_PING_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  // ข้อ 3: Ping ทั้ง localhost AND public URL (VITE_OAUTH_PORTAL_URL domain) ทุก 5s
  // เพื่อให้ Cloud Run load balancer เห็น traffic จริง ไม่ใช่แค่ internal loop
  const publicPingUrl = (() => {
    const raw = process.env.VITE_OAUTH_PORTAL_URL ?? "";
    if (!raw) return null;
    try {
      const u = new URL(raw);
      // VITE_OAUTH_PORTAL_URL ชี้ไปที่ OAuth portal ไม่ใช่ app เอง
      // ใช้ SELF_PING_URL ถ้ามี (production จะ set ไว้) มิฉะนั้น null
      return process.env.SELF_PING_URL ? `${process.env.SELF_PING_URL}/api/ping` : null;
    } catch { return null; }
  })();
  const globalSelfPing = setInterval(() => {
    fetch(`${selfPingBaseUrl}/api/ping`).catch(() => {});
    if (publicPingUrl) fetch(publicPingUrl).catch(() => {});
  }, 5_000);

  /** Helper: throw if user requested cancellation */
  const checkCancel = () => {
    if (_cancelRequested[section]) {
      throw new Error(`[${section}] sync cancelled by user`);
    }
  };

  let overallRows = 0;
  try {
    // 1) Partners -- for province + status columns. Lightweight, sync in full.
    checkCancel();
    setStage(section, 0);
    const partnersById = await syncPartners(client, section);

    // 2) Customers -- fetch from API and persist to DB.
    // If API fetch fails (e.g. Cloud Run timeout), fall back to previously
    // cached customers in DB so contracts still get enriched with customer data.
    checkCancel();
    setStage(section, 1);
    let customersById = new Map<string, CustomerListItem>();
    try {
      customersById = await syncCustomers(client, section);
    } catch (custErr: any) {
      if (_cancelRequested[section]) throw custErr; // propagate cancel
      console.warn(`[runner] ${section}: customers API sync failed, falling back to DB cache:`, custErr?.message ?? custErr);
      // Load previously-synced customers from DB so contracts still get enriched
      try {
        const dbMap = await loadCachedCustomersBySection(section);
        if (dbMap.size > 0) {
          console.log(`[runner] ${section}: loaded ${dbMap.size} customers from DB cache`);
          // Convert DB rows to CustomerListItem shape
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
        } else {
          console.warn(`[runner] ${section}: no customers in DB cache, contracts will have empty customer fields`);
        }
      } catch (dbErr: any) {
        console.warn(`[runner] ${section}: DB cache load also failed:`, dbErr?.message ?? dbErr);
      }
    }

    // 3) Contracts -- list + detail enrichment.
    // Resume from last killed page if available (Cloud Run kill recovery).
    checkCancel();
    setStage(section, 2);
    const contractsStartPage = await getLastContractsResumePage(section);
    const contractRows = await syncContracts(
      client,
      section,
      partnersById,
      customersById,
      contractsStartPage > 0 ? contractsStartPage : 1,
    );
    overallRows += contractRows;

    // 4) Installments -- best-effort: if this fails (e.g. Cloud Run timeout),
    // we still proceed to populate cache from whatever data is already in DB.
    checkCancel();
    setStage(section, 3);
    let instFailed = false;
    try {
      const instRows = await syncInstallments(client, section);
      overallRows += instRows;
    } catch (instErr: any) {
      if (_cancelRequested[section]) throw instErr; // propagate cancel
      instFailed = true;
      console.warn(`[runner] ${section}: installments sync failed (non-fatal for cache):`, instErr?.message ?? instErr);
    }

    // 5) Payment Transactions -- best-effort similarly
    checkCancel();
    setStage(section, 4);
    let payFailed = false;
    try {
      const payRows = await syncPayments(client, section);
      overallRows += payRows;
    } catch (payErr: any) {
      if (_cancelRequested[section]) throw payErr; // propagate cancel
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
    // Always runs -- even if installments/payments failed -- so cache stays fresh
    // from whatever data is already in DB (previous successful sync).
    try {
      const cacheResult = await populateDebtCache(section);
      console.log(
        `[runner] ${section}: cache populated -- target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`,
      );
    } catch (cacheErr: any) {
      // Cache population failure is non-fatal -- log and continue
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
      console.log(`[runner] ${section}: post-failure cache populated -- target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);
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
  // Strategy: fetch all pages from API, upsert into `cached_customers` DB table.
  // After sync, load from DB and return as map.
  // This way, if Cloud Run kills the process mid-sync, the next run continues
  // from the last saved resume_page instead of page 1.
  // syncContracts reads from DB instead of this in-memory map.
  //
  // Resilience features (per external-api-db-sync-patterns §12 Common Pitfalls):
  //  - skipOnError=true: skip individual pages that timeout instead of failing all
  //  - resumePage: save last fetched page so restart continues from where it left off
  //  - startPage: resume from last saved page on retry

  // Check if there's a previous run to resume from
  const resumeFromPage = await getLastCustomersResumePage(section);
  const startPage = resumeFromPage > 0 ? resumeFromPage : 1;
  if (startPage > 1) {
    console.log(`[runner] ${section}: resuming customers sync from page ${startPage}`);
  }

  const log = await insertSyncLog({
    section,
    entity: "customers",
    triggeredBy: "on-demand",
  });
  try {
    const byId = new Map<string, CustomerListItem>();
    const STAGE_START = 20;
    const STAGE_END = 40;
    const logId = _overallLogId[section];
    let totalUpserted = 0;

    // Heartbeat: write "fetching page 1..." to DB immediately so UI doesn't
    // freeze at 20% while waiting for the first API response.
    if (logId) {
      updateSyncLogStage({
        id: logId,
        currentStage: `customers (fetching page 1...)`,
        progress: STAGE_START,
      }).catch(() => {});
    }

    // Per-stage timeout: if customers stage takes > 15 min, throw so the
    // overall sync can fall back to DB cache instead of hanging indefinitely.
    const CUSTOMERS_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
    const customersWork = client.forEachPageParallel<CustomerListItem>(
      "customer",
      (d) => d?.customers,
      { action: "all" },
      async (items, page, totalPages) => {
        // Build DB rows for this page
        const dbRows = items.map((it) => ({
          section,
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
        // Persist this page to DB immediately -- survives Cloud Run kills
        await upsertCachedCustomers(dbRows);
        totalUpserted += dbRows.length;
        // Also keep in-memory map for immediate use by syncContracts
        for (const it of items) {
          byId.set(String(it.customer_id), it);
        }
        // Update sub-progress in DB every page so UI doesn't freeze
        // Also save resumePage so a restart can continue from here
        if (logId && totalPages > 0) {
          const subPct = Math.min(page / totalPages, 1);
          const progress = Math.round(STAGE_START + subPct * (STAGE_END - STAGE_START));
          const currentStage = `customers (${page}/${totalPages})`;
          const lock = _locks[section];
          if (lock) {
            _locks[section] = { ...lock, progress, currentStage };
          }
          // Save resumePage = next page to fetch (so restart skips already-done pages)
          updateSyncLogStage({ id: logId, currentStage, progress, resumePage: page + 1 }).catch(() => {});
        }
      },
      500,      // limit=500 -- 45 pages for FF365 instead of 223
      30_000,   // 30s per-request timeout (skill §13: per-request timeout 30s)
      startPage, // resume from last saved page if previous run was killed
      5,        // batchSize=5 -- fetch 5 pages in parallel
      200,      // delayMs=200 -- 200ms between batches to avoid rate limiting
      true,     // skipOnError=true: skip pages that timeout instead of failing all
      (page, totalPages) => {
        // Update progress from parallel batch
        if (logId && totalPages > 0) {
          const subPct = Math.min(page / totalPages, 1);
          const progress = Math.round(STAGE_START + subPct * (STAGE_END - STAGE_START));
          const currentStage = `customers (${page}/${totalPages})`;
          const lock = _locks[section];
          if (lock) {
            _locks[section] = { ...lock, progress, currentStage };
          }
          updateSyncLogStage({ id: logId, currentStage, progress, resumePage: page + 1 }).catch(() => {});
        }
      },
    );
    const customersTimeout = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`[${section}] customers stage exceeded ${CUSTOMERS_STAGE_TIMEOUT_MS / 60000} min`)),
        CUSTOMERS_STAGE_TIMEOUT_MS,
      ),
    );
    await Promise.race([customersWork, customersTimeout]);
    if (logId) {
      updateSyncLogStage({ id: logId, currentStage: "customers", progress: STAGE_END }).catch(() => {});
    }
    await finishSyncLog({ id: log.id, status: "success", rowCount: totalUpserted });
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
  startPage = 1,
): Promise<number> {
  const log = await insertSyncLog({
    section,
    entity: "contracts",
    triggeredBy: "on-demand",
  });
  if (startPage > 1) {
    console.log(`[sync] ${section}: resuming contracts from page ${startPage}`);
    // Record the resume start page immediately so we can detect it in logs
    updateSyncLogStage({ id: log.id, currentStage: "contracts", progress: 0, resumePage: startPage }).catch(() => {});
  }
  let rowCount = 0;
  try {
    const buffer: any[] = [];
    let totalContractRows = 0; // will be set on first page
    await client.forEachPage<any>(
      "contract",
      (d) => d?.contracts,
      { action: "all" },
      async (items, page, totalPages) => {
        // Estimate total rows from totalPages × pageSize (200)
        if (totalContractRows === 0 && totalPages > 0) {
          totalContractRows = totalPages * 200;
        }
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
        // Update real-time sub-progress in UI
        setSubProgress(section, "contracts", page * 200, totalContractRows);
        // Save resume_page so a Cloud Run kill can be recovered by resuming from next page
        updateSyncLogStage({ id: log.id, currentStage: "contracts", progress: Math.round((page / totalPages) * 100), resumePage: page + 1 }).catch(() => {});
      },
      200,
      undefined, // timeoutMs — use default
      startPage,  // resume from last saved page if previous run was killed
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
    let totalInstRows = 0;
    try {
      await client.forEachPage<any>(
        "contract",
        (d) => d?.installments,
        { action: "installments" },
        async (items, page, totalPages) => {
          if (totalInstRows === 0 && totalPages > 0) totalInstRows = totalPages * 500;
          for (const it of items) buffer.push(mapInstallment(section, it));
          if (buffer.length >= 1000) {
            rowCount += await upsertInstallments(
              buffer.splice(0, buffer.length),
            );
          }
          setSubProgress(section, "installments", page * 500, totalInstRows);
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
    // enrichInstallmentsWithUpdatedBy(client, section) -- ไม่เรียกอีกต่อไป
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
    //
    // Delete detection: collect ALL external_ids returned by API, then delete
    // any payment_transactions rows in DB that are NOT in the API response.
    // This handles cases where admin deletes a payment from the real system.
    const apiExternalIds = new Set<string>();
    const buffer: any[] = [];
    // ข้อ 1: เพิ่ม page size จาก 500 → 1000 (ลดจำนวน HTTP round-trips ลงครึ่งหนึ่ง)
    // ข้อ 2: ใช้ forEachPageParallel (batchSize=5, delayMs=100) แทน forEachPage sequential
    //        ตาม skill external-api-db-sync-patterns §6.1 sweet spot = 5×100ms
    await client.forEachPageParallel<any>(
      "payment",
      (d) => d?.transactions,
      { action: "transactions" },
      async (items, page, totalPages) => {
        for (const it of items) {
          const mapped = mapPayment(section, it);
          buffer.push(mapped);
          apiExternalIds.add(String(it.payment_id));
        }
        if (buffer.length >= 1000) {
          rowCount += await upsertPayments(buffer.splice(0, buffer.length));
        }
        setSubProgress(section, "payments", page * 1000, totalPages * 1000);
      },
      1000,   // ข้อ 1: page size 1000 (เดิม 500)
      undefined, // timeoutMs — ใช้ default (20s per request)
      1,      // startPage
      5,      // batchSize — 5 pages parallel (safe for partner API)
      100,    // delayMs — 100ms between batches (skill §6.1 sweet spot)
      true,   // skipOnError — ข้ามหน้าที่ fail แทนที่จะ throw ทั้งหมด
    );
    if (buffer.length) rowCount += await upsertPayments(buffer);

    // ── Delete detection ────────────────────────────────────────────────────
    // Only run if we got a non-trivial number of rows from API (safety guard
    // against accidental mass-delete when API returns empty due to network error).
    if (apiExternalIds.size > 0) {
      const { getDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (db) {
        // Fetch all external_ids currently in DB for this section
        const dbRows: { external_id: string }[] = (await db.execute(
          sql`SELECT external_id FROM payment_transactions WHERE section = ${section}`
        ) as any).rows ?? [];
        const toDelete = dbRows
          .map((r) => r.external_id)
          .filter((eid) => !apiExternalIds.has(eid));
        if (toDelete.length > 0) {
          console.log(`[runner] ${section}: delete detection — removing ${toDelete.length} payment(s) not in API: [${toDelete.slice(0, 10).join(", ")}${toDelete.length > 10 ? "..." : ""}]`);
          // Delete in batches of 500 to avoid oversized IN clauses
          const BATCH = 500;
          for (let i = 0; i < toDelete.length; i += BATCH) {
            const chunk = toDelete.slice(i, i + BATCH);
            const placeholders = chunk.map(() => "?").join(",");
            await db.execute(
              sql.raw(`DELETE FROM payment_transactions WHERE section = '${section}' AND external_id IN (${chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`)
            );
          }
          console.log(`[runner] ${section}: delete detection — deleted ${toDelete.length} stale payment row(s)`);
        } else {
          console.log(`[runner] ${section}: delete detection — no stale payments found`);
        }
      }
    } else {
      console.warn(`[runner] ${section}: delete detection skipped — API returned 0 payments (possible network issue)`);
    }
    // ────────────────────────────────────────────────────────────────────────

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

  const contractIds = rows.map((r: { contractExternalId: string }) => r.contractExternalId);
  const CONCURRENCY = 5;
  const FLUSH_EVERY = 200;
  type EnrichRow = { contractExternalId: string; period: number; updatedBy: string | null; updatedAt: string | null };
  // Map: contractExternalId -> Array<{ period, updatedBy, updatedAt }>
  const updates: Array<EnrichRow> = [];
  let flushed = 0;

  // Open a single persistent pg client for all flush operations
  const pgLib = await import("pg");
  const enrichConn = new pgLib.default.Client({ connectionString: process.env.DATABASE_URL });
  await enrichConn.connect();

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
      // Build parameterized CASE WHEN for PostgreSQL
      let paramIdx = 1;
      const params: (string | number | null)[] = [];
      const caseUpdatedBy = batchRows.map((r: EnrichRow) => {
        if (r.updatedBy) { params.push(r.updatedBy); return `WHEN period = ${r.period} THEN $${paramIdx++}`; }
        return `WHEN period = ${r.period} THEN NULL`;
      }).join(" ");
      const caseUpdatedAt = batchRows.map((r: EnrichRow) => {
        if (r.updatedAt) { params.push(r.updatedAt); return `WHEN period = ${r.period} THEN $${paramIdx++}`; }
        return `WHEN period = ${r.period} THEN NULL`;
      }).join(" ");
      const periodList = batchRows.map((r: EnrichRow) => r.period).join(",");
      params.push(section, contractExtId);
      await enrichConn.query(
        `UPDATE installments SET
          updated_by = CASE ${caseUpdatedBy} ELSE updated_by END,
          updated_at = CASE ${caseUpdatedAt} ELSE updated_at END,
          synced_at = CURRENT_TIMESTAMP
        WHERE section = $${paramIdx++} AND contract_external_id = $${paramIdx++} AND period IN (${periodList})`,
        params
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
    await enrichConn.end().catch(() => {});
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

  // Use a single dedicated pg Client for all UPDATE queries
  // to avoid exhausting the connection pool during enrichment.
  const pgLib2 = await import("pg");
  const enrichConn = new pgLib2.default.Client({ connectionString: process.env.DATABASE_URL });
  await enrichConn.connect();

  const CONCURRENCY = 5;
  const FLUSH_EVERY = 200;
  const updates: Array<{ externalId: string; imei: string | null; serialNo: string | null }> = [];
  let flushed = 0;

  async function flush() {
    if (updates.length === 0) return;
    const batch = updates.splice(0, updates.length);
    for (const row of batch) {
      await enrichConn.query(
        `UPDATE contracts SET imei = $1, serial_no = $2, synced_at = CURRENT_TIMESTAMP
         WHERE section = $3 AND external_id = $4`,
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
        // Skip if the API has no data either -- avoids a pointless UPDATE.
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
    await enrichConn.end().catch(() => {});
  }
  return flushed;
}


/**
 * Compute and persist bad-debt summary columns on contracts table.

/**
 * Compute and persist bad-debt summary columns on contracts table.
 *
 * Business rules (confirmed 2026-04-24):
 *   1. contract.status = "หนี้เสีย" -> bad-debt confirmed (device sold, applies to both Boonphone & FF365)
 *   2. contract.status = "ระงับสัญญา" -> device returned but NOT sold yet -> no bad-debt amount
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
  const extIds = targetContracts.map((c: { externalId: string }) => c.externalId);
  // Process in chunks to avoid huge IN() clauses
  const CHUNK = 500;

  // Suspend codes: same for both Boonphone and Fastfone365.
  // installment_status_code values that indicate a suspended/bad-debt installment.
  const suspendCodes = ["ระงับสัญญา", "หนี้เสีย"];

  // Map: externalId -> { suspendedFromPeriod, suspendedAt }
  const suspendMap = new Map<string, { period: number; date: string | null }>();

  for (let i = 0; i < extIds.length; i += CHUNK) {
    const slice = extIds.slice(i, i + CHUNK);
    const inClause = slice.map((id: string) => sql`${id}`).reduce((acc: ReturnType<typeof sql>, cur: ReturnType<typeof sql>, idx: number) => idx === 0 ? cur : sql`${acc}, ${cur}`);
    const instRows = await db.execute(sql`
      SELECT contract_external_id,
             period,
             due_date,
             (raw_json::jsonb->>'installment_status_code') AS status_code
        FROM ${installments}
       WHERE section = ${section}
         AND contract_external_id IN (${inClause})
       ORDER BY contract_external_id, period
    `);
    const rows: any[] = pgRows(instRows);
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
    // Fallback: contracts with no matching installment status -> period 1
    for (const extId of slice) {
      if (!suspendMap.has(extId)) {
        // find period 1 due_date from rows
        const p1 = rows.find((r) => String(r.contract_external_id) === extId && Number(r.period) === 1);
        suspendMap.set(extId, { period: 1, date: p1?.due_date ?? null });
      }
    }
  }

  // ---- 3) Fetch payments for these contracts ----
  // Map: externalId -> Array<{ payment_external_id, paid_at, created_at, total_paid_amount, ff_status, updated_by, updated_at }>
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
      .where(        sql`${paymentTransactions.section} = ${section} AND ${paymentTransactions.contractExternalId} IN (${sql.raw(slice.map((id: string) => `'${String(id).replace(/'/g, "''")}' `).join(","))})`
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
    //   Rule 1: ถ้ามียอดชำระแค่ยอดเดียว -> ยอดนั้นคือ bad_debt_amount
    //   Rule 2: ยอดสุดท้ายที่ชำระเข้ามา (วันที่ล่าสุด) -> คือ bad_debt_amount
    //   Rule 3: ถ้าวันที่ล่าสุดมีหลาย payment -> เอายอดรวมทั้งหมดของวันนั้น
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
    // ระดับ 1 (Primary): paid_at วันเดียวกัน + DATE(created_at) วันเดียวกัน + updated_by คนเดียวกัน
    // ระดับ 2 (Fallback): ถ้า primary_sum < 1000 → ขยาย batch ด้วย created_date + updated_by เท่านั้น
    //   (ไม่สนใจ paid_at) — ตรงกับ buildBadDebtLastDaysSubquery ใน accountingDb.ts
    const primaryBatchPayments = latestDate
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
    const primarySum = primaryBatchPayments.reduce((sum, p) => sum + p.total_paid_amount, 0);

    // ระดับ 2 (Fallback): ถ้า primary_sum < 1000 → group ด้วย created_date + updated_by เท่านั้น
    // เหมือนกับ is_fallback = 1 ใน buildBadDebtLastDaysSubquery
    let latestDatePayments: typeof primaryBatchPayments;
    if (primarySum < 1000 && latestCreatedDate) {
      latestDatePayments = realBadDebtPayments.filter((p) => {
        const pCreatedDate = p.created_at ? String(p.created_at).substring(0, 10) : null;
        if (latestCreatedDate && pCreatedDate !== latestCreatedDate) return false;
        if (latestUpdatedBy && p.updated_by !== latestUpdatedBy) return false;
        return true;
      });
    } else {
      latestDatePayments = primaryBatchPayments;
    }

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
      console.log(`[runner] ${section}: post-cleanup cache re-populated -- target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);
    } catch (cacheErr: any) {
      console.warn(`[runner] ${section}: post-cleanup cache re-populate failed:`, cacheErr?.message ?? cacheErr);
    }
  }
}

// Re-export mapper for tests
export { mapContractDetailOverrides, computeAndStoreBadDebt };

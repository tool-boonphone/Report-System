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
} from "./syncLog";
import type { SectionKey, SyncTrigger } from "../../shared/const";
import { invalidateDebtCache } from "../debtCache";

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

    // 6) Compute & store bad-debt summary per contract
    setStage(section, 5);
    await computeAndStoreBadDebt(section);

    await finishSyncLog({
      id: overall.id,
      status: "success",
      rowCount: overallRows,
    });
    // Invalidate debt report cache so next request gets fresh data after sync
    invalidateDebtCache(section);
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
  // Map: externalId → Array<{ payment_external_id, paid_at, total_paid_amount, ff_status }>
  // payment_external_id: numeric string = real payment from API; "pay-*" prefix = synthetic from installments
  // real payments have total_paid_amount from raw_json; synthetic payments have null
  const payMap = new Map<string, Array<{ payment_external_id: string; paid_at: string | null; total_paid_amount: number; ff_status: string | null }>>();

  for (let i = 0; i < extIds.length; i += CHUNK) {
    const slice = extIds.slice(i, i + CHUNK);
    const inClause2 = slice.map((id) => sql`${id}`).reduce((acc, cur, idx) => idx === 0 ? cur : sql`${acc}, ${cur}`);
    const payRows = await db.execute(sql`
      SELECT contract_external_id,
             external_id AS payment_external_id,
             paid_at,
             CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) AS total_paid_amount,
             status AS ff_status
        FROM ${paymentTransactions}
       WHERE section = ${section}
         AND contract_external_id IN (${inClause2})
       ORDER BY contract_external_id, paid_at
    `);
    const rows: any[] = (payRows as any)[0] ?? payRows;
    for (const r of rows) {
      const extId = String(r.contract_external_id ?? "");
      if (!extId) continue;
      if (!payMap.has(extId)) payMap.set(extId, []);
      payMap.get(extId)!.push({
        payment_external_id: String(r.payment_external_id ?? ""),
        paid_at: r.paid_at ?? null,
        total_paid_amount: Number(r.total_paid_amount ?? 0),
        ff_status: r.ff_status ?? null,
      });
    }
  }

  // ---- 4) Compute bad-debt per contract and UPDATE ----
  const BATCH = 200;
  let batch: Array<{ externalId: string; amount: number; date: string | null; period: number }> = [];

  async function flushBatch() {
    if (!batch.length) return;
    for (const row of batch) {
      await db!.execute(sql`
        UPDATE ${contracts}
           SET bad_debt_amount = ${row.amount},
               bad_debt_date   = ${row.date},
               suspended_from_period = ${row.period}
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
    // Both Boonphone and Fastfone365 use the same payment transactions API.
    // Real payments (external_id is numeric) have total_paid_amount from the API.
    // We use the LATEST real payment as bad_debt_amount (device-sale receipt).
    //
    // Why latest, not sum?
    //   - Earlier real payments are normal installment payments
    //   - The last real payment is the device-sale amount (e.g. 8,000 from selling the device)
    //   - bad_debt_amount should represent only the device-sale proceeds
    //
    // Example: CT0126-SRI001-21064-01
    //   real 103766: 1,499 (2026-02-10) = ชำระงวดปกติ
    //   real 115702: 8,000 (2026-03-23) = ยอดขายเครื่อง ← bad_debt_amount
    const realBadDebtPayments = payments.filter(
      (p) => !p.payment_external_id.startsWith("pay-") && p.total_paid_amount > 0
    );

    if (realBadDebtPayments.length === 0) continue;

    // Sort by paid_at DESC to find the latest real payment
    const sortedReal = [...realBadDebtPayments].sort((a, b) =>
      (b.paid_at ?? "").localeCompare(a.paid_at ?? "")
    );
    const latestRealPayment = sortedReal[0];
    const totalBadDebt = latestRealPayment.total_paid_amount;
    // bad_debt_date = paid_at of the latest real payment (slip date for bank reconciliation)
    const badDebtDate = latestRealPayment.paid_at
      ? String(latestRealPayment.paid_at).substring(0, 10)
      : suspend.date;

    batch.push({
      externalId: extId,
      amount: totalBadDebt,
      date: badDebtDate,
      period: suspend.period,
    });

    if (batch.length >= BATCH) await flushBatch();
  }
  await flushBatch();

  console.log(`[computeAndStoreBadDebt] ${section}: updated ${targetContracts.length} bad-debt contracts`);
}

// Re-export mapper for tests
export { mapContractDetailOverrides, computeAndStoreBadDebt };

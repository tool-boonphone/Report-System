import { desc, eq, and, gt, lt, or, ne, sql } from "drizzle-orm";
import { syncLogs } from "../../drizzle/schema";
import { getDb } from "../db";
import { normalizeSectionKey, type SectionKey, type SyncTrigger } from "../../shared/const";

export async function insertSyncLog(params: {
  section: SectionKey;
  entity: string;
  triggeredBy: SyncTrigger;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available for syncLog.insert");
  const now = new Date();
  const [res] = await db.insert(syncLogs).values({
    section: normalizeSectionKey(params.section),
    entity: params.entity,
    triggeredBy: params.triggeredBy,
    status: "in_progress",
    startedAt: now,
  });
  // mysql2/drizzle returns ResultSetHeader; insertId is the autoincrement pk.
  const id = (res as any)?.insertId ?? 0;
  return { id, startedAt: now };
}

export async function finishSyncLog(params: {
  id: number;
  status: "success" | "error";
  rowCount?: number;
  errorMessage?: string;
}) {
  const db = await getDb();
  if (!db || !params.id) return;
  await db
    .update(syncLogs)
    .set({
      status: params.status,
      rowCount: params.rowCount ?? 0,
      errorMessage: params.errorMessage?.slice(0, 2000) ?? null,
      finishedAt: new Date(),
    })
    .where(eq(syncLogs.id, params.id));
}

/**
 * Update current_stage + progress for a running sync log row.
 * Written to DB so ALL Cloud Run instances can read the same status.
 */
export async function updateSyncLogStage(params: {
  id: number;
  currentStage: string;
  progress: number;
  resumePage?: number;
}) {
  const db = await getDb();
  if (!db || !params.id) return;
  await db
    .update(syncLogs)
    .set({
      currentStage: params.currentStage,
      progress: params.progress,
      ...(params.resumePage !== undefined ? { resumePage: params.resumePage } : {}),
    })
    .where(eq(syncLogs.id, params.id));
}

/**
 * Get the last successfully fetched customers page for a section.
 * Used to resume customers sync from where it left off after a Cloud Run kill.
 * Returns 0 if no previous run found (start from page 1).
 *
 * Strategy 1: Check entity='customers' in_progress row with resume_page > 0
 *   (current session is still running — resume from last saved page).
 * Strategy 2: Fall back to entity='all' row killed during 'customers' stage.
 *   (clearAllStuckSyncLogs clears entity='customers' rows but overall log
 *    entity='all' retains the resume_page from the last updateSyncLogStage call)
 */
export async function getLastCustomersResumePage(section: SectionKey): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  // Strategy 1: entity='customers' in_progress row with resume_page > 0
  // (within 30 min — current session is still running)
  const RESUME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  const cutoff = new Date(Date.now() - RESUME_WINDOW_MS);
  const customerRows = await db
    .select({ resumePage: syncLogs.resumePage, status: syncLogs.status, startedAt: syncLogs.startedAt })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.entity, "customers"),
        eq(syncLogs.status, "in_progress"),
        sql`${syncLogs.startedAt} >= ${cutoff}`,
        sql`${syncLogs.resumePage} > 0`,
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  if ((customerRows[0]?.resumePage ?? 0) > 0) {
    const resumePage = customerRows[0]!.resumePage!;
    console.log(`[syncLog] ${section}: resuming customers from page ${resumePage} (entity=customers in_progress row, started ${customerRows[0]!.startedAt?.toISOString()})`);
    return resumePage;
  }

  // Strategy 2: entity='all' row killed during 'customers' stage.
  // clearAllStuckSyncLogs clears entity='customers' rows but the overall
  // entity='all' log retains resume_page from the last updateSyncLogStage call.
  // Use a 2-hour window (customers sync can take ~1h for large datasets).
  const CUSTOMERS_RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
  const customersCutoff = new Date(Date.now() - CUSTOMERS_RESUME_WINDOW_MS);
  const overallRows = await db
    .select({ resumePage: syncLogs.resumePage, startedAt: syncLogs.startedAt, currentStage: syncLogs.currentStage })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.entity, "all"),
        eq(syncLogs.status, "error"),
        sql`${syncLogs.startedAt} >= ${customersCutoff}`,
        sql`${syncLogs.resumePage} > 0`,
        sql`${syncLogs.currentStage} LIKE 'customers%'`,
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  const resumePage = overallRows[0]?.resumePage ?? 0;
  if (resumePage > 0) {
    console.log(`[syncLog] ${section}: resuming customers from page ${resumePage} (entity=all row, stage='${overallRows[0]!.currentStage}', started ${overallRows[0]!.startedAt?.toISOString()})`);
  }
  return resumePage;
}

/**
 * Get the resume_page for a previous contracts sync that was killed mid-way.
 * Returns 0 if no recent error row with resume_page > 0 exists (start from page 1).
 *
 * Uses a 3-hour window because contracts sync (including IMEI enrichment)
 * can take up to 2.5 hours for 17k+ contracts.
 *
 * Strategy 1: Check entity='contracts' row with resume_page > 0.
 * Strategy 2: Fall back to entity='all' row killed during 'contracts' stage.
 *   (clearAllStuckSyncLogs clears entity='contracts' rows but overall log
 *    entity='all' retains the resume_page from the last updateSyncLogStage call)
 */
export async function getLastContractsResumePage(section: SectionKey): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // 3-hour window: contracts sync (list + IMEI enrichment) can take ~2.5h
  const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - RESUME_WINDOW_MS);

  // Strategy 1: entity='contracts' row with resume_page > 0
  const contractRows = await db
    .select({ resumePage: syncLogs.resumePage, startedAt: syncLogs.startedAt })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.entity, "contracts"),
        eq(syncLogs.status, "error"),
        sql`${syncLogs.startedAt} >= ${cutoff}`,
        sql`${syncLogs.resumePage} > 0`,
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  if ((contractRows[0]?.resumePage ?? 0) > 0) {
    const resumePage = contractRows[0]!.resumePage!;
    console.log(`[syncLog] ${section}: resuming contracts from page ${resumePage} (entity=contracts row, started ${contractRows[0]!.startedAt?.toISOString()})`);
    return resumePage;
  }

  // Strategy 2: entity='all' row killed during 'contracts' stage.
  // clearAllStuckSyncLogs clears entity='contracts' rows but the overall
  // entity='all' log retains resume_page from the last updateSyncLogStage call.
  const overallRows = await db
    .select({ resumePage: syncLogs.resumePage, startedAt: syncLogs.startedAt, currentStage: syncLogs.currentStage })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.entity, "all"),
        eq(syncLogs.status, "error"),
        sql`${syncLogs.startedAt} >= ${cutoff}`,
        sql`${syncLogs.resumePage} > 0`,
        sql`${syncLogs.currentStage} LIKE 'contracts%'`,
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  const resumePage = overallRows[0]?.resumePage ?? 0;
  if (resumePage > 0) {
    console.log(`[syncLog] ${section}: resuming contracts from page ${resumePage} (entity=all row, stage='${overallRows[0]!.currentStage}', started ${overallRows[0]!.startedAt?.toISOString()})`);
  }
  return resumePage;
}

/**
 * Get running sync status from DB for a section.
 * Returns null if no sync is in_progress (or if it's stale > 185 minutes).
 * 185 min = OVERALL_TIMEOUT_MS (180 min) + 5 min buffer.
 * Used by sync.status tRPC procedure so ALL instances see the same state.
 *
 * Fix (2026-05-11): ตรวจสอบทั้ง entity='all' และ entity-level rows
 * เพื่อป้องกันกรณีที่ entity='all' log ถูก clear แต่ entity-level logs
 * ยังอยู่ใน in_progress (เช่น หลัง clearAllStuckSyncLogs ทำงานไม่ครบ)
 */
export async function getDbSyncStatus(section: SectionKey): Promise<{
  running: boolean;
  startedAt: Date | null;
  currentStage: string | null;
  progress: number | null;
} | null> {
  const db = await getDb();
  if (!db) return null;
  // Treat in_progress rows older than 185 minutes as abandoned
  // (matches OVERALL_TIMEOUT_MS=180min + 5min buffer in runner.ts)
  const staleThreshold = new Date(Date.now() - 185 * 60 * 1000);

  // 1) ลองหา entity='all' row ก่อน (มี currentStage + progress ที่อัพเดตต่อเนื่อง)
  const allRows = await db
    .select({
      id: syncLogs.id,
      startedAt: syncLogs.startedAt,
      currentStage: syncLogs.currentStage,
      progress: syncLogs.progress,
    })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.entity, "all"),
        eq(syncLogs.status, "in_progress"),
        gt(syncLogs.startedAt, staleThreshold),
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  if (allRows.length > 0) {
    const row = allRows[0];
    return {
      running: true,
      startedAt: row.startedAt,
      currentStage: row.currentStage ?? null,
      progress: row.progress ?? 0,
    };
  }

  // 2) Fallback: ตรวจสอบ entity-level rows (partners/customers/contracts/installments/payments)
  // กรณีที่ entity='all' log ถูก clear ไปแล้ว แต่ entity-level logs ยังอยู่ใน in_progress
  const entityRows = await db
    .select({
      id: syncLogs.id,
      startedAt: syncLogs.startedAt,
      entity: syncLogs.entity,
    })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        ne(syncLogs.entity, "all"),
        eq(syncLogs.status, "in_progress"),
        gt(syncLogs.startedAt, staleThreshold),
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  if (entityRows.length > 0) {
    const row = entityRows[0];
    return {
      running: true,
      startedAt: row.startedAt,
      currentStage: row.entity ?? null, // ใช้ entity name เป็น stage name
      progress: null, // ไม่มีข้อมูล progress ที่ละเอียด
    };
  }

  return { running: false, startedAt: null, currentStage: null, progress: null };
}

/**
 * Force-clear all in_progress sync logs for a section.
 * Used when Cloud Run killed the process mid-sync, leaving orphaned rows.
 * Returns the number of rows updated.
 */
export async function clearStuckSyncLogs(section: SectionKey): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // Clear any in_progress rows for this section (regardless of age)
  const result = await db
    .update(syncLogs)
    .set({
      status: "error",
      finishedAt: new Date(),
      errorMessage: "Force-cleared by admin: Cloud Run instance killed during sync",
    })
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.status, "in_progress"),
      ),
    );
  const affectedRows = (result[0] as any)?.affectedRows ?? 0;
  console.log(`[syncLog] clearStuck(${section}): cleared ${affectedRows} stuck rows`);
  return affectedRows;
}

/**
 * Clear ALL in_progress sync logs across all sections.
 * Called on server startup to clean up orphaned rows left by a previous
 * Cloud Run instance that was killed mid-sync.
 * Returns total number of rows cleared.
 */
export async function clearAllStuckSyncLogs(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // Only clear rows that have been in_progress for more than 15 minutes.
  // 15 min is enough to avoid clearing a sync that just started on the same instance,
  // while still catching syncs killed by Cloud Run restarts (which happen within seconds).
  // Previously 95 min caused stuck locks when server restarted mid-sync.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const result = await db
    .update(syncLogs)
    .set({
      status: "error",
      finishedAt: new Date(),
      errorMessage: "Auto-cleared on startup: previous Cloud Run instance was killed during sync",
    })
    .where(
      and(
        eq(syncLogs.status, "in_progress"),
        lt(syncLogs.startedAt, cutoff),
      ),
    );
  const affectedRows = (result[0] as any)?.affectedRows ?? 0;
  if (affectedRows > 0) {
    console.log(`[syncLog] startup cleanup: cleared ${affectedRows} stuck in_progress row(s) older than 15 min`);
  }
  return affectedRows;
}

/**
 * Most recent successful sync for a given (section, entity).
 *
 * FIX (2026-05-14): When no entity is specified (used by scheduler to check
 * if today's sync has run), only check entity='all' rows — not sub-entity rows
 * (partners, customers, contracts, etc.). Sub-entity success rows from a
 * partially-completed sync should NOT prevent the scheduler from running the
 * full sync again.
 */
export async function getLastSyncedAt(params: {
  section: SectionKey;
  entity?: string;
}): Promise<Date | null> {
  const db = await getDb();
  if (!db) return null;
  // When entity is specified, use it directly (e.g. for UI display).
  // When entity is NOT specified (scheduler check), only look at entity='all'
  // so sub-entity success rows don't falsely indicate a completed full sync.
  const entityFilter = params.entity ?? "all";
  const cond = and(
    eq(syncLogs.section, params.section),
    eq(syncLogs.entity, entityFilter),
    eq(syncLogs.status, "success"),
  );
  const rows = await db
    .select({ finishedAt: syncLogs.finishedAt })
    .from(syncLogs)
    .where(cond)
    .orderBy(desc(syncLogs.finishedAt))
    .limit(1);
  return rows[0]?.finishedAt ?? null;
}

/** Latest in-flight sync for each section. Used to report progress to UI. */
export async function getRunningSyncs() {
  const db = await getDb();
  if (!db) return [] as Array<{
    id: number;
    section: string;
    entity: string;
    startedAt: Date;
    triggeredBy: string;
  }>;
  const rows = await db
    .select({
      id: syncLogs.id,
      section: syncLogs.section,
      entity: syncLogs.entity,
      startedAt: syncLogs.startedAt,
      triggeredBy: syncLogs.triggeredBy,
    })
    .from(syncLogs)
    .where(eq(syncLogs.status, "in_progress"))
    .orderBy(desc(syncLogs.startedAt));
  return rows;
}

/** Recent sync history for a section (for Sync Logs panel in Settings). */
export async function listSyncLogs(section?: SectionKey, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  const cond = section ? eq(syncLogs.section, section) : undefined;
  const q = db
    .select()
    .from(syncLogs)
    .orderBy(desc(syncLogs.startedAt))
    .limit(limit);
  return cond ? await q.where(cond) : await q;
}

/**
 * Returns the most recent attempt's timestamp for a section where the status
 * was "error". Used by the scheduler to cool off sections whose credentials
 * are invalid (prevents noisy login-fail loops on every restart).
 *
 * FIX (2026-05-14): Only check entity='all' rows — not sub-entity rows
 * (customers, contracts, etc.). Sub-entity errors are expected during resume
 * and should NOT block the scheduler from retrying the full sync.
 * Previously, a cleared entity='customers' error row would block Boonphone
 * from running for 30 min even though the overall sync hadn't started yet.
 */
export async function getLastErrorAt(params: {
  section: SectionKey;
}): Promise<Date | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({
      startedAt: syncLogs.startedAt,
      status: syncLogs.status,
    })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, params.section),
        eq(syncLogs.entity, "all"),  // Only overall sync rows, not sub-entity rows
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);
  const last = rows[0];
  return last && last.status === "error" ? last.startedAt : null;
}

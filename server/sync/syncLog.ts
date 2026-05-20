import { desc, eq, and, gt, lt, or, ne, sql } from "drizzle-orm";
import { syncLogs } from "../../drizzle/schema";
import { getDb } from "../db";
import { normalizeSectionKey, type SectionKey, type SyncTrigger } from "../../shared/const";

export async function insertSyncLog(params: {
  section: SectionKey;
  entity: string;
  triggeredBy: SyncTrigger;
}) {
  const db = await getDb(params.section);
  if (!db) throw new Error("DB not available for syncLog.insert");
  const now = new Date();
  const [res] = await db.insert(syncLogs).values({
    section: normalizeSectionKey(params.section),
    entity: params.entity,
    triggeredBy: params.triggeredBy,
    status: "in_progress",
    startedAt: now,
  }).returning({ id: syncLogs.id });
  const id = res?.id;
  if (!id) {
    // id เป็น null หมายความว่า sync_logs.id column ไม่มี auto-increment
    // ให้ throw error เพื่อหยุด sync ทันที แทนที่จะรันต่อโดยไม่มี progress tracking
    throw new Error(
      `[syncLog] INSERT returned null id for ${params.section}/${params.entity}. ` +
      `sync_logs.id column is missing auto-increment sequence. ` +
      `Run DB migration: CREATE SEQUENCE sync_logs_id_seq; ALTER TABLE sync_logs ALTER COLUMN id SET DEFAULT nextval('sync_logs_id_seq');`
    );
  }
  return { id, startedAt: now };
}

export async function finishSyncLog(params: {
  id: number;
  section?: SectionKey;
  status: "success" | "error";
  rowCount?: number;
  errorMessage?: string;
}) {
  const db = await getDb(params.section);
  if (!db || !params.id) return;
  await db
    .update(syncLogs)
    .set({
      status: params.status,
      rowCount: params.rowCount ?? 0,
      errorMessage: params.errorMessage?.slice(0, 2000) ?? null,
      finishedAt: new Date(),
      // Always set progress=100 + currentStage='done' on success
      // so UI shows 100% even if the last setSubProgress was < 100%
      ...(params.status === "success" ? { progress: 100, currentStage: "done" } : {}),
    })
    .where(eq(syncLogs.id, params.id));
}

/**
 * Update current_stage + progress for a running sync log row.
 * Written to DB so ALL Cloud Run instances can read the same status.
 */
export async function updateSyncLogStage(params: {
  id: number;
  section?: SectionKey;
  currentStage: string;
  progress: number;
  resumePage?: number;
}) {
  const db = await getDb(params.section);
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
 */
export async function getLastCustomersResumePage(section: SectionKey): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;
  // Only resume from an in_progress row that:
  //  1. Was started within the last 30 minutes (not stale/killed)
  //  2. Has resume_page > 0 (has actually made progress)
  // This prevents resuming from a page that was stuck/killed in a previous session.
  // If the previous run was killed, start fresh from page 1 instead.
  const RESUME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  const cutoff = new Date(Date.now() - RESUME_WINDOW_MS);
  const rows = await db
    .select({ resumePage: syncLogs.resumePage, status: syncLogs.status, startedAt: syncLogs.startedAt })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.entity, "customers"),
        eq(syncLogs.status, "in_progress"),
        // Only consider rows started within the resume window
        sql`${syncLogs.startedAt} >= ${cutoff}`,
      ),
    )
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);
  const resumePage = rows[0]?.resumePage ?? 0;
  if (resumePage > 1) {
    console.log(`[syncLog] ${section}: resuming customers from page ${resumePage} (in_progress row started ${rows[0]?.startedAt?.toISOString()})`);
  }
  return resumePage;
}

/**
 * Get the resume_page for a previous contracts sync that was killed mid-way.
 * Returns 0 if no recent error row with resume_page > 0 exists (start from page 1).
 *
 * Uses a 3-hour window because contracts sync (including IMEI enrichment)
 * can take up to 2.5 hours for 17k+ contracts.
 * Only resumes if the error row was started within the window AND has resume_page > 0.
 */
export async function getLastContractsResumePage(section: SectionKey): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;
  // 3-hour window: contracts sync (list + IMEI enrichment) can take ~2.5h
  const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - RESUME_WINDOW_MS);
  const rows = await db
    .select({ resumePage: syncLogs.resumePage, status: syncLogs.status, startedAt: syncLogs.startedAt })
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
  const resumePage = rows[0]?.resumePage ?? 0;
  if (resumePage > 1) {
    console.log(`[syncLog] ${section}: resuming contracts from page ${resumePage} (killed row started ${rows[0]?.startedAt?.toISOString()})`);
  }
  return resumePage;
}

/**
 * Get running sync status from DB for a section.
 * Returns null if no sync is in_progress (or if it's stale > 185 minutes).
 * 185 min = OVERALL_TIMEOUT_MS (180 min) + 5 min buffer.
 * Used by sync.status tRPC procedure so ALL instances see the same state.
 *
 * Fix (2026-05-11): ตรวจสอบเฉพาะ entity='all' เพื่อความถูกต้องของ progress
 * ป้องกันกรณีที่ UI ไปหยิบเอา entity-level logs มาแสดงผลแทนตัวหลัก
 */
export async function getDbSyncStatus(section: SectionKey): Promise<{
  running: boolean;
  startedAt: Date | null;
  currentStage: string | null;
  progress: number | null;
} | null> {
  const db = await getDb(section);
  if (!db) return null;
  // Treat in_progress rows older than 185 minutes as abandoned
  // (matches OVERALL_TIMEOUT_MS=180min + 5min buffer in runner.ts)
  const staleThreshold = new Date(Date.now() - 185 * 60 * 1000);

  // ดึงเฉพาะ entity='all' row (มี currentStage + progress ที่อัพเดตต่อเนื่อง)
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
      progress: row.progress ?? null,
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
  const db = await getDb(section);
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
    ).returning({ id: syncLogs.id });
  const affectedRows = result.length;
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
  // Run cleanup on both databases
  // Use 185-minute timeout to match OVERALL_TIMEOUT_MS (180 min) + 5 min buffer in runner.ts
  // Previously 15 min caused false-positive cleanup of long-running syncs (e.g. IMEI enrichment)
  const dbBoon = await getDb("Boonphone");
  const dbFastfone = await getDb("Fastfone365");
  let total = 0;
  for (const db of [dbBoon, dbFastfone].filter(Boolean)) {
    if (!db) continue;
    const cutoff = new Date(Date.now() - 185 * 60 * 1000);
    const rows = await db
      .update(syncLogs)
      .set({ status: "error", errorMessage: "Cleared by startup cleanup (stuck > 185 min)", finishedAt: new Date() })
      .where(and(eq(syncLogs.status, "in_progress"), lt(syncLogs.startedAt, cutoff)))
      .returning({ id: syncLogs.id });
    total += rows.length;
  }
  return total;
}

/** Most recent successful sync for a given (section, entity). */
export async function getLastSyncedAt(params: {
  section: SectionKey;
  entity?: string;
}): Promise<Date | null> {
  const db = await getDb(params.section);
  if (!db) return null;
  // Always query entity='all' rows only — these represent a full sync cycle.
  // This ensures the UI shows the time when the ENTIRE sync completed,
  // not just when a sub-entity (e.g. partners) finished.
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
  const dbBoon = await getDb("Boonphone");
  const dbFast = await getDb("Fastfone365");
  const results: Array<{
    id: number;
    section: string;
    entity: string;
    startedAt: Date;
    triggeredBy: string;
  }> = [];
  for (const db of [dbBoon, dbFast]) {
    if (!db) continue;
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
    results.push(...rows);
  }
  return results;
}

/** Recent sync history for a section (for Sync Logs panel in Settings). */
export async function listSyncLogs(section?: SectionKey, limit = 50) {
  const db = await getDb(section ?? "Boonphone");
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
 */
export async function getLastErrorAt(params: {
  section: SectionKey;
}): Promise<Date | null> {
  const db = await getDb(params.section);
  if (!db) return null;
  const rows = await db
    .select({
      startedAt: syncLogs.startedAt,
      status: syncLogs.status,
    })
    .from(syncLogs)
    .where(eq(syncLogs.section, params.section))
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);
  const last = rows[0];
  return last && last.status === "error" ? last.startedAt : null;
}

/**
 * Set cancel_requested = true on all in_progress rows for a section.
 * Written to DB so ALL instances (cross-instance) can detect the cancel flag.
 * Returns number of rows updated.
 */
export async function setCancelRequestedInDb(section: SectionKey): Promise<number> {
  const db = await getDb(section);
  if (!db) return 0;
  const rows = await db
    .update(syncLogs)
    .set({ cancelRequested: true })
    .where(
      and(
        eq(syncLogs.section, section),
        eq(syncLogs.status, "in_progress"),
      ),
    )
    .returning({ id: syncLogs.id });
  console.log(`[syncLog] setCancelRequested(${section}): flagged ${rows.length} row(s)`);
  return rows.length;
}

/**
 * Check if cancel has been requested for a given sync log row (by id).
 * Reads from DB so it works across instances.
 * Returns true if cancel_requested = true.
 */
export async function isCancelRequestedInDb(params: {
  id: number;
  section: SectionKey;
}): Promise<boolean> {
  const db = await getDb(params.section);
  if (!db || !params.id) return false;
  const rows = await db
    .select({ cancelRequested: syncLogs.cancelRequested })
    .from(syncLogs)
    .where(eq(syncLogs.id, params.id))
    .limit(1);
  return rows[0]?.cancelRequested === true;
}

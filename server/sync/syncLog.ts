import { desc, eq, and, gt, lt } from "drizzle-orm";
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
}) {
  const db = await getDb();
  if (!db || !params.id) return;
  await db
    .update(syncLogs)
    .set({
      currentStage: params.currentStage,
      progress: params.progress,
    })
    .where(eq(syncLogs.id, params.id));
}

/**
 * Get running sync status from DB for a section.
 * Returns null if no sync is in_progress (or if it's stale > 95 minutes).
 * Used by sync.status tRPC procedure so ALL instances see the same state.
 */
export async function getDbSyncStatus(section: SectionKey): Promise<{
  running: boolean;
  startedAt: Date | null;
  currentStage: string | null;
  progress: number | null;
} | null> {
  const db = await getDb();
  if (!db) return null;
  // Treat in_progress rows older than 95 minutes as abandoned
  const staleThreshold = new Date(Date.now() - 95 * 60 * 1000);
  const rows = await db
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

  if (rows.length === 0) return { running: false, startedAt: null, currentStage: null, progress: null };
  const row = rows[0];
  return {
    running: true,
    startedAt: row.startedAt,
    currentStage: row.currentStage ?? null,
    progress: row.progress ?? 0,
  };
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
  // Only clear rows that have been in_progress for more than 95 minutes.
  // This prevents clearing sync_logs from run-manual-sync processes that are
  // still actively running when the dev server restarts.
  const cutoff = new Date(Date.now() - 95 * 60 * 1000);
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
    console.log(`[syncLog] startup cleanup: cleared ${affectedRows} stuck in_progress row(s) older than 95 min`);
  }
  return affectedRows;
}

/** Most recent successful sync for a given (section, entity). */
export async function getLastSyncedAt(params: {
  section: SectionKey;
  entity?: string;
}): Promise<Date | null> {
  const db = await getDb();
  if (!db) return null;
  const cond = params.entity
    ? and(
        eq(syncLogs.section, params.section),
        eq(syncLogs.entity, params.entity),
        eq(syncLogs.status, "success"),
      )
    : and(
        eq(syncLogs.section, params.section),
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
    .where(eq(syncLogs.section, params.section))
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);
  const last = rows[0];
  return last && last.status === "error" ? last.startedAt : null;
}

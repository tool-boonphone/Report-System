import { desc, eq, and } from "drizzle-orm";
import { syncLogs } from "../../drizzle/schema";
import { getDb } from "../db";
import type { SectionKey, SyncTrigger } from "../../shared/const";

export async function insertSyncLog(params: {
  section: SectionKey;
  entity: string;
  triggeredBy: SyncTrigger;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available for syncLog.insert");
  const now = new Date();
  const [res] = await db.insert(syncLogs).values({
    section: params.section,
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

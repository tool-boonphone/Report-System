import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, appProcedure } from "../_core/trpc";
import { runSectionSync, isSyncRunning, getSyncStatus, requestCancelSync, SYNC_STAGES, syncMdmOnlineDays } from "../sync/runner";
import {
  getLastSyncedAt,
  listSyncLogs,
  getRunningSyncs,
  getDbSyncStatus,
  clearStuckSyncLogs,
} from "../sync/syncLog";
import { desc, eq, and, gt, lt } from "drizzle-orm";
import { syncLogs } from "../../drizzle/schema";
import { getDb } from "../db";
import { sectionSchema, type SectionKey } from "../../shared/const";

// sectionSchema imported from shared/const — normalizes any case to canonical SectionKey

export const syncRouter = router({
  /**
   * Kick off a manual sync (fire-and-forget).
   * Returns immediately with { queued: true } so Cloud Run doesn't timeout.
   * Frontend polls sync.status for live progress updates.
   */
  trigger: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input }) => {
      const section = input.section as SectionKey;
      if (isSyncRunning(section)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Sync for ${section} is already running`,
        });
      }
      // Fire-and-forget: start sync in background, return immediately.
      // Cloud Run has a ~60s request timeout; sync takes 5-15 min, so we
      // must NOT await here. The frontend polls sync.status for progress.
      runSectionSync(section, "manual").catch((err) => {
        console.error(`[sync.trigger] ${section} failed:`, err?.message ?? err);
      });
      return { queued: true, section };
    }),

  /**
   * Sync status — reads from DB (cross-instance safe for Cloud Run).
   * Falls back to in-memory lock if DB returns running=false but lock is set
   * (same-instance fast path).
   */
  status: appProcedure.query(async () => {
    // Fetch DB status for both sections in parallel
    const [bpDb, ffDb] = await Promise.all([
      getDbSyncStatus("Boonphone"),
      getDbSyncStatus("Fastfone365"),
    ]);

    // In-memory fallback (same instance)
    const bpMem = getSyncStatus("Boonphone");
    const ffMem = getSyncStatus("Fastfone365");

    const bpRunning = (bpDb?.running ?? false) || isSyncRunning("Boonphone");
    const ffRunning = (ffDb?.running ?? false) || isSyncRunning("Fastfone365");

    // Helper: derive stageIndex from currentStage when in-memory is unavailable (cross-instance)
    const deriveStageIndex = (stage: string | null | undefined): number | null => {
      if (stage == null) return null;
      const idx = SYNC_STAGES.indexOf(stage as any);
      return idx >= 0 ? idx : null;
    };

    // Prefer DB as primary source (cross-instance safe).
    // Fall back to in-memory only when DB has no data (same-instance fast path).
    const bpCurrentStage = bpDb?.currentStage ?? bpMem?.currentStage ?? null;
    const ffCurrentStage = ffDb?.currentStage ?? ffMem?.currentStage ?? null;

    // progress: DB is primary (written by setStage/setSubProgress via updateSyncLogStage).
    // In-memory fallback only when DB progress is null (e.g. very start of sync before first DB write).
    const bpProgress = bpDb?.progress ?? bpMem?.progress ?? null;
    const ffProgress = ffDb?.progress ?? ffMem?.progress ?? null;

    // stageIndex: derive from currentStage (works cross-instance).
    // totalStages: always use SYNC_STAGES.length when running.
    const bpStageIndex = bpMem?.stageIndex ?? deriveStageIndex(bpCurrentStage);
    const ffStageIndex = ffMem?.stageIndex ?? deriveStageIndex(ffCurrentStage);
    const bpTotalStages = bpRunning ? SYNC_STAGES.length : null;
    const ffTotalStages = ffRunning ? SYNC_STAGES.length : null;

    return {
      Boonphone: {
        running: bpRunning,
        startedAt: bpDb?.startedAt?.getTime() ?? bpMem?.startedAt ?? null,
        progress: bpProgress,
        currentStage: bpCurrentStage,
        stageIndex: bpStageIndex,
        totalStages: bpTotalStages,
      },
      Fastfone365: {
        running: ffRunning,
        startedAt: ffDb?.startedAt?.getTime() ?? ffMem?.startedAt ?? null,
        progress: ffProgress,
        currentStage: ffCurrentStage,
        stageIndex: ffStageIndex,
        totalStages: ffTotalStages,
      },
      active: await getRunningSyncs(),
    };
  }),

  /**
   * Trigger MDM online days sync only (fast, ~30s).
   * ดึง MDM device list ครั้งเดียว แล้ว bulk update last_online_days ใน contracts
   * ไม่ต้องรอ Full Sync — ใช้ได้ทันทีหลัง deploy
   */
  syncMdm: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Sync" });
        }
      }
      const section = input.section as SectionKey;
      // Fire-and-forget — รัน background ไม่ต้องรอ
      syncMdmOnlineDays(section).then((count) => {
        console.log(`[sync.syncMdm] ${section}: updated ${count} contracts`);
      }).catch((err) => {
        console.error(`[sync.syncMdm] ${section} failed:`, err?.message ?? err);
      });
      return { queued: true, section };
    }),

  /**
   * testMdm — Diagnostic endpoint: ทดสอบ MDM API connection โดยตรง
   * คืน status, masked key, และ body preview เพื่อ debug 403 บน Render
   */
  testMdm: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const rawKey =
        section === "Boonphone"
          ? (process.env.MDM_API_KEY_BOONPHONE ?? "")
          : (process.env.MDM_API_KEY_FASTFONE365 ?? "");
      const trimmedKey = rawKey.trim();
      const maskedKey = trimmedKey
        ? `${trimmedKey.slice(0, 6)}...${trimmedKey.slice(-4)} (len=${trimmedKey.length}, rawLen=${rawKey.length})`
        : "(empty)";
      const url = `https://mdm-th.com/api/mdm/devices?pageNum=1&pageSize=1`;
      try {
        const res = await fetch(url, {
          headers: {
            "X-API-Key": trimmedKey,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.text();
        return {
          section,
          maskedKey,
          url,
          status: res.status,
          statusText: res.statusText,
          bodyPreview: body.slice(0, 500),
          ok: res.ok,
        };
      } catch (err: any) {
        return {
          section,
          maskedKey,
          url,
          status: 0,
          statusText: "fetch error",
          bodyPreview: err?.message ?? String(err),
          ok: false,
        };
      }
    }),

  /** Last successful sync timestamp for a section. */
  lastSyncedAt: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const ts = await getLastSyncedAt({
        section: input.section as SectionKey,
      });
      return { section: input.section, lastSyncedAt: ts };
    }),

  /**
   * Force-clear all in_progress sync logs for a section.
   * Use when a sync got stuck (e.g. Cloud Run killed the process mid-sync).
   * Requires canSync permission on sync_api.
   */
  clearStuck: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      // Permission check — only users with sync permission can clear stuck syncs
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Re-Sync" });
        }
      }
      const section = input.section as SectionKey;
      const cleared = await clearStuckSyncLogs(section);
      return { section, cleared };
    }),

  /**
   * Cancel a running sync for a section.
   * Sets a cancellation flag that will be checked between stages.
   * Note: if sync is stuck mid-request (e.g. API hang), it will cancel after the current request times out.
   */
  cancel: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      // Permission check
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ยกเลิก Sync" });
        }
      }
      const section = input.section as SectionKey;
      const wasRunning = requestCancelSync(section);
      // Also clear DB lock so UI stops showing running state
      await clearStuckSyncLogs(section);
      console.log(`[sync.cancel] ${section}: cancel requested (wasRunning=${wasRunning})`);
      return { section, cancelled: true, wasRunning };
    }),

  /**
   * Summary of the last sync run for a section.
   * Returns the overall row (entity='all') plus all entity-level rows
   * from the same sync run, so the UI can show a detailed breakdown.
   */
  lastRunSummary: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const db = await getDb(section);
      if (!db) return null;

      // Find the most recent entity='all' row (any status)
      const overallRows = await db
        .select()
        .from(syncLogs)
        .where(and(eq(syncLogs.section, section), eq(syncLogs.entity, "all")))
        .orderBy(desc(syncLogs.startedAt))
        .limit(1);

      const overall = overallRows[0];
      if (!overall) return null;

      // Get all entity-level rows from the same sync run
      // (started within 30 seconds of the overall row)
      const windowStart = new Date(overall.startedAt!.getTime() - 30_000);
      const windowEnd = new Date(overall.startedAt!.getTime() + 30_000);
      const entityRows = await db
        .select()
        .from(syncLogs)
        .where(
          and(
            eq(syncLogs.section, section),
            gt(syncLogs.startedAt, windowStart),
            lt(syncLogs.startedAt, windowEnd),
          ),
        )
        .orderBy(syncLogs.startedAt);

      return {
        overall,
        entities: entityRows.filter((r) => r.entity !== "all"),
      };
    }),

  /** Recent sync log entries. Default last 50. */
  recent: appProcedure
    .input(
      z
        .object({
          section: sectionSchema.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return await listSyncLogs(
        input?.section as SectionKey | undefined,
        input?.limit ?? 50,
      );
    }),
});

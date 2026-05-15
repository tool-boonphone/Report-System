import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, appProcedure } from "../_core/trpc";
import { runSectionSync, isSyncRunning, getSyncStatus, requestCancelSync } from "../sync/runner";
import {
  getLastSyncedAt,
  listSyncLogs,
  getRunningSyncs,
  getDbSyncStatus,
  clearStuckSyncLogs,
} from "../sync/syncLog";
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

    return {
      Boonphone: {
        running: bpRunning,
        // Prefer DB values (cross-instance), fall back to in-memory
        startedAt: bpDb?.startedAt?.getTime() ?? bpMem?.startedAt ?? null,
        progress: bpDb?.progress ?? bpMem?.progress ?? null,
        currentStage: bpDb?.currentStage ?? bpMem?.currentStage ?? null,
        stageIndex: bpMem?.stageIndex ?? null,
        totalStages: bpMem?.totalStages ?? null,
      },
      Fastfone365: {
        running: ffRunning,
        startedAt: ffDb?.startedAt?.getTime() ?? ffMem?.startedAt ?? null,
        progress: ffDb?.progress ?? ffMem?.progress ?? null,
        currentStage: ffDb?.currentStage ?? ffMem?.currentStage ?? null,
        stageIndex: ffMem?.stageIndex ?? null,
        totalStages: ffMem?.totalStages ?? null,
      },
      active: await getRunningSyncs(),
    };
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

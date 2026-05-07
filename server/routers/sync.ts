import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, appProcedure } from "../_core/trpc";
import { runSectionSync, isSyncRunning, getSyncStatus } from "../sync/runner";
import {
  getLastSyncedAt,
  listSyncLogs,
  getRunningSyncs,
  getDbSyncStatus,
} from "../sync/syncLog";
import { SECTIONS, type SectionKey } from "../../shared/const";

const sectionSchema = z.enum(SECTIONS as unknown as [string, ...string[]]);

export const syncRouter = router({
  /**
   * Kick off a manual sync. Returns immediately — the caller should poll
   * `sync.status` / `sync.recent` to observe progress.
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
      // Fire-and-forget — do not await; let the background task continue.
      runSectionSync(section, "manual").catch((err) => {
        console.error(`[sync.trigger] ${section}`, err);
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

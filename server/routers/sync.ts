import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, appProcedure } from "../_core/trpc";
import { runSectionSync, isSyncRunning, getSyncStatus } from "../sync/runner";
import {
  getLastSyncedAt,
  listSyncLogs,
  getRunningSyncs,
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

  /** Current in-memory lock status for each section. */
  status: appProcedure.query(async () => {
    const bpInfo = getSyncStatus("Boonphone");
    const ffInfo = getSyncStatus("Fastfone365");
    return {
      Boonphone: {
        running: isSyncRunning("Boonphone"),
        info: bpInfo,
        // Convenience fields for progress bar
        startedAt: bpInfo?.startedAt ?? null,
        progress: bpInfo?.progress ?? null,
        currentStage: bpInfo?.currentStage ?? null,
        stageIndex: bpInfo?.stageIndex ?? null,
        totalStages: bpInfo?.totalStages ?? null,
      },
      Fastfone365: {
        running: isSyncRunning("Fastfone365"),
        info: ffInfo,
        // Convenience fields for progress bar
        startedAt: ffInfo?.startedAt ?? null,
        progress: ffInfo?.progress ?? null,
        currentStage: ffInfo?.currentStage ?? null,
        stageIndex: ffInfo?.stageIndex ?? null,
        totalStages: ffInfo?.totalStages ?? null,
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

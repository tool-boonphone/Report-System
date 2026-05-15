/**
 * fillPeriodNosRouter.ts
 *
 * tRPC router สำหรับ trigger backfill period_no/sub_no
 * ใช้ผ่าน admin endpoint เท่านั้น
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { fillPeriodNosForSection, fillPeriodNosAll } from "../sync/fillPeriodNos";
import { sectionSchema, type SectionKey } from "../../shared/const";

export const fillPeriodNosRouter = router({
  /** Backfill period_no/sub_no สำหรับ section ที่ระบุ */
  fillSection: protectedProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input }) => {
      const count = await fillPeriodNosForSection(input.section as SectionKey);
      return { ok: true, updatedRows: count };
    }),

  /** Backfill period_no/sub_no สำหรับทั้ง 2 sections */
  fillAll: protectedProcedure.mutation(async () => {
    await fillPeriodNosAll();
    return { ok: true };
  }),
});

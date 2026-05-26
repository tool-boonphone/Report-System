/**
 * Watch Group router (Phase 131).
 * Endpoint: trpc.watchGroup.list
 * Permission: watch_group / view
 *
 * Returns contracts in "กลุ่มเฝ้าระวัง":
 * - ไม่เคยชำระเลย (0 งวด)
 * - ถึงกำหนดงวดแรกหรืองวดสอง และเกินช่วงผ่อนผัน N วัน
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { listWatchGroup } from "../debtDb";
import { sectionSchema } from "../../shared/const";

const viewProcedure = requirePermission("watch_group", "view");

export const watchGroupRouter = router({
  list: viewProcedure
    .input(
      z.object({
        section: sectionSchema,
        gracePeriod: z.number().int().min(0).max(365).optional(),
        arrearsFilter: z.enum(["0", "1"]).optional(),
        productTypes: z.array(z.string()).optional(),
        partnerSearch: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      return listWatchGroup(input);
    }),
});

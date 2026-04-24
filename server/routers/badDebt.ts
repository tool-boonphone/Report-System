/**
 * Bad Debt Summary router (Phase 9k).
 * Endpoint: trpc.badDebt.summary
 * Permission: bad_debt_summary / view
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { getBadDebtSummary } from "../badDebtDb";
import { SECTIONS } from "../../shared/const";

const badDebtViewProcedure = requirePermission("bad_debt_summary", "view");
const SectionEnum = z.enum(SECTIONS);

export const badDebtRouter = router({
  summary: badDebtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        approveMonth: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      return getBadDebtSummary(input);
    }),
});

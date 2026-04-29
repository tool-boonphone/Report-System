/**
 * Suspected Bad Debt router (Phase 105).
 * Endpoint: trpc.suspectedBadDebt.list
 * Permission: suspected_bad_debt / view
 *
 * Returns contracts with debtStatus "เกิน 61-90" or "เกิน >90".
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { listSuspectedBadDebt } from "../debtDb";
import { SECTIONS } from "../../shared/const";

const viewProcedure = requirePermission("suspected_bad_debt", "view");
const SectionEnum = z.enum(SECTIONS);

export const suspectedBadDebtRouter = router({
  list: viewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      return listSuspectedBadDebt(input);
    }),
});

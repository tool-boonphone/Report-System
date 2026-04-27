/**
 * Monthly Summary router.
 *
 * getMonthlySummary: ดึงข้อมูลสรุปรายเดือน group by approve_date + debt_status bucket
 *   - section: Boonphone | Fastfone365
 *   - optional filters: approveDateFrom/To, approveMonthFrom/To, dueMonthFrom/To, productType
 *
 * Protected by permissionProcedure('debt_report', 'view') — ใช้สิทธิ์เดียวกับ debt report
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { getMonthlySummary } from "../monthlySummaryDb";
import { SECTIONS } from "../../shared/const";

const debtViewProcedure = requirePermission("debt_report", "view");
const SectionEnum = z.enum(SECTIONS);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional();

export const monthlySummaryRouter = router({
  get: debtViewProcedure
    .input(
      z.object({
        section:     SectionEnum,
        /** กรองตามวันที่รับชำระ (paid_at) */
        paidAtFrom:  DateStr,
        paidAtTo:    DateStr,
        productType: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      return getMonthlySummary(input);
    }),
});

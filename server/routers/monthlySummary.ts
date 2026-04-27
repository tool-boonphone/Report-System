/**
 * Monthly Summary router.
 *
 * getMonthlySummary: ดึงข้อมูลสรุปรายเดือน group by approve_date + debt_status bucket
 *   - section: Boonphone | Fastfone365
 *   - แต่ละแถบมี filter ของตัวเอง:
 *       count tab  → countProductType
 *       paid tab   → paidAtFrom/paidAtTo/paidAtMonth + paidProductType
 *       due tab    → dueAtFrom/dueAtTo/dueAtMonth + dueProductType
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
const MonthStr = z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM").optional();

export const monthlySummaryRouter = router({
  get: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,

        // --- แถบจำนวนสัญญา ---
        countProductType: z.string().optional(),

        // --- แถบยอดชำระแล้ว ---
        /** วันที่รับชำระ from (YYYY-MM-DD) */
        paidAtFrom:      DateStr,
        /** วันที่รับชำระ to (YYYY-MM-DD) */
        paidAtTo:        DateStr,
        /** เดือน-ปีที่ชำระ (YYYY-MM) — override paidAtFrom/paidAtTo */
        paidAtMonth:     MonthStr,
        paidProductType: z.string().optional(),

        // --- แถบยอดค้างชำระ ---
        /** วันที่ต้องชำระ from (YYYY-MM-DD) */
        dueAtFrom:       DateStr,
        /** วันที่ต้องชำระ to (YYYY-MM-DD) */
        dueAtTo:         DateStr,
        /** เดือน-ปีที่ต้องชำระ (YYYY-MM) — override dueAtFrom/dueAtTo */
        dueAtMonth:      MonthStr,
        dueProductType:  z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      return getMonthlySummary(input);
    }),
});

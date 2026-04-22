/**
 * Debt-report router.
 *   - summary           : รวมทั้งช่วง + แยกรายเดือน
 *   - overdueTop        : สัญญาค้างชำระสูงสุด (ณ วันที่)
 *
 * ทุก procedure ถูกป้องกันด้วย permissionProcedure('debt', 'canView')
 * เพื่อให้ตรงกับหน้าจัดการกลุ่มสิทธิ์ (menu = 'debt').
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { getDebtReport, getOverdueTopList } from "../debtDb";
import { SECTIONS } from "../../shared/const";

const debtViewProcedure = requirePermission("debt_report", "view");
const SectionEnum = z.enum(SECTIONS);
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const debtRouter = router({
  summary: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        from: DateStr,
        to: DateStr,
      }),
    )
    .query(async ({ input }) => {
      return getDebtReport(input);
    }),

  overdueTop: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        asOf: DateStr,
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      return getOverdueTopList(input);
    }),
});

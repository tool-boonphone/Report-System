/**
 * Debt-report router.
 *   - summary      : รวมทั้งช่วง + แยกรายเดือน (เก็บไว้เผื่อ backward compatibility)
 *   - overdueTop   : สัญญาค้างชำระสูงสุด
 *   - listTarget   : "เป้าเก็บหนี้" — ตารางรายงานต่อสัญญาของงวดตาม schedule จาก installments
 *   - listCollected: "ยอดเก็บหนี้" — ตารางรายงานต่อสัญญาจากการชำระจริง (payment_transactions)
 *
 * ทุก procedure ถูกป้องกันด้วย permissionProcedure('debt_report', 'view').
 */
import { z } from "zod";
import { protectedProcedure, requirePermission, router } from "../_core/trpc";
import {
  getDebtReport,
  getOverdueTopList,
  listDebtCollected,
  listDebtTarget,
} from "../debtDb";
import {
  getCachedTarget,
  setCachedTarget,
  getCachedCollected,
  setCachedCollected,
  invalidateAllDebtCache,
} from "../debtCache";
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

  listTarget: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      // Check in-memory cache first (TTL: 5 min per section)
      const cached = getCachedTarget(input.section);
      if (cached) {
        console.log(`[debtCache] HIT listTarget for ${input.section}`);
        return cached;
      }
      const result = await listDebtTarget(input);
      setCachedTarget(input.section, result);
      return result;
    }),

  listCollected: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      // Check in-memory cache first (TTL: 5 min per section)
      const cached = getCachedCollected(input.section);
      if (cached) {
        console.log(`[debtCache] HIT listCollected for ${input.section}`);
        return cached;
      }
      const result = await listDebtCollected(input);
      setCachedCollected(input.section, result);
      return result;
    }),

  /** Admin: clear all in-memory cache so next query recomputes from DB */
  invalidateCache: protectedProcedure.mutation(async () => {
    invalidateAllDebtCache();
    return { ok: true };
  }),
});

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
import {
  getTargetChunk,
  getCollectedChunk,
} from "../sync/queryCacheDb";
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

  /**
   * Phase 114: Paginated chunk query for target (เป้าเก็บหนี้).
   * Returns a slice of ~2,000 contracts from DB cache — small enough for Cloudflare.
   * Frontend calls this in a loop until hasMore === false.
   */
  getTargetChunk: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(5000).default(2000),
      }),
    )
    .query(async ({ input }) => {
      // Try in-memory cache first — if warm, slice from it (fastest)
      const cached = getCachedTarget(input.section);
      if (cached) {
        const slice = cached.rows.slice(input.offset, input.offset + input.limit);
        return {
          rows: slice,
          totalContracts: cached.rows.length,
          hasMore: input.offset + input.limit < cached.rows.length,
        };
      }
      // DB cache path — paginated query
      const { rows, totalContracts } = await getTargetChunk({
        section: input.section,
        offset: input.offset,
        limit: input.limit,
      });
      return {
        rows,
        totalContracts,
        hasMore: input.offset + input.limit < totalContracts,
      };
    }),

  /**
   * Phase 114: Paginated chunk query for collected (ยอดเก็บหนี้).
   * Returns a slice of ~2,000 contracts from DB cache — small enough for Cloudflare.
   * Frontend calls this in a loop until hasMore === false.
   */
  getCollectedChunk: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(5000).default(2000),
      }),
    )
    .query(async ({ input }) => {
      // Try in-memory cache first — if warm, slice from it (fastest)
      const cached = getCachedCollected(input.section);
      if (cached) {
        const slice = cached.rows.slice(input.offset, input.offset + input.limit);
        return {
          rows: slice,
          totalContracts: cached.rows.length,
          hasMore: input.offset + input.limit < cached.rows.length,
          hasPrincipalBreakdown: cached.hasPrincipalBreakdown,
        };
      }
      // DB cache path — paginated query
      const { rows, totalContracts, hasPrincipalBreakdown } = await getCollectedChunk({
        section: input.section,
        offset: input.offset,
        limit: input.limit,
      });
      return {
        rows,
        totalContracts,
        hasMore: input.offset + input.limit < totalContracts,
        hasPrincipalBreakdown,
      };
    }),

  /** Admin: clear all in-memory cache so next query recomputes from DB */
  invalidateCache: protectedProcedure.mutation(async () => {
    invalidateAllDebtCache();
    return { ok: true };
  }),

  /** Get pre-built export info (builtAt, rowCount) for a section+variant */
  getExportInfo: debtViewProcedure
    .input(z.object({
      section: z.string(),
      variant: z.enum(["target", "collected"]),
    }))
    .query(async ({ input }) => {
      const { getDebtExportEntry } = await import("../debtExportBuilder");
      const entry = await getDebtExportEntry(input.section, input.variant);
      if (!entry) return null;
      return {
        builtAt: entry.builtAt,
        rowCount: entry.rowCount,
      };
    }),
});

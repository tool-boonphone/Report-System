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
  getTargetChunk,
  getCollectedChunk,
} from "../sync/queryCacheDb";
import { sectionSchema } from "../../shared/const";
import {
  getMonthlyCollectionSnapshots,
  getMonthlyTargetDetail,
  getMonthlyCollectedDetail,
} from "../monthlyCollectionSnapshotDb";

const debtViewProcedure = requirePermission("debt_report", "view");
const SectionEnum = sectionSchema;
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
      return listDebtTarget(input);
    }),

  listCollected: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      return listDebtCollected(input);
    }),

  getTargetChunk: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      offset: z.number().int().min(0),
      limit: z.number().int().min(1).max(5000),
    }))
    .query(async ({ input }) => {
      return getTargetChunk(input);
    }),

  getCollectedChunk: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      offset: z.number().int().min(0),
      limit: z.number().int().min(1).max(5000),
    }))
    .query(async ({ input }) => {
      return getCollectedChunk(input);
    }),

  /** Get pre-built export info (builtAt, rowCount) for a section+variant */
  getExportInfo: debtViewProcedure
    .input(z.object({
      section: sectionSchema,
      variant: z.enum(["target", "collected"]),
    }))
    .query(async () => {
      // Legacy export entry info removed.
      return null;
    }),

  // ── Monthly Collection Snapshot ──────────────────────────────────────────
  /** ดึง monthly_collection_snapshot ทั้งหมดของ section (สำหรับแถบ รายเดือน) */
  getMonthlySnapshots: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      return getMonthlyCollectionSnapshots(input.section);
    }),

  /** ดึง detail rows สำหรับ lightbox เป้าเก็บหนี้ */
  getMonthlyTargetDetail: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      collectionMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      search: z.string().optional(),
      productType: z.string().optional(),
      debtRange: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    }))
    .query(async ({ input }) => {
      return getMonthlyTargetDetail(input);
    }),

  /** ดึง detail rows สำหรับ lightbox ยอดเก็บหนี้ */
  getMonthlyCollectedDetail: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      collectionMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      search: z.string().optional(),
      productType: z.string().optional(),
      debtRange: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    }))
    .query(async ({ input }) => {
      return getMonthlyCollectedDetail(input);
    }),
});

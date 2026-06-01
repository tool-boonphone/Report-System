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
  getTargetContractCount,
} from "../sync/queryCacheDb";
import { sectionSchema } from "../../shared/const";
import {
  getMonthlyCollectionSnapshots,
  getMonthlyCollectionSnapshotsLive,
  getMonthlyTargetDetail,
  getMonthlyCollectedDetail,
  populateMonthlyCollectionSnapshot,
} from "../monthlyCollectionSnapshotDb";
import {
  populateTargetDetailSnapshot as populateMonthlyTargetDetailSnapshot,
  getTargetDetailSnapshot as getMonthlyTargetDetailSnapshot,
  getAvailableSnapshotMonths,
} from "../monthlyTargetDetailSnapshotDb";

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

  /**
   * Live mode: คำนวณ real-time จาก cache โดยตรง (ไม่ผ่าน snapshot table)
   * ใช้สำหรับทดสอบ logic ใหม่โดยไม่ต้อง re-sync ข้อมูล
   */
  getMonthlySnapshotsLive: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      return getMonthlyCollectionSnapshotsLive(input.section);
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

  // ── Monthly Target Detail Snapshot ──────────────────────────────────────
  /**
   * Populate monthly_target_detail_snapshot สำหรับเดือนที่ระบุ
   * ใช้สำหรับทดสอบโดยไม่ต้อง Sync ใหม่ — populate จาก cache ปัจจุบัน
   * Cron จะเรียกอัตโนมัติทุกวันที่ 1 ของเดือน 06:00 น.
   */
  populateTargetDetailSnapshot: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
    }))
    .mutation(async ({ input }) => {
      const count = await populateMonthlyTargetDetailSnapshot(
        input.section,
        input.snapshotMonth,
      );
      return { success: true, rowsInserted: count };
    }),

  /** ดึง detail rows จาก monthly_target_detail_snapshot สำหรับ Lightbox ยอดเก็บหนี้ */
  getTargetDetailSnapshot: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      upToMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM").optional(),
      search: z.string().optional(),
      productType: z.string().optional(),
      debtRange: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      return getMonthlyTargetDetailSnapshot(input);
    }),

  /** ดึงรายการ snapshot months ที่มีอยู่ใน DB */
  getAvailableSnapshotMonths: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      return getAvailableSnapshotMonths(input.section);
    }),

  /**
   * On-demand: สร้าง/อัพเดท monthly_collection_snapshot จาก cache ที่มีอยู่ใน DB
   * ตรวจสอบว่ามีข้อมูล cache ก่อน ถ้าไม่มีข้อมูลใดๆ เลย (hasCacheData: false) จะไม่สร้าง
   */
  rebuildMonthlySnapshot: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .mutation(async ({ input }) => {
      // ตรวจสอบว่ามีข้อมูลใน cache ก่อนสร้าง snapshot
      const cacheCount = await getTargetContractCount(input.section);
      if (cacheCount === 0) {
        // ยังไม่มีข้อมูลใดๆ เลย — รอ Sync Auto
        return { success: false, hasCacheData: false, monthsUpdated: 0 };
      }
      const count = await populateMonthlyCollectionSnapshot(input.section);
      return { success: true, hasCacheData: true, monthsUpdated: count };
    }),
});

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
  backfillFrozenBreakdown,
} from "../monthlyCollectionSnapshotDb";
import {
  populateTargetDetailSnapshot as populateMonthlyTargetDetailSnapshot,
  getTargetDetailSnapshot as getMonthlyTargetDetailSnapshot,
  getAvailableSnapshotMonths,
  getContractInstallmentsBySnapshot,
  saveClientSnapshot,
  getTargetSnapshotGrouped,
  getMonthlyDebtSummary,
  getDailyBreakdown,
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
      snapshotMode: z.enum(["today", "end_of_month"]).default("today"),
      filterDebtOnly: z.boolean().default(false),
      filterPrincipalOnly: z.boolean().default(true),
      filterState: z.string().nullable().optional(), // JSON string ของ filter ที่ใช้ตอน Snapshot — ใช้ auto-restore ตอนเปิดดู Snapshot
      // targetAmount: ยอดเป้าเก็บหนี้ที่ client คำนวณได้ (ตรงกับ badge ยอดหนี้รวม) — บันทึกลง monthly_collection_snapshot โดยตรง
      targetAmount: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const count = await populateMonthlyTargetDetailSnapshot(
        input.section,
        input.snapshotMonth,
        input.snapshotMode,
        input.filterDebtOnly,
        input.filterPrincipalOnly,
        input.filterState ?? null,
        input.targetAmount,
      );
      return { success: true, rowsInserted: count };
    }),

  /** ดึง detail rows จาก monthly_target_detail_snapshot สำหรับ Lightbox ยอดเก็บหนี้ */
  getTargetDetailSnapshot: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      snapshotMode: z.string().optional(),  // 'today' | 'end_of_month'
      upToMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM").optional(),
      search: z.string().optional(),
      productType: z.string().optional(),
      debtRange: z.string().optional(),
      debtOnly: z.boolean().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100000).default(100),
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

  /**
   * WYSIWYS Snapshot: รับ rows ที่แสดงอยู่บนหน้าจอจาก client แล้ว save ลง DB โดยตรง
   * (What You See Is What You Save — ข้อมูลตรงกับที่เห็น 100%)
   */
  saveClientSnapshot: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      snapshotMode: z.enum(["today", "end_of_month"]).default("today"),
      cutoffDate: DateStr,
      filterDebtOnly: z.boolean().default(false),
      filterPrincipalOnly: z.boolean().default(true),
      filterState: z.string().nullable().optional(), // JSON string ของ filter ที่ใช้ตอน Snapshot
      rows: z.array(z.object({
        contractExternalId: z.string(),
        contractNo: z.string().nullable(),
        customerName: z.string().nullable(),
        phone: z.string().nullable(),
        approveDate: z.string().nullable(),
        productType: z.string().nullable(),
        installmentCount: z.number().nullable(),
        installmentAmount: z.number().nullable(),
        debtStatus: z.string(),
        installments: z.array(z.object({
          period: z.number().nullable(),
          dueDate: z.string().nullable(),
          principal: z.number(),
          interest: z.number(),
          fee: z.number(),
          penalty: z.number(),
          unlockFee: z.number(),
          amount: z.number(),
          paid: z.number(),
          baselineAmount: z.number(),
          isClosed: z.boolean(),
          isSuspended: z.boolean(),
          isCurrentPeriod: z.boolean(),
          isFuturePeriod: z.boolean(),
          isArrears: z.boolean(),
          isPaid: z.boolean(),
          netAmount: z.number().optional(),
        })),
      })),
    }))
    .mutation(async ({ input }) => {
      const count = await saveClientSnapshot(
        input.section,
        input.snapshotMonth,
        input.snapshotMode,
        input.cutoffDate,
        input.filterDebtOnly,
        input.filterPrincipalOnly,
        input.rows,
        input.filterState ?? null,
      );
      return { success: true, rowsInserted: count };
    }),

  /**
   * ดึง snapshot ทั้งหมดแบบ contract-level (GROUP BY contract)
   * — ไม่มี pagination — ได้ครบทุกสัญญาไม่มี limit
   * — ใช้สำหรับ Snapshot View แทน getTargetDetailSnapshot
   */
  getTargetSnapshotGrouped: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
    }))
    .query(async ({ input }) => {
      return getTargetSnapshotGrouped(input);
    }),

  /** ดึงงวดทั้งหมดของสัญญาหนึ่งจาก snapshot — ใช้สำหรับ Installment Detail Lightbox */
  getContractInstallments: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      contractNo: z.string().min(1),
    }))
    .query(async ({ input }) => {
      return getContractInstallmentsBySnapshot(input);
    }),

  /**
   * Backfill frozen target_by_range + daily_breakdown สำหรับ snapshot เก่า
   * ถ้าไม่ระบุ snapshotMonth จะ backfill ทุกเดือนที่มีใน monthly_collection_snapshot
   */
  backfillFrozenBreakdown: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM").optional(),
    }))
    .mutation(async ({ input }) => {
      const count = await backfillFrozenBreakdown(input.section, input.snapshotMonth);
      return { success: true, monthsUpdated: count };
    }),

  // ── Monthly Debt Summary (เป้าเก็บหนี้รายเดือน) ──────────────────────────
  /**
   * ดึง summary รายเดือน สำหรับ dropdown "เป้าเก็บหนี้รายเดือน"
   * - targetAmount    = SUM(net_amount) จาก monthly_target_detail_snapshot (freeze ณ วันที่ 1)
   * - collectedAmount = collected_amount - collected_sale จาก monthly_collection_snapshot
   * - percentage      = collectedAmount / targetAmount × 100
   */
  getMonthlyDebtSummary: debtViewProcedure
    .input(z.object({ section: SectionEnum }))
    .query(async ({ input }) => {
      return getMonthlyDebtSummary(input.section);
    }),

  /**
   * ดึงยอดเป้าเก็บหนี้และยอดเก็บหนี้จริง แยกตามวันที่ 1-สิ้นเดือน
   * สำหรับ popup ใน Snapshot row ของ DebtReport
   */
  getDailyBreakdown: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      snapshotMonth: z.string().regex(/^\d{4}-\d{2}$/, "snapshotMonth must be YYYY-MM"),
      // debtStatuses ถูกย้ายไป filter ที่ client-side แล้ว ไม่ต้องส่งมา server
    }))
    .query(async ({ input }) => {
      return getDailyBreakdown(input.section, input.snapshotMonth);
    }),
});

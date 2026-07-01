/**
 * notice.ts — tRPC router สำหรับระบบหนังสือแจ้งเตือน (Notice)
 *
 * Phase 2:
 *  - list / summary / adminOptions (อ่าน — guard view)
 *  - recordPrint (นับรอบ) / restoreLatest (ยกเลิกรอบล่าสุด) (เขียน — guard edit)
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import {
  listNoticeContracts,
  getNoticeSummary,
  getNoticeAdminOptions,
  getNoticeMonthlyStats,
  recordNoticePrint,
  restoreLatestNoticeRound,
  clearAllNoticeData,
  type NoticeFilters,
  type NoticeSort,
} from "../noticeDb";
import { sectionSchema } from "../../shared/const";
import type { AppUserWithGroup } from "../authDb";

const filtersInput = z
  .object({
    search: z.string().optional(),
    returned: z.enum(["all", "hide", "only"]).optional(),
    sent: z.enum(["all", "0", "ever", "1", "2", "3"]).optional(),
    admin: z.string().optional(),
    approveDateFrom: z.string().optional(),
    approveDateTo: z.string().optional(),
    overdueMin: z.number().int().min(0).optional(),
    overdueMax: z.number().int().min(0).optional(),
  })
  .optional();

const sortInput = z
  .object({
    field: z.enum(["approveDate", "overdueDays", "sentCount"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
  })
  .optional();

/** ชื่อผู้ทำรายการที่จะบันทึกใน log (ใช้ fullName ถ้ามี ไม่งั้น username) */
function operatorName(appUser: AppUserWithGroup): string {
  return (appUser.fullName?.trim() || appUser.username || "ไม่ทราบชื่อ").slice(0, 128);
}

export const noticeRouter = router({
  list: requirePermission("notice", "view")
    .input(
      z.object({
        section: sectionSchema,
        filters: filtersInput,
        sort: sortInput,
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(1000).default(25),
      }),
    )
    .query(({ input }) =>
      listNoticeContracts({
        section: input.section,
        filters: input.filters as NoticeFilters | undefined,
        sort: input.sort as NoticeSort | undefined,
        page: input.page,
        pageSize: input.pageSize,
      }),
    ),

  summary: requirePermission("notice", "view")
    .input(z.object({ section: sectionSchema, filters: filtersInput }))
    .query(({ input }) =>
      getNoticeSummary({
        section: input.section,
        filters: input.filters as NoticeFilters | undefined,
      }),
    ),

  adminOptions: requirePermission("notice", "view")
    .input(z.object({ section: sectionSchema }))
    .query(({ input }) => getNoticeAdminOptions(input.section)),

  monthlyStats: requirePermission("notice", "view")
    .input(z.object({ section: sectionSchema }))
    .query(({ input }) => getNoticeMonthlyStats(input.section)),

  /**
   * บันทึกการพิมพ์ Notice (นับรอบ) ของรายการที่เลือก
   * NOTE (Phase 2): ยังไม่ได้ gate ด้วยการ generate PDF/Excel จริง — Phase 3 จะ
   * generate ไฟล์ก่อนแล้วจึงเรียก mutation นี้เมื่อสำเร็จทั้งคู่
   */
  recordPrint: requirePermission("notice", "edit")
    .input(z.object({ section: sectionSchema, externalIds: z.array(z.string()).min(1) }))
    .mutation(({ input, ctx }) =>
      recordNoticePrint({
        section: input.section,
        externalIds: input.externalIds,
        operator: operatorName(ctx.appUser),
      }),
    ),

  restoreLatest: requirePermission("notice", "edit")
    .input(
      z.object({
        section: sectionSchema,
        externalId: z.string().min(1),
        reason: z.string().optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      restoreLatestNoticeRound({
        section: input.section,
        externalId: input.externalId,
        operator: operatorName(ctx.appUser),
        reason: input.reason,
      }),
    ),

  /** ล้างข้อมูล Notice ทั้งหมดของ section (ทดสอบ — ไม่แตะสัญญา) */
  clearAll: requirePermission("notice", "edit")
    .input(z.object({ section: sectionSchema }))
    .mutation(({ input }) => clearAllNoticeData(input.section)),
});

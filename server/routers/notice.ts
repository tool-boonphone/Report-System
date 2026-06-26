/**
 * notice.ts — tRPC router สำหรับระบบหนังสือแจ้งเตือน (Notice)
 *
 * Phase 1 (อ่านอย่างเดียว):
 *  - list: ดึงรายการลูกค้าค้างชำระ ≥ 60 วัน (server-side pagination)
 *  - summary: นับยอดรวม + ยอดได้เครื่องคืนสำหรับการ์ดด้านบน
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import {
  listNoticeContracts,
  getNoticeSummary,
  type NoticeFilters,
  type NoticeSort,
} from "../noticeDb";
import { sectionSchema } from "../../shared/const";

const filtersInput = z
  .object({
    search: z.string().optional(),
    returned: z.enum(["all", "hide", "only"]).optional(),
    approveDateFrom: z.string().optional(),
    approveDateTo: z.string().optional(),
    overdueMin: z.number().int().min(0).optional(),
    overdueMax: z.number().int().min(0).optional(),
  })
  .optional();

const sortInput = z
  .object({
    field: z.enum(["approveDate", "overdueDays"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
  })
  .optional();

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
});

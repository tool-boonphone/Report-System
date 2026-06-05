/**
 * New Customer Watch router — สังเกตการณ์ลูกค้าใหม่
 * Endpoint: trpc.newCustomerWatch.list
 * Permission: new_customer_watch / view
 *
 * Clone ของ WatchGroup แต่ใช้ menuCode แยกต่างหาก
 * เพื่อให้สามารถกำหนดสิทธิ์ได้อิสระ
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { listWatchGroup } from "../debtDb";
import { sectionSchema } from "../../shared/const";

const viewProcedure = requirePermission("new_customer_watch", "view");

export const newCustomerWatchRouter = router({
  list: viewProcedure
    .input(
      z.object({
        section: sectionSchema,
        gracePeriod: z.number().int().min(0).max(365).optional(),
        arrearsFilter: z.enum(["0", "1"]).nullable().optional(),
        productTypes: z.array(z.string()).nullable().optional(),
        partnerSearch: z.string().nullable().optional(),
      })
    )
    .query(async ({ input }) => {
      // ใช้ logic เดียวกับ WatchGroup (listWatchGroup)
      return listWatchGroup(input);
    }),
});

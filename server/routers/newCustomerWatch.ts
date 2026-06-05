/**
 * New Customer Watch router — สังเกตการณ์ลูกค้าใหม่
 * Endpoint: trpc.newCustomerWatch.list
 * Permission: new_customer_watch / view
 *
 * ดึงสัญญาที่ยังไม่ถึงกำหนดชำระงวดที่ 1 ทั้งหมด
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { listNewCustomerWatch } from "../debtDb";
import { sectionSchema } from "../../shared/const";

const viewProcedure = requirePermission("new_customer_watch", "view");

export const newCustomerWatchRouter = router({
  list: viewProcedure
    .input(
      z.object({
        section: sectionSchema,
        productTypes: z.array(z.string()).nullable().optional(),
        partnerSearch: z.string().nullable().optional(),
      })
    )
    .query(async ({ input }) => {
      return listNewCustomerWatch(input);
    }),
});

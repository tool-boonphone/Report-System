/**
 * accounting.ts — tRPC router สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  listIncome,
  listIncomeUpdatedBy,
  listExpense,
  type IncomeType,
  type ExpenseType,
} from "../accountingDb";

const INCOME_TYPES: IncomeType[] = ["ค่างวด", "ขายเครื่อง", "ปิดยอด", "เงินดาวน์"];
const EXPENSE_TYPES: ExpenseType[] = ["ค่าคอมมิชชั่น"];

export const accountingRouter = router({
  /**
   * ดึง income rows พร้อม pagination และ filter
   */
  listIncome: protectedProcedure
    .input(
      z.object({
        section: z.string(),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        dateField: z.enum(["paidAt", "updatedAt"]).optional().default("paidAt"),
        incomeTypes: z.array(z.enum(["ค่างวด", "ขายเครื่อง", "ปิดยอด", "เงินดาวน์"])).optional(),
        updatedBy: z.string().optional(),
        page: z.number().int().min(1).optional().default(1),
        pageSize: z.number().int().min(1).max(1000).optional().default(50),
      }),
    )
    .query(async ({ input }) => {
      const { section, search, dateFrom, dateTo, dateField, incomeTypes, updatedBy, page, pageSize } = input;
      // Validate section
      if (section !== "Boonphone" && section !== "Fastfone365") {
        return { rows: [], total: 0 };
      }
      return listIncome({
        section,
        search,
        dateFrom,
        dateTo,
        dateField,
        incomeTypes: incomeTypes as IncomeType[] | undefined,
        updatedBy,
        page,
        pageSize,
      });
    }),

  /**
   * ดึง distinct updatedBy สำหรับ income filter dropdown
   */
  listIncomeUpdatedBy: protectedProcedure
    .input(z.object({ section: z.string() }))
    .query(async ({ input }) => {
      if (input.section !== "Boonphone" && input.section !== "Fastfone365") return [];
      return listIncomeUpdatedBy(input.section as "Boonphone" | "Fastfone365");
    }),

  /**
   * ดึง expense rows พร้อม pagination และ filter
   */
  listExpense: protectedProcedure
    .input(
      z.object({
        section: z.string(),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        expenseTypes: z.array(z.enum(["ค่าคอมมิชชั่น"])).optional(),
        page: z.number().int().min(1).optional().default(1),
        pageSize: z.number().int().min(1).max(1000).optional().default(50),
      }),
    )
    .query(async ({ input }) => {
      const { section, search, dateFrom, dateTo, expenseTypes, page, pageSize } = input;
      if (section !== "Boonphone" && section !== "Fastfone365") {
        return { rows: [], total: 0 };
      }
      return listExpense({
        section,
        search,
        dateFrom,
        dateTo,
        expenseTypes: expenseTypes as ExpenseType[] | undefined,
        page,
        pageSize,
      });
    }),
});

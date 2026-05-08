/**
 * accounting.ts — tRPC router สำหรับหน้าบัญชี (รายรับ + รายจ่าย)
 */

import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import {
  listIncome,
  listIncomeUpdatedBy,
  listExpense,
  getIncomeSummary,
  getExpenseSummary,
  type IncomeType,
  type ExpenseType,
} from "../accountingDb";
import { getDb } from "../db";

// "เงินดาวน์" ซ่อนไว้ก่อน — ไม่มีในข้อมูลจริง
const INCOME_TYPES: IncomeType[] = ["ค่างวด", "ขายเครื่อง", "ปิดยอด"];
const EXPENSE_TYPES: ExpenseType[] = ["ค่าคอมมิชชั่น"];

const incomeFilterInput = z.object({
  section: z.string(),
  search: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  dateField: z.enum(["paidAt", "updatedAt"]).optional().default("paidAt"),
  // "เงินดาวน์" ซ่อนไว้ก่อน
  incomeTypes: z.array(z.enum(["ค่างวด", "ขายเครื่อง", "ปิดยอด"])).optional(),
  updatedBy: z.string().optional(),
});

const expenseFilterInput = z.object({
  section: z.string(),
  search: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  expenseTypes: z.array(z.enum(["ค่าคอมมิชชั่น"])).optional(),
  updatedBy: z.string().optional(),
});

export const accountingRouter = router({
  /**
   * ดึง income rows พร้อม pagination และ filter
   */
  listIncome: protectedProcedure
    .input(
      incomeFilterInput.extend({
        page: z.number().int().min(1).optional().default(1),
        pageSize: z.number().int().min(1).max(1000).optional().default(50),
      }),
    )
    .query(async ({ input }) => {
      const { section, search, dateFrom, dateTo, dateField, incomeTypes, updatedBy, page, pageSize } = input;
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
   * คำนวณ SUM badge ของ income แยกตามประเภท (ไม่ดึง rows ทั้งหมด)
   */
  getIncomeSummary: protectedProcedure
    .input(incomeFilterInput)
    .query(async ({ input }) => {
      const { section, search, dateFrom, dateTo, dateField, incomeTypes, updatedBy } = input;
      if (section !== "Boonphone" && section !== "Fastfone365") {
        return { "ค่างวด": 0, "ขายเครื่อง": 0, "ปิดยอด": 0, "เงินดาวน์": 0, total: 0 };
      }
      return getIncomeSummary({
        section,
        search,
        dateFrom,
        dateTo,
        dateField,
        incomeTypes: incomeTypes as IncomeType[] | undefined,
        updatedBy,
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
      expenseFilterInput.extend({
        page: z.number().int().min(1).optional().default(1),
        pageSize: z.number().int().min(1).max(1000).optional().default(50),
      }),
    )
    .query(async ({ input }) => {
      const { section, search, dateFrom, dateTo, expenseTypes, updatedBy, page, pageSize } = input;
      if (section !== "Boonphone" && section !== "Fastfone365") {
        return { rows: [], total: 0 };
      }
      return listExpense({
        section,
        search,
        dateFrom,
        dateTo,
        expenseTypes: expenseTypes as ExpenseType[] | undefined,
        updatedBy,
        page,
        pageSize,
      });
    }),

  /**
   * คำนวณ SUM badge ของ expense แยกตามประเภท
   */
  getExpenseSummary: protectedProcedure
    .input(expenseFilterInput)
    .query(async ({ input }) => {
      const { section, search, dateFrom, dateTo } = input;
      if (section !== "Boonphone" && section !== "Fastfone365") {
        return { "ค่าคอมมิชชั่น": 0, total: 0 };
      }
      return getExpenseSummary({ section, search, dateFrom, dateTo });
    }),

  /**
   * ดึง distinct updatedBy สำหรับ expense filter dropdown
   */
  listExpenseUpdatedBy: protectedProcedure
    .input(z.object({ section: z.string() }))
    .query(async ({ input }) => {
      if (input.section !== "Boonphone" && input.section !== "Fastfone365") return [];
      const db = await getDb();
      if (!db) return [];
      const esc = (v: string) => v.replace(/'/g, "''");
      const result = await db.execute(
        sql.raw(`
          SELECT DISTINCT i.updated_by
          FROM installments i
          INNER JOIN contracts c ON c.contract_no = i.contract_no AND c.section = i.section
          WHERE i.section = '${esc(input.section)}'
            AND i.updated_by IS NOT NULL AND i.updated_by != ''
            AND c.commission_net IS NOT NULL AND c.commission_net > 0
          ORDER BY i.updated_by ASC
        `),
      );
      const arr: any[] = (result as any)[0] ?? result;
      return (arr ?? []).map((r: any) => r.updated_by).filter(Boolean) as string[];
    }),
});

// Export INCOME_TYPES for use in other files
export { INCOME_TYPES, EXPENSE_TYPES };

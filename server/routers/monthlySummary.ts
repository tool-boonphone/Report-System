/**
 * Monthly Summary router.
 *
 * Return type (flat — เพื่อหลีกเลี่ยง superjson depth limit):
 *   rows: FlatRow[]
 *   productTypes: string[]
 *
 * FlatRow = {
 *   approveMonth: string
 *   bucket: string  // "ปกติ"|"เกิน 1-7"|...|"__total__"
 *   contractCount: number
 *   paidPrincipal/Interest/Fee/Penalty/UnlockFee/Discount/Overpaid/BadDebt/Total: number
 *   duePrincipal/Interest/Fee/Penalty/Total: number
 * }
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { getMonthlySummary, DEBT_BUCKETS } from "../monthlySummaryDb";
import { SECTIONS } from "../../shared/const";
import { getDb } from "../db";
import { sql } from "drizzle-orm";

const debtViewProcedure = requirePermission("debt_report", "view");
const SectionEnum = z.enum(SECTIONS);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional();
const MonthStr = z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM").optional();

export const monthlySummaryRouter = router({
  get: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        countProductType: z.string().optional(),
        paidAtFrom:      DateStr,
        paidAtTo:        DateStr,
        paidAtMonth:     MonthStr,
        paidProductType: z.string().optional(),
        dueAtFrom:       DateStr,
        dueAtTo:         DateStr,
        dueAtMonth:      MonthStr,
        dueProductType:  z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const [summaryRows, productTypesResult] = await Promise.all([
        getMonthlySummary(input),
        getDb().then(async (db) => {
          if (!db) return [] as string[];
          const r = await db.execute(sql.raw(`
            SELECT DISTINCT product_type
            FROM contracts
            WHERE section = '${input.section}'
              AND product_type IS NOT NULL
              AND product_type != ''
            ORDER BY product_type
          `));
          const rows: any[] = (r as any)[0] ?? [];
          return rows.map((x: any) => String(x.product_type ?? "")).filter(Boolean);
        }),
      ]);

      // Flatten nested MonthlySummaryRow[] → flat rows เพื่อหลีกเลี่ยง superjson depth limit
      const flatRows: {
        approveMonth: string;
        bucket: string;
        contractCount: number;
        paidPrincipal: number; paidInterest: number; paidFee: number; paidPenalty: number;
        paidUnlockFee: number; paidDiscount: number; paidOverpaid: number; paidBadDebt: number; paidTotal: number;
        duePrincipal: number; dueInterest: number; dueFee: number; duePenalty: number; dueTotal: number;
      }[] = [];

      for (const row of summaryRows) {
        for (const bucket of DEBT_BUCKETS) {
          const cell = row.buckets[bucket];
          if (!cell) continue;
          flatRows.push({
            approveMonth: row.approveMonth,
            bucket,
            contractCount: cell.contractCount,
            paidPrincipal: cell.paid.principal,
            paidInterest: cell.paid.interest,
            paidFee: cell.paid.fee,
            paidPenalty: cell.paid.penalty,
            paidUnlockFee: cell.paid.unlockFee,
            paidDiscount: cell.paid.discount,
            paidOverpaid: cell.paid.overpaid,
            paidBadDebt: cell.paid.badDebt,
            paidTotal: cell.paid.total,
            duePrincipal: cell.due.principal,
            dueInterest: cell.due.interest,
            dueFee: cell.due.fee,
            duePenalty: cell.due.penalty,
            dueTotal: cell.due.total,
          });
        }
        // "__total__" row สำหรับแต่ละเดือน
        flatRows.push({
          approveMonth: row.approveMonth,
          bucket: "__total__",
          contractCount: row.totalCount,
          paidPrincipal: row.totalPaid.principal,
          paidInterest: row.totalPaid.interest,
          paidFee: row.totalPaid.fee,
          paidPenalty: row.totalPaid.penalty,
          paidUnlockFee: row.totalPaid.unlockFee,
          paidDiscount: row.totalPaid.discount,
          paidOverpaid: row.totalPaid.overpaid,
          paidBadDebt: row.totalPaid.badDebt,
          paidTotal: row.totalPaid.total,
          duePrincipal: row.totalDue.principal,
          dueInterest: row.totalDue.interest,
          dueFee: row.totalDue.fee,
          duePenalty: row.totalDue.penalty,
          dueTotal: row.totalDue.total,
        });
      }

      // ส่ง data เป็น JSON string เพื่อ bypass superjson depth limit
      // client จะ JSON.parse เอง
      return {
        rowsJson: JSON.stringify(flatRows),
        productTypes: productTypesResult,
      };
    }),
});

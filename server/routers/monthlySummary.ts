/**
 * Monthly Summary router (Phase 128).
 *
 * Return type (flat — เพื่อหลีกเลี่ยง superjson depth limit):
 *   rowsJson: string  (JSON.stringify of FlatRow[])
 *   productTypes: string[]
 *
 * FlatRow = {
 *   approveMonth: string
 *   bucket: string  // "ปกติ"|"เกิน 1-7"|...|"__total__"
 *   contractCount: number
 *   paidPrincipal/Interest/Fee/Penalty/UnlockFee/Discount/Overpaid/BadDebt/BadDebtInstallment/Total: number
 *   duePrincipal/Interest/Fee/Penalty/UnlockFee/Total: number
 *   targetPrincipal/Interest/Fee/Penalty/UnlockFee/Total: number
 *   notYetDuePrincipal/Interest/Fee/Penalty/UnlockFee/Total: number
 *   installTotalPrincipal/Interest/Fee/Total: number  (ยอดหนี้รวม = net_amount ทุกงวด)
 * }
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { getMonthlySummary, DEBT_BUCKETS, getDueMonthSummary, getDueMonthSummaryFromCache } from "../monthlySummaryDb";
import { sectionSchema } from "../../shared/const";
import { getDb } from "../db";
import { sql } from "drizzle-orm";
import { pgRows } from "../db";

const debtViewProcedure = requirePermission("debt_report", "view");
const SectionEnum = sectionSchema;
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional();
const MonthStr = z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM");
const DeviceFamily = z.enum(["iOS", "Android"]).optional();

export const monthlySummaryRouter = router({
  get: debtViewProcedure
    .input(
      z.object({
        section: SectionEnum,
        // Tab 1: จำนวนสัญญา
        countApproveDate:       DateStr,
        countApproveMonths:     z.array(MonthStr).optional(),
        countProductType:       z.string().optional(),
        countDeviceFamily:      DeviceFamily,
        // Tab 2: เป้าเก็บหนี้ (เดิม: ยอดที่ต้องชำระ)
        targetDueDate:          DateStr,
        targetDueMonths:        z.array(MonthStr).optional(),
        targetApproveMonths:    z.array(MonthStr).optional(),
        targetProductType:      z.string().optional(),
        targetDeviceFamily:     DeviceFamily,
        // Tab 3: ยอดชำระแล้ว
        paidAtDate:             DateStr,
        paidAtMonths:           z.array(MonthStr).optional(),
        paidProductType:        z.string().optional(),
        paidDeviceFamily:       DeviceFamily,
        // Tab 4: หนี้ค้างชำระ (เดิม: ยอดค้างชำระ)
        dueAtDate:              DateStr,
        dueAtMonths:            z.array(MonthStr).optional(),
        dueProductType:         z.string().optional(),
        dueDeviceFamily:        DeviceFamily,
        // Tab 5: ยังไม่ถึงกำหนด (เดิม: ยอดที่ยังไม่ถึงกำหนด)
        notYetDueDueDate:       DateStr,
        notYetDueDueMonths:     z.array(MonthStr).optional(),
        notYetDueApproveMonths: z.array(MonthStr).optional(),
        notYetDueProductType:   z.string().optional(),
        notYetDueDeviceFamily:  DeviceFamily,
        // Tab 6: ยอดหนี้รวม (installTotal)
        installTotalApproveMonths: z.array(MonthStr).optional(),
        installTotalProductType:   z.string().optional(),
        installTotalDeviceFamily:  DeviceFamily,
        // Global search
        search: z.string().max(100).optional(),
      }),
    )
    .query(async ({ input }) => {
      const [summaryRows, productTypesResult] = await Promise.all([
        getMonthlySummary(input),
        getDb(input.section).then(async (db) => {
          if (!db) return [] as string[];
          const r = await db.execute(sql.raw(`
            SELECT DISTINCT product_type
            FROM contracts
            WHERE section = '${input.section}'
              AND product_type IS NOT NULL
              AND product_type != ''
            ORDER BY product_type
          `));
          const rows: any[] = pgRows(r);
          return rows.map((x: any) => String(x.product_type ?? "")).filter(Boolean);
        }),
      ]);

      // Flatten nested MonthlySummaryRow[] → flat rows
      const flatRows: {
        approveMonth: string;
        bucket: string;
        contractCount: number;
        // paid
        paidPrincipal: number; paidInterest: number; paidFee: number; paidPenalty: number;
        paidUnlockFee: number; paidDiscount: number; paidOverpaid: number;
        paidBadDebt: number; paidBadDebtInstallment: number; paidTotal: number;
        // due (หนี้ค้างชำระ) — รวม unlockFee จากงวดล่าสุด
        duePrincipal: number; dueInterest: number; dueFee: number;
        duePenalty: number; dueUnlockFee: number; dueTotal: number;
        // target (เป้าเก็บหนี้)
        targetPrincipal: number; targetInterest: number; targetFee: number;
        targetPenalty: number; targetUnlockFee: number; targetTotal: number;
        // notYetDue (ยังไม่ถึงกำหนด)
        notYetDuePrincipal: number; notYetDueInterest: number; notYetDueFee: number;
        notYetDuePenalty: number; notYetDueUnlockFee: number; notYetDueTotal: number;
        // installTotal (ยอดหนี้รวม = net_amount ทุกงวด)
        installTotalPrincipal: number; installTotalInterest: number; installTotalFee: number; installTotalTotal: number;
      }[] = [];

      for (const row of summaryRows) {
        for (const bucket of DEBT_BUCKETS) {
          const cell = row.buckets[bucket];
          if (!cell) continue;
          flatRows.push({
            approveMonth: row.approveMonth,
            bucket,
            contractCount: cell.contractCount,
            // paid
            paidPrincipal:          cell.paid.principal,
            paidInterest:           cell.paid.interest,
            paidFee:                cell.paid.fee,
            paidPenalty:            cell.paid.penalty,
            paidUnlockFee:          cell.paid.unlockFee,
            paidDiscount:           cell.paid.discount,
            paidOverpaid:           cell.paid.overpaid,
            paidBadDebt:            cell.paid.badDebt,
            paidBadDebtInstallment: cell.paid.badDebtInstallment,
            paidTotal:              cell.paid.total,
            // due
            duePrincipal:           cell.due.principal,
            dueInterest:            cell.due.interest,
            dueFee:                 cell.due.fee,
            duePenalty:             cell.due.penalty,
            dueUnlockFee:           cell.due.unlockFee,
            dueTotal:               cell.due.total,
            // target
            targetPrincipal:        cell.target.principal,
            targetInterest:         cell.target.interest,
            targetFee:              cell.target.fee,
            targetPenalty:          cell.target.penalty,
            targetUnlockFee:        cell.target.unlockFee,
            targetTotal:            cell.target.total,
            // notYetDue
            notYetDuePrincipal:     cell.notYetDue.principal,
            notYetDueInterest:      cell.notYetDue.interest,
            notYetDueFee:           cell.notYetDue.fee,
            notYetDuePenalty:       cell.notYetDue.penalty,
            notYetDueUnlockFee:     cell.notYetDue.unlockFee,
            notYetDueTotal:         cell.notYetDue.total,
            // installTotal
            installTotalPrincipal:  cell.installTotal.principal,
            installTotalInterest:   cell.installTotal.interest,
            installTotalFee:        cell.installTotal.fee,
            installTotalTotal:      cell.installTotal.total,
          });
        }
        // "__total__" row สำหรับแต่ละเดือน
        flatRows.push({
          approveMonth: row.approveMonth,
          bucket: "__total__",
          contractCount: row.totalCount,
          // paid
          paidPrincipal:          row.totalPaid.principal,
          paidInterest:           row.totalPaid.interest,
          paidFee:                row.totalPaid.fee,
          paidPenalty:            row.totalPaid.penalty,
          paidUnlockFee:          row.totalPaid.unlockFee,
          paidDiscount:           row.totalPaid.discount,
          paidOverpaid:           row.totalPaid.overpaid,
          paidBadDebt:            row.totalPaid.badDebt,
          paidBadDebtInstallment: row.totalPaid.badDebtInstallment,
          paidTotal:              row.totalPaid.total,
          // due
          duePrincipal:           row.totalDue.principal,
          dueInterest:            row.totalDue.interest,
          dueFee:                 row.totalDue.fee,
          duePenalty:             row.totalDue.penalty,
          dueUnlockFee:           row.totalDue.unlockFee,
          dueTotal:               row.totalDue.total,
          // target
          targetPrincipal:        row.totalTarget.principal,
          targetInterest:         row.totalTarget.interest,
          targetFee:              row.totalTarget.fee,
          targetPenalty:          row.totalTarget.penalty,
          targetUnlockFee:        row.totalTarget.unlockFee,
          targetTotal:            row.totalTarget.total,
          // notYetDue
          notYetDuePrincipal:     row.totalNotYetDue.principal,
          notYetDueInterest:      row.totalNotYetDue.interest,
          notYetDueFee:           row.totalNotYetDue.fee,
          notYetDuePenalty:       row.totalNotYetDue.penalty,
          notYetDueUnlockFee:     row.totalNotYetDue.unlockFee,
          notYetDueTotal:         row.totalNotYetDue.total,
          // installTotal
          installTotalPrincipal:  row.totalInstallTotal.principal,
          installTotalInterest:   row.totalInstallTotal.interest,
          installTotalFee:        row.totalInstallTotal.fee,
          installTotalTotal:      row.totalInstallTotal.total,
        });
      }

      return {
        rowsJson: JSON.stringify(flatRows),
        productTypes: productTypesResult,
      };
    }),

  /**
   * getDueMonthSummary — Mode "เดือนที่ต้องชำระ"
   * Return flat rows: approveMonth × dueMonth
   */
  getDueMonthSummary: debtViewProcedure
    .input(z.object({
      section: SectionEnum,
      approveMonths: z.array(MonthStr).optional(),
      productType: z.string().optional(),
      deviceFamily: z.enum(["iOS", "Android"]).optional(),
    }))
    .query(async ({ input }) => {
      // ใช้ Cache ก่อน ถ้า Cache ว่างค่อย fallback ไป Direct Query
      let summaryRows: Awaited<ReturnType<typeof getDueMonthSummary>>;
      let allDueMonths: string[];

      const cached = await getDueMonthSummaryFromCache({
        section: input.section,
        approveMonths: input.approveMonths,
        productType: input.productType,
        deviceFamily: input.deviceFamily,
      });

      if (cached.rows.length > 0) {
        summaryRows = cached.rows;
        allDueMonths = cached.allDueMonths;
      } else {
        // Fallback: Direct Query (ก่อน Cache ถูก Populate)
        summaryRows = await getDueMonthSummary({
          section: input.section,
          approveMonths: input.approveMonths,
          productType: input.productType,
          deviceFamily: input.deviceFamily,
        });
        const dueMonthSet = new Set<string>();
        for (const row of summaryRows) {
          for (const dm of Object.keys(row.dueMonths)) dueMonthSet.add(dm);
        }
        allDueMonths = Array.from(dueMonthSet).sort((a, b) => a.localeCompare(b));
      }

      // Flatten to array of flat rows for JSON transport
      type FlatDueMonthRow = {
        approveMonth: string;
        dueMonth: string; // "__total__" for row totals
        contractCount: number;
        paidTotal: number; paidPrincipal: number; paidInterest: number; paidFee: number; paidPenalty: number; paidUnlockFee: number; paidDiscount: number; paidOverpaid: number; paidBadDebt: number; paidBadDebtInstallment: number;
        targetTotal: number; targetPrincipal: number; targetInterest: number; targetFee: number; targetPenalty: number; targetUnlockFee: number;
        dueTotal: number; duePrincipal: number; dueInterest: number; dueFee: number; duePenalty: number; dueUnlockFee: number;
        notYetDueTotal: number; notYetDuePrincipal: number; notYetDueInterest: number; notYetDueFee: number; notYetDuePenalty: number; notYetDueUnlockFee: number;
        installTotalTotal: number; installTotalPrincipal: number; installTotalInterest: number; installTotalFee: number;
      };
      const flatRows: FlatDueMonthRow[] = [];

      for (const row of summaryRows) {
        for (const dueMonth of allDueMonths) {
          const cell = row.dueMonths[dueMonth];
          if (!cell) continue;
          flatRows.push({
            approveMonth: row.approveMonth,
            dueMonth,
            contractCount: cell.contractCount,
            paidTotal: cell.paid.total, paidPrincipal: cell.paid.principal, paidInterest: cell.paid.interest, paidFee: cell.paid.fee, paidPenalty: cell.paid.penalty, paidUnlockFee: cell.paid.unlockFee, paidDiscount: cell.paid.discount, paidOverpaid: cell.paid.overpaid, paidBadDebt: cell.paid.badDebt, paidBadDebtInstallment: cell.paid.badDebtInstallment,
            targetTotal: cell.target.total, targetPrincipal: cell.target.principal, targetInterest: cell.target.interest, targetFee: cell.target.fee, targetPenalty: cell.target.penalty, targetUnlockFee: cell.target.unlockFee,
            dueTotal: cell.due.total, duePrincipal: cell.due.principal, dueInterest: cell.due.interest, dueFee: cell.due.fee, duePenalty: cell.due.penalty, dueUnlockFee: cell.due.unlockFee,
            notYetDueTotal: cell.notYetDue.total, notYetDuePrincipal: cell.notYetDue.principal, notYetDueInterest: cell.notYetDue.interest, notYetDueFee: cell.notYetDue.fee, notYetDuePenalty: cell.notYetDue.penalty, notYetDueUnlockFee: cell.notYetDue.unlockFee,
            installTotalTotal: cell.installTotal.total, installTotalPrincipal: cell.installTotal.principal, installTotalInterest: cell.installTotal.interest, installTotalFee: cell.installTotal.fee,
          });
        }
        // __total__ row
        flatRows.push({
          approveMonth: row.approveMonth,
          dueMonth: "__total__",
          contractCount: row.totalCount,
          paidTotal: row.totalPaid.total, paidPrincipal: row.totalPaid.principal, paidInterest: row.totalPaid.interest, paidFee: row.totalPaid.fee, paidPenalty: row.totalPaid.penalty, paidUnlockFee: row.totalPaid.unlockFee, paidDiscount: row.totalPaid.discount, paidOverpaid: row.totalPaid.overpaid, paidBadDebt: row.totalPaid.badDebt, paidBadDebtInstallment: row.totalPaid.badDebtInstallment,
          targetTotal: row.totalTarget.total, targetPrincipal: row.totalTarget.principal, targetInterest: row.totalTarget.interest, targetFee: row.totalTarget.fee, targetPenalty: row.totalTarget.penalty, targetUnlockFee: row.totalTarget.unlockFee,
          dueTotal: row.totalDue.total, duePrincipal: row.totalDue.principal, dueInterest: row.totalDue.interest, dueFee: row.totalDue.fee, duePenalty: row.totalDue.penalty, dueUnlockFee: row.totalDue.unlockFee,
          notYetDueTotal: row.totalNotYetDue.total, notYetDuePrincipal: row.totalNotYetDue.principal, notYetDueInterest: row.totalNotYetDue.interest, notYetDueFee: row.totalNotYetDue.fee, notYetDuePenalty: row.totalNotYetDue.penalty, notYetDueUnlockFee: row.totalNotYetDue.unlockFee,
          installTotalTotal: row.totalInstallTotal.total, installTotalPrincipal: row.totalInstallTotal.principal, installTotalInterest: row.totalInstallTotal.interest, installTotalFee: row.totalInstallTotal.fee,
        });
      }

      return {
        rowsJson: JSON.stringify(flatRows),
        allDueMonths,
      };
    }),
});

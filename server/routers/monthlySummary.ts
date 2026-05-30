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
import { getMonthlySummary, DEBT_BUCKETS, getDueMonthSummary, getDueMonthSummaryFromCache, getMonthlySummaryTotalsOnly } from "../monthlySummaryDb";
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
      const [summaryRows, productTypesResult, totalsRows] = await Promise.all([
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
        // คอลัมน์รวมที่ถูกต้อง — ใช้ filter เดียวกับแต่ละ tab
        getMonthlySummaryTotalsOnly(input.section, {
          section: input.section,
          // count
          countApproveDate:    input.countApproveDate,
          countApproveMonths:  input.countApproveMonths,
          countProductType:    input.countProductType,
          countDeviceFamily:   input.countDeviceFamily,
          // target
          targetDueDate:       input.targetDueDate,
          targetDueMonths:     input.targetDueMonths,
          targetApproveMonths: input.targetApproveMonths,
          targetProductType:   input.targetProductType,
          targetDeviceFamily:  input.targetDeviceFamily,
          // paid
          paidAtDate:          input.paidAtDate,
          paidAtMonths:        input.paidAtMonths,
          paidProductType:     input.paidProductType,
          paidDeviceFamily:    input.paidDeviceFamily,
          // due
          dueAtDate:           input.dueAtDate,
          dueAtMonths:         input.dueAtMonths,
          dueProductType:      input.dueProductType,
          dueDeviceFamily:     input.dueDeviceFamily,
          // notYetDue
          notYetDueDueDate:    input.notYetDueDueDate,
          notYetDueDueMonths:  input.notYetDueDueMonths,
          notYetDueApproveMonths: input.notYetDueApproveMonths,
          notYetDueProductType: input.notYetDueProductType,
          notYetDueDeviceFamily: input.notYetDueDeviceFamily,
          // installTotal
          installTotalApproveMonths: input.installTotalApproveMonths,
          installTotalProductType:   input.installTotalProductType,
          installTotalDeviceFamily:  input.installTotalDeviceFamily,
          // search
          search: input.search || undefined,
        }),
      ]);

      // totalsRows = grand total single object (ไม่แยก approve_month)
      const gt = totalsRows;

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
        // financeTotal (ยอดจัดฯ)
        financeTotal: number;
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
            // financeTotal
            financeTotal:           cell.financeTotal ?? 0,
          });
        }
        // "__total__" row — contractCount/financeTotal/installTotal/target ใช้ค่าจาก row (per-approveMonth)
        // paid/due/notYetDue ใช้ grand total (getMonthlySummaryTotalsOnly) เพื่อความถูกต้อง
        const t = gt;
        flatRows.push({
          approveMonth: row.approveMonth,
          bucket: "__total__",
          contractCount:          row.totalCount,
          // paid — ใช้ค่าจาก row (per-approveMonth) เพื่อให้ badge toggle ทำงานถูกต้อง
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
          // due — ใช้ค่าจาก row (per-approveMonth)
          duePrincipal:           row.totalDue.principal,
          dueInterest:            row.totalDue.interest,
          dueFee:                 row.totalDue.fee,
          duePenalty:             row.totalDue.penalty,
          dueUnlockFee:           row.totalDue.unlockFee,
          dueTotal:               row.totalDue.total,
          // target — ใช้ค่าจาก row (per-approveMonth) เพื่อให้ตรงกับแต่ละเดือน
          targetPrincipal:        row.totalTarget.principal,
          targetInterest:         row.totalTarget.interest,
          targetFee:              row.totalTarget.fee,
          targetPenalty:          row.totalTarget.penalty,
          targetUnlockFee:        row.totalTarget.unlockFee,
          targetTotal:            row.totalTarget.total,
          // notYetDue — ใช้ค่าจาก row (per-approveMonth)
          notYetDuePrincipal:     row.totalNotYetDue.principal,
          notYetDueInterest:      row.totalNotYetDue.interest,
          notYetDueFee:           row.totalNotYetDue.fee,
          notYetDuePenalty:       row.totalNotYetDue.penalty,
          notYetDueUnlockFee:     row.totalNotYetDue.unlockFee,
          notYetDueTotal:         row.totalNotYetDue.total,
          // installTotal — ส่ง breakdown เพื่อ badge toggle
          installTotalPrincipal:  row.totalInstallTotal.principal,
          installTotalInterest:   row.totalInstallTotal.interest,
          installTotalFee:        row.totalInstallTotal.fee,
          installTotalTotal:      row.totalInstallTotal.total,
          // financeTotal — ใช้ค่าจาก row (per-approveMonth)
          financeTotal:           row.totalFinanceTotal ?? 0,
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
      search: z.string().max(100).optional(),
    }))
    .query(async ({ input }) => {
      // Fast path: ลอง cache ก่อน → ถ้า cache ว่าง fallback ไป direct query
      const params = {
        section: input.section,
        approveMonths: input.approveMonths,
        productType: input.productType,
        deviceFamily: input.deviceFamily,
        search: input.search || undefined,
      };
      // ดึง totals ที่ถูกต้อง (group by approve_date) พร้อมกัน
      const [cacheResult, totalsRows] = await Promise.all([
        getDueMonthSummaryFromCache(params),
        getMonthlySummaryTotalsOnly(input.section, {
          section: input.section,
          // ใน DueMonthSummary ไม่มี per-tab filter — ใช้ productType/deviceFamily/approveMonths ร่วมกัน
          countProductType:    input.productType,
          countDeviceFamily:   input.deviceFamily,
          countApproveMonths:  input.approveMonths,
          targetProductType:   input.productType,
          targetDeviceFamily:  input.deviceFamily,
          paidProductType:     input.productType,
          paidDeviceFamily:    input.deviceFamily,
          dueProductType:      input.productType,
          dueDeviceFamily:     input.deviceFamily,
          notYetDueProductType:  input.productType,
          notYetDueDeviceFamily: input.deviceFamily,
          installTotalProductType:  input.productType,
          installTotalDeviceFamily: input.deviceFamily,
          installTotalApproveMonths: input.approveMonths,
          search: input.search || undefined,
        }),
      ]);
      // totalsRows = grand total single object (ไม่แยก approve_month)
      const gt = totalsRows;

      let summaryRows = cacheResult.rows;
      let allDueMonths = cacheResult.allDueMonths;
      const usedCache = summaryRows.length > 0;
      if (summaryRows.length === 0) {
        // Cache ยังไม่พร้อม — fallback ไป direct query
        console.log(`[getDueMonthSummary] FALLBACK to direct query — section=${params.section} pt=${params.productType??'null'} df=${params.deviceFamily??'null'}`);
        summaryRows = await getDueMonthSummary(params);
        const dueMonthSet = new Set<string>();
        for (const row of summaryRows) {
          for (const dm of Object.keys(row.dueMonths)) dueMonthSet.add(dm);
        }
        allDueMonths = Array.from(dueMonthSet).sort((a, b) => a.localeCompare(b));
      } else {
        console.log(`[getDueMonthSummary] CACHE HIT — section=${params.section} rows=${summaryRows.length} pt=${params.productType??'null'} df=${params.deviceFamily??'null'}`);
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
        financeTotal: number; // ยอดจัดฯ
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
            financeTotal: cell.financeTotal ?? 0,
          });
        }
        // __total__ row — ใช้ grand total (getMonthlySummaryTotalsOnly) เพื่อความถูกต้อง
        const t = gt;
        flatRows.push({
          approveMonth: row.approveMonth,
          dueMonth: "__total__",
          contractCount:          t?.contractCount  ?? row.approvedCount,
          paidTotal:              t?.paidTotal              ?? row.totalPaid.total,
          paidPrincipal:          t?.paidPrincipal          ?? 0,
          paidInterest:           t?.paidInterest           ?? 0,
          paidFee:                t?.paidFee                ?? 0,
          paidPenalty:            t?.paidPenalty            ?? 0,
          paidUnlockFee:          t?.paidUnlockFee          ?? 0,
          paidDiscount:           t?.paidDiscount           ?? 0,
          paidOverpaid:           t?.paidOverpaid           ?? 0,
          paidBadDebt:            t?.paidBadDebt            ?? 0,
          paidBadDebtInstallment: t?.paidBadDebtInstallment ?? 0,
          targetTotal:            t?.targetTotal    ?? row.totalTarget.total,
          targetPrincipal:        t?.targetPrincipal ?? 0,
          targetInterest:         t?.targetInterest  ?? 0,
          targetFee:              t?.targetFee       ?? 0,
          targetPenalty:          t?.targetPenalty   ?? 0,
          targetUnlockFee:        t?.targetUnlockFee ?? 0,
          dueTotal:               t?.dueTotal        ?? row.totalDue.total,
          duePrincipal:           t?.duePrincipal    ?? 0,
          dueInterest:            t?.dueInterest     ?? 0,
          dueFee:                 t?.dueFee          ?? 0,
          duePenalty:             t?.duePenalty      ?? 0,
          dueUnlockFee:           t?.dueUnlockFee    ?? 0,
          notYetDueTotal:         t?.notYetDueTotal  ?? row.totalNotYetDue.total,
          notYetDuePrincipal:     t?.notYetDuePrincipal ?? 0,
          notYetDueInterest:      t?.notYetDueInterest  ?? 0,
          notYetDueFee:           t?.notYetDueFee        ?? 0,
          notYetDuePenalty:       t?.notYetDuePenalty    ?? 0,
          notYetDueUnlockFee:     t?.notYetDueUnlockFee  ?? 0,
          installTotalTotal:      t?.installTotal    ?? row.totalInstallTotal.total,
          installTotalPrincipal:  t?.installPrincipal ?? 0,
          installTotalInterest:   t?.installInterest  ?? 0,
          installTotalFee:        t?.installFee       ?? 0,
          financeTotal:           t?.financeTotal    ?? row.totalFinanceTotal ?? 0,
        });
      }

      // Debug: log totalFinanceTotal per approveMonth
      const financeSummary = summaryRows.map((r) => `${r.approveMonth}=${r.totalFinanceTotal?.toFixed(0)}`);
      console.log(`[getDueMonthSummary] source=${usedCache?'cache':'direct'} financeTotal=[${financeSummary.join(',')}]`);

      return {
        rowsJson: JSON.stringify(flatRows),
        allDueMonths,
      };
    }),
});

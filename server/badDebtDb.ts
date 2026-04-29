/**
 * Bad Debt Summary helpers (Phase 97).
 *
 * สรุปกำไร/ขาดทุนจากหนี้เสีย:
 *   - ดึงสัญญาที่มีสถานะ "หนี้เสีย" (Fastfone365) หรือ "ระงับสัญญา" (Boonphone)
 *   - แยก: ยอดเก็บค่างวด (installmentPaid) vs ยอดขายเครื่อง (deviceSaleAmount)
 *   - ต้นทุน = (ยอดจัดไฟแนนซ์ × ตัวคูณ) + ค่าคอมมิชชั่น
 *   - รวมรายรับ = ยอดเก็บค่างวด + ยอดขายเครื่อง
 *   - กำไร/ขาดทุน = รวมรายรับ - ต้นทุน
 *   - ยอดเก็บค่างวด = totalPaid - deviceSaleAmount (ไม่รวมยอดสุดท้าย)
 */
import { sql } from "drizzle-orm";
import { contracts, paymentTransactions } from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

export type BadDebtRow = {
  contractExternalId: string;
  contractNo: string | null;
  customerName: string | null;
  phone: string | null;
  approveDate: string | null;
  productType: string | null;
  /** รุ่นสินค้า — ดึงจาก column model โดยตรง */
  model: string | null;
  /** ราคาขาย (sale_price) */
  salePrice: number | null;
  /** ยอดจัดไฟแนนซ์ */
  financeAmount: number;
  /** ตัวคูณ (multiplier) */
  multiplier: number | null;
  /** ค่าคอมมิชชั่น */
  commissionNet: number;
  /** ยอดเก็บค่างวดปกติ (ไม่รวมยอดขายเครื่อง) */
  installmentPaid: number;
  /** ยอดขายเครื่อง (bad_debt_amount จาก contracts) */
  deviceSaleAmount: number;
  /** วันที่ขายเครื่อง (bad_debt_date จาก contracts) */
  saleDate: string | null;
  /** ต้นทุน = (financeAmount * multiplier) + commissionNet */
  cost: number;
  /** รวมรายรับ = installmentPaid + deviceSaleAmount */
  totalRevenue: number;
  /** กำไร/ขาดทุน = totalRevenue - cost */
  profitLoss: number;
  /** งวดที่ชำระ */
  paidInstallments: number;
  installmentCount: number | null;
};

export type BadDebtSummary = {
  contractCount: number;
  totalSalePrice: number;
  totalFinanceAmount: number;
  totalCommissionNet: number;
  totalInstallmentPaid: number;
  totalDeviceSaleAmount: number;
  totalCost: number;
  totalProfitLoss: number;
  profitCount: number;
  lossCount: number;
  breakEvenCount: number;
};

export async function getBadDebtSummary(params: {
  section: SectionKey;
  /** Optional: filter by approve year-month YYYY-MM */
  approveMonth?: string;
  /** Optional: filter by sale date year-month YYYY-MM (วันที่ขายเครื่อง) */
  saleMonth?: string;
}): Promise<{ rows: BadDebtRow[]; summary: BadDebtSummary }> {
  const db = await getDb();
  const emptySummary: BadDebtSummary = {
    contractCount: 0,
    totalSalePrice: 0,
    totalFinanceAmount: 0,
    totalCommissionNet: 0,
    totalInstallmentPaid: 0,
    totalDeviceSaleAmount: 0,
    totalCost: 0,
    totalProfitLoss: 0,
    profitCount: 0,
    lossCount: 0,
    breakEvenCount: 0,
  };
  if (!db) return { rows: [], summary: emptySummary };

  // สถานะที่ถือว่า "หนี้เสีย" ในแต่ละ section
  const badDebtStatuses =
    params.section === "Fastfone365"
      ? ["หนี้เสีย"]
      : ["ระงับสัญญา", "หนี้เสีย"];

  const statusValues = sql.join(
    badDebtStatuses.map((s) => sql`${s}`),
    sql`, `,
  );

  // Query: contracts + aggregated payments
  const rawRows = await db.execute(sql`
    SELECT
      c.external_id                                                            AS contract_external_id,
      c.contract_no                                                            AS contract_no,
      c.customer_name                                                          AS customer_name,
      c.phone                                                                  AS phone,
      c.approve_date                                                           AS approve_date,
      c.product_type                                                           AS product_type,
      c.model                                                                  AS model,
      CAST(c.sell_price AS DECIMAL(18,2))                                      AS sale_price,
      CAST(c.finance_amount AS DECIMAL(18,2))                                  AS finance_amount,
      CAST(COALESCE(c.multiplier, 1) AS DECIMAL(6,2))                         AS multiplier,
      CAST(COALESCE(c.commission_net, 0) AS DECIMAL(18,2))                    AS commission_net,
      CAST(COALESCE(c.bad_debt_amount, 0) AS DECIMAL(18,2))                   AS bad_debt_amount,
      c.bad_debt_date                                                          AS sale_date,
      /*
       * ยอดขายเครื่อง = bad_debt_amount ที่ runner.ts บันทึกไว้แล้ว (= latest real payment)
       * ยอดเก็บค่างวด = SUM ของ real payments ทั้งหมด - bad_debt_amount
       * ใช้ bad_debt_amount จาก contracts โดยตรง (ไม่ต้องคำนวณจาก payment_transactions)
       */
      CAST(COALESCE(c.bad_debt_amount, 0) AS DECIMAL(18,2))                   AS device_sale_paid_raw,
      -- installment_paid = total real payments - device_sale (bad_debt_amount)
      GREATEST(0, COALESCE(pt_sum.total_real_paid, 0) - COALESCE(c.bad_debt_amount, 0)) AS installment_paid_raw,
      COALESCE(pt_sum.pay_cnt, 0)                                             AS paid_installments,
      c.installment_count                                                      AS installment_count
    FROM ${contracts} c
    LEFT JOIN (
    /*
     * SUM ของ real payments (external_id ไม่ขึ้นต้น 'pay-')
     * ไม่ใช้ GROUP_CONCAT ORDER BY เพราะ TiDB ไม่รองรับใน subquery ขนาดใหญ่
     */
    SELECT
      section,
      contract_external_id,
      SUM(CASE WHEN external_id NOT LIKE 'pay-%'
               THEN CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.total_paid_amount')), amount) AS DECIMAL(18,2))
               ELSE 0 END) AS total_real_paid,
      COUNT(CASE WHEN external_id NOT LIKE 'pay-%' THEN 1 END) AS pay_cnt
      FROM ${paymentTransactions}
      GROUP BY section, contract_external_id
    ) pt_sum
      ON pt_sum.contract_external_id = c.external_id
     AND pt_sum.section = c.section
    WHERE c.section = ${params.section}
      AND c.status IN (${statusValues})
    ORDER BY c.approve_date DESC, c.external_id DESC
  `);

  const rawArr: any[] = (rawRows as any)[0] ?? rawRows;

  const allRows: BadDebtRow[] = rawArr.map((r: any) => {
    const financeAmount = Number(r.finance_amount ?? 0);
    // ตัวคูณ: ถ้า null ให้ใช้ 1 เป็น default
    const multiplier = r.multiplier != null ? Number(r.multiplier) : null;
    const multiplierVal = multiplier ?? 1;
    const commissionNet = Number(r.commission_net ?? 0);
    // ยอดขายเครื่อง = latest real payment (external_id NOT LIKE 'pay-%', เรียงตาม paid_at DESC)
    const deviceSaleAmount = Number(r.device_sale_paid_raw ?? 0);
    // ยอดเก็บค่างวด = SUM ของ real payments ทั้งหมด - latest real payment
    const installmentPaid = Number(r.installment_paid_raw ?? 0);
    // ต้นทุน = (ยอดจัดไฟแนนซ์ × ตัวคูณ) + ค่าคอมมิชชั่น
    const cost = (financeAmount * multiplierVal) + commissionNet;
    // รวมรายรับ = ยอดเก็บค่างวด + ยอดขายเครื่อง
    const totalRevenue = installmentPaid + deviceSaleAmount;
    // กำไร/ขาดทุน = รวมรายรับ - ต้นทุน
    const profitLoss = totalRevenue - cost;

    return {
      contractExternalId: String(r.contract_external_id ?? ""),
      contractNo: r.contract_no ?? null,
      customerName: r.customer_name ?? null,
      phone: r.phone ?? null,
      approveDate: r.approve_date ?? null,
      productType: r.product_type ?? null,
      model: r.model ?? null,
      salePrice: r.sale_price != null ? Number(r.sale_price) : null,
      financeAmount,
      multiplier,
      commissionNet,
      installmentPaid,
      deviceSaleAmount,
      totalRevenue,
      saleDate: r.sale_date ?? null,
      cost,
      profitLoss,
      paidInstallments: Number(r.paid_installments ?? 0),
      installmentCount:
        r.installment_count != null ? Number(r.installment_count) : null,
    };
  });

  // กรอง saleMonth ถ้ามี (filter ที่ backend level)
  const rows = params.saleMonth
    ? allRows.filter((r) => (r.saleDate ?? "").startsWith(params.saleMonth!))
    : allRows;

  // Summary
  const summary: BadDebtSummary = rows.reduce<BadDebtSummary>(
    (acc, r) => ({
      contractCount: acc.contractCount + 1,
      totalSalePrice: acc.totalSalePrice + (r.salePrice ?? 0),
      totalFinanceAmount: acc.totalFinanceAmount + r.financeAmount,
      totalCommissionNet: acc.totalCommissionNet + r.commissionNet,
      totalInstallmentPaid: acc.totalInstallmentPaid + r.installmentPaid,
      totalDeviceSaleAmount: acc.totalDeviceSaleAmount + r.deviceSaleAmount,
      totalCost: acc.totalCost + r.cost,
      totalProfitLoss: acc.totalProfitLoss + r.profitLoss,
      profitCount: acc.profitCount + (r.profitLoss > 0 ? 1 : 0),
      lossCount: acc.lossCount + (r.profitLoss < 0 ? 1 : 0),
      breakEvenCount: acc.breakEvenCount + (r.profitLoss === 0 ? 1 : 0),
    }),
    { ...emptySummary },
  );

  return { rows, summary };
}

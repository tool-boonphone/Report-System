/**
 * Bad Debt Summary helpers (Phase 9k).
 *
 * สรุปกำไร/ขาดทุนจากหนี้เสีย:
 *   - ดึงสัญญาที่มีสถานะ "หนี้เสีย" (Fastfone365) หรือ "ระงับสัญญา" (Boonphone)
 *   - คำนวณ: ยอดที่เก็บได้ − ยอดจัดไฟแนนซ์ = กำไร/ขาดทุน
 *   - แสดงรายสัญญา + สรุปรวม
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
  model: string | null;
  salePrice: number | null;
  financeAmount: number;
  totalPaid: number;
  profitLoss: number; // totalPaid - financeAmount (+ = กำไร, - = ขาดทุน)
  badDebtDate: string | null; // วันที่บันทึกหนี้เสีย (last paid_at)
  installmentCount: number | null;
  paidInstallments: number;
};

export type BadDebtSummary = {
  contractCount: number;
  totalSalePrice: number;
  totalFinanceAmount: number;
  totalPaid: number;
  totalProfitLoss: number;
  profitCount: number;
  lossCount: number;
  breakEvenCount: number;
};

export async function getBadDebtSummary(params: {
  section: SectionKey;
  /** Optional: filter by approve year-month YYYY-MM */
  approveMonth?: string;
}): Promise<{ rows: BadDebtRow[]; summary: BadDebtSummary }> {
  const db = await getDb();
  const emptySummary: BadDebtSummary = {
    contractCount: 0,
    totalSalePrice: 0,
    totalFinanceAmount: 0,
    totalPaid: 0,
    totalProfitLoss: 0,
    profitCount: 0,
    lossCount: 0,
    breakEvenCount: 0,
  };
  if (!db) return { rows: [], summary: emptySummary };

  // สถานะที่ถือว่า "หนี้เสีย" ในแต่ละ section
  // Fastfone365: "หนี้เสีย" | Boonphone: "ระงับสัญญา"
  const badDebtStatuses =
    params.section === "Fastfone365"
      ? ["หนี้เสีย"]
      : ["ระงับสัญญา", "หนี้เสีย"];

  // Build parameterized IN clause using sql.join
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
      JSON_UNQUOTE(JSON_EXTRACT(c.raw_json, '$.product_type'))                AS product_type,
      JSON_UNQUOTE(JSON_EXTRACT(c.raw_json, '$.model'))                       AS model,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(c.raw_json, '$.sale_price')) AS DECIMAL(18,2)) AS sale_price,
      CAST(c.finance_amount AS DECIMAL(18,2))                                 AS finance_amount,
      COALESCE(pt_sum.total_paid, 0)                                          AS total_paid,
      COALESCE(pt_sum.pay_cnt, 0)                                             AS paid_installments,
      c.installment_count                                                      AS installment_count,
      pt_sum.last_paid_at                                                      AS bad_debt_date
    FROM ${contracts} c
    LEFT JOIN (
      SELECT
        section,
        contract_external_id,
        SUM(CAST(amount AS DECIMAL(18,2))) AS total_paid,
        COUNT(*) AS pay_cnt,
        MAX(paid_at) AS last_paid_at
      FROM ${paymentTransactions}
      GROUP BY section, contract_external_id
    ) pt_sum
      ON pt_sum.contract_external_id = c.external_id
     AND pt_sum.section = c.section
    WHERE c.section = ${params.section}
      AND c.status IN (${statusValues})
    ORDER BY c.approve_date DESC, c.external_id DESC
  `);

  // TiDB returns [rows, fields] or just rows depending on driver
  const rawArr: any[] = (rawRows as any)[0] ?? rawRows;

  const rows: BadDebtRow[] = rawArr.map((r: any) => {
    const financeAmount = Number(r.finance_amount ?? 0);
    const totalPaid = Number(r.total_paid ?? 0);
    const profitLoss = totalPaid - financeAmount;
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
      totalPaid,
      profitLoss,
      badDebtDate: r.bad_debt_date ?? null,
      installmentCount:
        r.installment_count != null ? Number(r.installment_count) : null,
      paidInstallments: Number(r.paid_installments ?? 0),
    };
  });

  // Summary
  const summary: BadDebtSummary = rows.reduce<BadDebtSummary>(
    (acc, r) => ({
      contractCount: acc.contractCount + 1,
      totalSalePrice: acc.totalSalePrice + (r.salePrice ?? 0),
      totalFinanceAmount: acc.totalFinanceAmount + r.financeAmount,
      totalPaid: acc.totalPaid + r.totalPaid,
      totalProfitLoss: acc.totalProfitLoss + r.profitLoss,
      profitCount: acc.profitCount + (r.profitLoss > 0 ? 1 : 0),
      lossCount: acc.lossCount + (r.profitLoss < 0 ? 1 : 0),
      breakEvenCount: acc.breakEvenCount + (r.profitLoss === 0 ? 1 : 0),
    }),
    { ...emptySummary },
  );

  return { rows, summary };
}

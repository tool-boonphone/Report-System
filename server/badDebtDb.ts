/**
 * Bad Debt Summary helpers — Phase 127 (rewritten to use cache tables).
 *
 * Primary source: debt_collected_cache (isBadDebtRow flag, payment breakdowns)
 * Secondary:      debt_target_cache (contract header, financeAmount, installmentCount)
 * JOIN:           contracts (phone, sell_price, commission_net, bad_debt_date — not in cache)
 *
 * สรุปกำไร/ขาดทุนจากหนี้เสีย:
 *   - ดึงสัญญาที่มีสถานะ "หนี้เสีย" (contract_status = 'หนี้เสีย' ใน debt_target_cache)
 *   - deviceSaleAmount = SUM(bad_debt) WHERE is_bad_debt_row = 1 (debt_collected_cache)
 *   - installmentPaid  = SUM(total_amount) WHERE is_bad_debt_row = 0 (debt_collected_cache)
 *   - ต้นทุน = financeAmount + commissionNet
 *   - รวมรายรับ = installmentPaid + deviceSaleAmount
 *   - กำไร/ขาดทุน = รวมรายรับ - ต้นทุน
 */
import { sql } from "drizzle-orm";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

export type BadDebtRow = {
  contractExternalId: string;
  contractNo: string | null;
  customerName: string | null;
  phone: string | null;
  approveDate: string | null;
  productType: string | null;
  /** รุ่นสินค้า */
  model: string | null;
  /** ราคาขาย (sell_price) */
  salePrice: number | null;
  /** ยอดจัดไฟแนนซ์ */
  financeAmount: number;
  /** ค่าคอมมิชชั่น */
  commissionNet: number;
  /** ยอดเก็บค่างวดปกติ (ไม่รวมยอดขายเครื่อง) */
  installmentPaid: number;
  /** ยอดขายเครื่อง (SUM bad_debt จาก debt_collected_cache WHERE is_bad_debt_row=1) */
  deviceSaleAmount: number;
  /** วันที่ขายเครื่อง (bad_debt_date จาก contracts) */
  saleDate: string | null;
  /** ต้นทุน = financeAmount + commissionNet */
  cost: number;
  /** รวมรายรับ = installmentPaid + deviceSaleAmount */
  totalRevenue: number;
  /** กำไร/ขาดทุน = totalRevenue - cost */
  profitLoss: number;
  /** งวดที่ชำระ (COUNT non-bad-debt rows) */
  paidInstallments: number;
  installmentCount: number | null;
};

/** Map ym (YYYY-MM) → total distinct contracts approved that month (all statuses) */
export type TotalContractsByApproveMonth = Record<string, number>;

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
}): Promise<{ rows: BadDebtRow[]; summary: BadDebtSummary; totalContractsByApproveMonth: TotalContractsByApproveMonth }> {
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
  if (!db) return { rows: [], summary: emptySummary, totalContractsByApproveMonth: {} };

  // ─── Step 1: Get distinct bad-debt contracts from debt_target_cache ───────
  // contract_status = 'หนี้เสีย' is stored on every period row for that contract
  let approveFilter = "";
  if (params.approveMonth) {
    approveFilter = `AND DATE_FORMAT(dtc.approve_date, '%Y-%m') = '${params.approveMonth.replace(/'/g, "''")}'`;
  }

  const contractsRaw = await db.execute(
    sql.raw(`
      SELECT
        dtc.contract_external_id,
        dtc.contract_no,
        dtc.customer_name,
        dtc.approve_date,
        dtc.product_type,
        dtc.model,
        CAST(dtc.finance_amount AS DECIMAL(18,2)) AS finance_amount,
        dtc.installment_count
      FROM debt_target_cache dtc
      WHERE dtc.section = '${params.section}'
        AND dtc.contract_status = 'หนี้เสีย'
        ${approveFilter}
      GROUP BY
        dtc.contract_external_id,
        dtc.contract_no,
        dtc.customer_name,
        dtc.approve_date,
        dtc.product_type,
        dtc.model,
        dtc.finance_amount,
        dtc.installment_count
      ORDER BY dtc.approve_date DESC
    `)
  );
  const contractsArr: Array<any> = (contractsRaw as any)[0] ?? contractsRaw;

  if (contractsArr.length === 0) return { rows: [], summary: emptySummary, totalContractsByApproveMonth: {} };

  const contractIds = contractsArr.map((r: any) => r.contract_external_id as string);
  const idsLiteral = contractIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");

  // ─── Step 2: Get payment aggregates from debt_collected_cache ─────────────
  const collectedRaw = await db.execute(
    sql.raw(`
      SELECT
        contract_external_id,
        SUM(CASE WHEN is_bad_debt_row = 1 THEN CAST(bad_debt AS DECIMAL(18,2)) ELSE 0 END)        AS device_sale_amount,
        SUM(CASE WHEN is_bad_debt_row = 0 THEN CAST(total_amount AS DECIMAL(18,2)) ELSE 0 END)    AS installment_paid
      FROM debt_collected_cache
      WHERE section = '${params.section}'
        AND contract_external_id IN (${idsLiteral})
      GROUP BY contract_external_id
    `)
  );
  const collectedArr: Array<any> = (collectedRaw as any)[0] ?? collectedRaw;

  // ─── Step 2b: หางวดสูงสุดที่มีการชำระเข้ามา (ไม่นับ bad_debt row) ─────────────
  // ใช้ MAX(period) จาก debt_collected_cache ที่ is_bad_debt_row = 0
  // ตรงกับ logic ของ DebtReport.tsx (maxPaidPeriod = max payment.period ที่ไม่ใช่ isBadDebtRow)
  const targetCountRaw = await db.execute(
    sql.raw(`
      SELECT
        contract_external_id,
        MAX(CASE WHEN is_bad_debt_row = 0 THEN period ELSE NULL END) AS paid_installments
      FROM debt_collected_cache
      WHERE section = '${params.section}'
        AND contract_external_id IN (${idsLiteral})
      GROUP BY contract_external_id
    `)
  );
  const targetCountArr: Array<any> = (targetCountRaw as any)[0] ?? targetCountRaw;
  const targetCountMap = new Map<string, number>();
  for (const r of targetCountArr) {
    // MAX(period) อาจเป็น NULL ถ้าไม่มีการชำระปกติเลย (มีแค่ bad_debt row) → ใช้ 0
    targetCountMap.set(r.contract_external_id, Number(r.paid_installments ?? 0));
  }

  const collectedMap = new Map<string, { deviceSaleAmount: number; installmentPaid: number; paidInstallments: number }>();
  for (const r of collectedArr) {
    collectedMap.set(r.contract_external_id, {
      deviceSaleAmount: Number(r.device_sale_amount ?? 0),
      installmentPaid: Number(r.installment_paid ?? 0),
      paidInstallments: targetCountMap.get(r.contract_external_id) ?? 0,
    });
  }

  // ─── Step 3: JOIN contracts for phone, sell_price, commission_net, bad_debt_date ─
  const contractInfoRaw = await db.execute(
    sql.raw(`
      SELECT
        external_id,
        phone,
        CAST(sell_price AS DECIMAL(18,2))     AS sell_price,
        CAST(commission_net AS DECIMAL(18,2)) AS commission_net,
        bad_debt_date
      FROM contracts
      WHERE section = '${params.section}'
        AND external_id IN (${idsLiteral})
    `)
  );
  const contractInfoArr: Array<any> = (contractInfoRaw as any)[0] ?? contractInfoRaw;
  const contractInfoMap = new Map<string, any>();
  for (const r of contractInfoArr) {
    contractInfoMap.set(r.external_id, r);
  }

  // ─── Step 4: Assemble rows ─────────────────────────────────────────────────
  const allRows: BadDebtRow[] = contractsArr.map((c: any) => {
    const extId: string = c.contract_external_id;
    const cInfo = contractInfoMap.get(extId);
    const collected = collectedMap.get(extId) ?? { deviceSaleAmount: 0, installmentPaid: 0, paidInstallments: 0 };

    const financeAmount = Number(c.finance_amount ?? 0);
    const commissionNet = cInfo?.commission_net != null ? Number(cInfo.commission_net) : 0;
    const deviceSaleAmount = collected.deviceSaleAmount;
    const installmentPaid = collected.installmentPaid;
    const cost = financeAmount + commissionNet;
    const totalRevenue = installmentPaid + deviceSaleAmount;
    const profitLoss = totalRevenue - cost;

    return {
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      customerName: c.customer_name ?? null,
      phone: cInfo?.phone ?? null,
      approveDate: c.approve_date ?? null,
      productType: c.product_type ?? null,
      model: c.model ?? null,
      salePrice: cInfo?.sell_price != null ? Number(cInfo.sell_price) : null,
      financeAmount,
      commissionNet,
      installmentPaid,
      deviceSaleAmount,
      saleDate: cInfo?.bad_debt_date ?? null,
      cost,
      totalRevenue,
      profitLoss,
      paidInstallments: collected.paidInstallments,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : null,
    };
  });

  // ─── Step 5: Filter by saleMonth (bad_debt_date) ──────────────────────────
  const rows = params.saleMonth
    ? allRows.filter((r) => (r.saleDate ?? "").startsWith(params.saleMonth!))
    : allRows;

  // ─── Step 6: Summary ──────────────────────────────────────────────────────
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

  // ─── Step 7: Count total contracts per approve_month (all statuses) ─────────
  // ใช้ตาราง contracts เพื่อนับจำนวนสัญญาที่อนุมัติในแต่ละเดือน (ทุกสถานะ)
  // ไม่ใช้ debt_target_cache เพราะมีหลาย row ต่อสัญญา (ทุกงวด)
  const totalContractsRaw = await db.execute(
    sql.raw(`
      SELECT
        DATE_FORMAT(approve_date, '%Y-%m') AS ym,
        COUNT(*) AS total
      FROM contracts
      WHERE section = '${params.section}'
        AND approve_date IS NOT NULL
      GROUP BY DATE_FORMAT(approve_date, '%Y-%m')
    `)
  );
  const totalContractsArr: Array<any> = (totalContractsRaw as any)[0] ?? totalContractsRaw;
  const totalContractsByApproveMonth: TotalContractsByApproveMonth = {};
  for (const r of totalContractsArr) {
    if (r.ym) totalContractsByApproveMonth[r.ym] = Number(r.total ?? 0);
  }

  return { rows, summary, totalContractsByApproveMonth };
}

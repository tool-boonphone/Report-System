/**
 * Debt report helpers.
 *
 * เป้าเก็บหนี้   : SUM(installments.amount)              GROUP BY month(due_date)
 * ยอดเก็บหนี้    : SUM(payment_transactions.amount)      GROUP BY month(paid_at)
 *
 * We compute per (section, month) and also return the running counts so the
 * UI can render a table + chart without additional queries.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  contracts,
  installments,
  paymentTransactions,
} from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

export type MonthlyRow = {
  month: string; // YYYY-MM
  target: number; // เป้าเก็บหนี้ (บาท)
  targetCount: number; // งวดที่ครบกำหนดในเดือนนี้
  collected: number; // ยอดเก็บหนี้ (บาท)
  collectedCount: number; // จำนวนธุรกรรมจ่ายในเดือนนี้
  gap: number; // target - collected (บาทที่ยังเก็บไม่ครบ)
  rate: number; // collected / target (0–1)
};

export type DebtSummary = {
  target: number;
  targetCount: number;
  collected: number;
  collectedCount: number;
  gap: number;
  rate: number;
};

/** Return { summary, monthly[] } for a section + date range. */
export async function getDebtReport(params: {
  section: SectionKey;
  /** YYYY-MM-DD inclusive */
  from: string;
  /** YYYY-MM-DD inclusive */
  to: string;
}): Promise<{ summary: DebtSummary; monthly: MonthlyRow[] }> {
  const db = await getDb();
  const empty: DebtSummary = {
    target: 0,
    targetCount: 0,
    collected: 0,
    collectedCount: 0,
    gap: 0,
    rate: 0,
  };
  if (!db) return { summary: empty, monthly: [] };

  // --- Target side (installments due in range) ---
  // MySQL SUBSTRING avoids per-row DATE parse overhead on our YYYY-MM-DD strings.
  // Note: only_full_group_by requires a deterministic grouping key. We
  // compute the month string once and GROUP BY the alias to avoid MySQL
  // complaining about the non-aggregated expression.
  const targetRowsRaw = await db.execute(sql`
    SELECT SUBSTRING(${installments.dueDate}, 1, 7) AS month,
           COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))), 0) AS target,
           COUNT(*) AS cnt
      FROM ${installments}
     WHERE ${installments.section} = ${params.section}
       AND ${installments.dueDate} >= ${params.from}
       AND ${installments.dueDate} <= ${params.to}
     GROUP BY month
  `);
  const targetRows: Array<{ month: string; target: unknown; cnt: unknown }> =
    (targetRowsRaw as any)[0] ?? (targetRowsRaw as any);

  // --- Collected side (payment transactions with paid_at in range) ---
  const collectedRowsRaw = await db.execute(sql`
    SELECT SUBSTRING(${paymentTransactions.paidAt}, 1, 7) AS month,
           COALESCE(SUM(CAST(${paymentTransactions.amount} AS DECIMAL(18,2))), 0) AS collected,
           COUNT(*) AS cnt
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND ${paymentTransactions.paidAt} >= ${params.from}
       AND ${paymentTransactions.paidAt} <= ${`${params.to} 23:59:59`}
     GROUP BY month
  `);
  const collectedRows: Array<{ month: string; collected: unknown; cnt: unknown }> =
    (collectedRowsRaw as any)[0] ?? (collectedRowsRaw as any);

  // --- Merge into a single month list ---
  const months = new Set<string>();
  const targetByMonth = new Map<string, { amount: number; count: number }>();
  const collectedByMonth = new Map<string, { amount: number; count: number }>();

  for (const r of targetRows) {
    if (!r.month) continue;
    months.add(r.month);
    targetByMonth.set(r.month, {
      amount: Number(r.target ?? 0),
      count: Number(r.cnt ?? 0),
    });
  }
  for (const r of collectedRows) {
    if (!r.month) continue;
    months.add(r.month);
    collectedByMonth.set(r.month, {
      amount: Number(r.collected ?? 0),
      count: Number(r.cnt ?? 0),
    });
  }

  const monthly: MonthlyRow[] = Array.from(months)
    .sort()
    .map((m) => {
      const t = targetByMonth.get(m) ?? { amount: 0, count: 0 };
      const c = collectedByMonth.get(m) ?? { amount: 0, count: 0 };
      const gap = t.amount - c.amount;
      const rate = t.amount > 0 ? c.amount / t.amount : 0;
      return {
        month: m,
        target: t.amount,
        targetCount: t.count,
        collected: c.amount,
        collectedCount: c.count,
        gap,
        rate,
      };
    });

  const summary: DebtSummary = monthly.reduce<DebtSummary>(
    (acc, r) => ({
      target: acc.target + r.target,
      targetCount: acc.targetCount + r.targetCount,
      collected: acc.collected + r.collected,
      collectedCount: acc.collectedCount + r.collectedCount,
      gap: acc.gap + r.gap,
      rate: 0,
    }),
    { ...empty },
  );
  summary.rate = summary.target > 0 ? summary.collected / summary.target : 0;

  return { summary, monthly };
}

/** Return a top-N list of contracts with the largest outstanding debt. */
export async function getOverdueTopList(params: {
  section: SectionKey;
  asOf: string; // YYYY-MM-DD
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const limit = params.limit ?? 20;

  // Outstanding = (installments due <= asOf .amount) - paid_amount (per row),
  // aggregated per contract.
  const rows = await db
    .select({
      contractExternalId: installments.contractExternalId,
      contractNo: installments.contractNo,
      dueAmount: sql<number>`COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))),0)`,
      paidAmount: sql<number>`COALESCE(SUM(CAST(${installments.paidAmount} AS DECIMAL(18,2))),0)`,
      overdueCount: sql<number>`COUNT(*)`,
    })
    .from(installments)
    .where(
      and(
        eq(installments.section, params.section),
        lte(installments.dueDate, params.asOf),
      ),
    )
    .groupBy(installments.contractExternalId, installments.contractNo)
    .having(
      sql`COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))),0) - COALESCE(SUM(CAST(${installments.paidAmount} AS DECIMAL(18,2))),0) > 0`,
    )
    .orderBy(
      sql`COALESCE(SUM(CAST(${installments.amount} AS DECIMAL(18,2))),0) - COALESCE(SUM(CAST(${installments.paidAmount} AS DECIMAL(18,2))),0) DESC`,
    )
    .limit(limit);

  // Enrich with customer info for display.
  const externalIds = rows
    .map((r) => r.contractExternalId)
    .filter((x): x is string => !!x);
  const customerByExt = new Map<string, { name: string | null; phone: string | null }>();
  if (externalIds.length) {
    const cRows = await db
      .select({
        externalId: contracts.externalId,
        name: contracts.customerName,
        phone: contracts.phone,
      })
      .from(contracts)
      .where(
        and(
          eq(contracts.section, params.section),
          sql`${contracts.externalId} IN (${sql.join(
            externalIds.map((v) => sql`${v}`),
            sql`, `,
          )})`,
        ),
      );
    for (const r of cRows) {
      customerByExt.set(r.externalId, { name: r.name, phone: r.phone });
    }
  }

  return rows.map((r) => {
    const c = r.contractExternalId
      ? customerByExt.get(r.contractExternalId)
      : null;
    const outstanding = Number(r.dueAmount) - Number(r.paidAmount);
    return {
      contractExternalId: r.contractExternalId ?? null,
      contractNo: r.contractNo ?? null,
      customerName: c?.name ?? null,
      phone: c?.phone ?? null,
      dueAmount: Number(r.dueAmount),
      paidAmount: Number(r.paidAmount),
      outstanding,
      overdueCount: Number(r.overdueCount),
    };
  });
}

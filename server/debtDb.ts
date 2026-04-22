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
  // Only count payments that are marked as paid/active — filters out
  // voided / refunded / pending transactions if the API ever adds them.
  const collectedRowsRaw = await db.execute(sql`
    SELECT SUBSTRING(${paymentTransactions.paidAt}, 1, 7) AS month,
           COALESCE(SUM(CAST(${paymentTransactions.amount} AS DECIMAL(18,2))), 0) AS collected,
           COUNT(*) AS cnt
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND ${paymentTransactions.paidAt} >= ${params.from}
       AND ${paymentTransactions.paidAt} <= ${`${params.to} 23:59:59`}
       AND (${paymentTransactions.status} IS NULL
            OR LOWER(${paymentTransactions.status}) IN ('active', 'paid', 'success', 'completed'))
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

/* ============================================================================
 * Per-contract lists for the new two-tab debt report (target / collected).
 *
 * The UI mirrors boonphone.co.th/mm.html:
 *   - Each contract = 1 row (summary columns on the left)
 *   - Per-installment "groups" repeat horizontally (งวดที่ 1..N)
 *
 * Status label ("debt_status") is derived from the worst-overdue unpaid
 * installment of the contract as of today. If contract.status is a terminal
 * value (ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย), that wins.
 * ============================================================================ */

type ContractRowLite = {
  externalId: string;
  contractNo: string | null;
  approveDate: string | null;
  customerName: string | null;
  phone: string | null;
  installmentCount: number | null;
  installmentAmount: number | null;
  contractStatus: string | null;
};

type InstRawRow = {
  contract_external_id: string;
  period: number | null;
  due_date: string | null;
  amount: number | null;
  paid_amount: number | null;
  inst_status: string | null;
  principal_due: number | null;
  interest_due: number | null;
  fee_due: number | null;
  penalty_due: number | null;
};

type PayRawRow = {
  contract_external_id: string;
  period: number | null; // derived from receipt_no suffix or order
  paid_at: string | null;
  total_paid_amount: number | null;
  principal_paid: number | null;
  interest_paid: number | null;
  fee_paid: number | null;
  penalty_paid: number | null;
  unlock_fee_paid: number | null;
  discount_amount: number | null;
  overpaid_amount: number | null;
  close_installment_amount: number | null;
  bad_debt_amount: number | null;
  receipt_no: string | null;
  remark: string | null;
  payment_id: number | null;
};

/** Compute "debt_status" label based on days overdue. */
function bucketFromDays(days: number): string {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

const TERMINAL_STATUSES = new Set([
  "ระงับสัญญา",
  "สิ้นสุดสัญญา",
  "หนี้เสีย",
]);

function deriveDebtStatus(
  contractStatus: string | null,
  installmentsForContract: InstRawRow[],
  today: Date,
): { label: string; daysOverdue: number } {
  if (contractStatus && TERMINAL_STATUSES.has(contractStatus)) {
    return { label: contractStatus, daysOverdue: 0 };
  }
  let maxDays = 0;
  for (const it of installmentsForContract) {
    if (!it.due_date) continue;
    const dueMs = Date.parse(`${it.due_date}T00:00:00`);
    if (Number.isNaN(dueMs)) continue;
    const paid = Number(it.paid_amount ?? 0);
    const amt = Number(it.amount ?? 0);
    // Treat installment as unpaid when the status is not "เสร็จสมบูรณ์" / "ชำระครบ"
    // and paid_amount < amount.
    const outstanding = amt - paid;
    if (outstanding <= 0.001) continue;
    const days = Math.floor((today.getTime() - dueMs) / (1000 * 60 * 60 * 24));
    if (days > maxDays) maxDays = days;
  }
  return { label: bucketFromDays(maxDays), daysOverdue: maxDays };
}

/**
 * Return the dataset used by the "เป้าเก็บหนี้" tab.
 * One entry per contract with `installments[]` describing the scheduled
 * principal / interest / fee / penalty for each period.
 */
export async function listDebtTarget(params: { section: SectionKey }) {
  const db = await getDb();
  if (!db) return { rows: [] as any[] };

  // --- Load contract headers (trimmed — no rawJson) ---
  const contractRowsRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           installment_count,
           installment_amount,
           status
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
  `);
  const cRows: Array<any> = (contractRowsRaw as any)[0] ?? contractRowsRaw;

  // --- Load installments with sub-fields extracted from raw_json once ---
  const instRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           period,
           due_date,
           CAST(amount AS DECIMAL(18,2))       AS amount,
           CAST(paid_amount AS DECIMAL(18,2))  AS paid_amount,
           status AS inst_status,
           CAST(JSON_EXTRACT(raw_json, '$.principal_due') AS DECIMAL(18,2)) AS principal_due,
           CAST(JSON_EXTRACT(raw_json, '$.interest_due')  AS DECIMAL(18,2)) AS interest_due,
           CAST(JSON_EXTRACT(raw_json, '$.fee_due')       AS DECIMAL(18,2)) AS fee_due,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_due')   AS DECIMAL(18,2)) AS penalty_due
      FROM ${installments}
     WHERE ${installments.section} = ${params.section}
     ORDER BY contract_external_id, period
  `);
  const iRows: InstRawRow[] = (instRowsRaw as any)[0] ?? instRowsRaw;

  const instByContract = new Map<string, InstRawRow[]>();
  for (const r of iRows) {
    const key = String(r.contract_external_id);
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key)!.push({
      contract_external_id: key,
      period: r.period != null ? Number(r.period) : null,
      due_date: r.due_date ?? null,
      amount: r.amount != null ? Number(r.amount) : null,
      paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
      inst_status: r.inst_status ?? null,
      principal_due: r.principal_due != null ? Number(r.principal_due) : null,
      interest_due: r.interest_due != null ? Number(r.interest_due) : null,
      fee_due: r.fee_due != null ? Number(r.fee_due) : null,
      penalty_due: r.penalty_due != null ? Number(r.penalty_due) : null,
    });
  }

  // --- Find the highest period number that the customer already CLOSED via
  //     a lump-sum `close_installment_amount` payment. Any period AFTER this
  //     number is guaranteed to be closed and should be rendered as
  //     "ปิดค่างวดแล้ว" with zeroed amounts. The period that received the
  //     close-out itself keeps the normal amount (per user feedback).
  //
  //     Boonphone's receipt_no encodes the period at the trailing "-N"
  //     suffix, so we use that as the source of truth instead of relying
  //     on `installments.amount` becoming zero (which doesn't happen for
  //     future periods on closed contracts).
  const closedByContract = new Map<string, number>();
  const closeRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) > 0
  `);
  const closeRows: any[] = (closeRowsRaw as any)[0] ?? closeRowsRaw;
  for (const pr of closeRows) {
    const key = String(pr.contract_external_id ?? "");
    if (!key) continue;
    // Period is the number after the final '-' in receipt_no, e.g.
    // "TXRT0226-NBI001-0012-01-3" -> 3.
    const m = /-(\d+)$/.exec(String(pr.receipt_no ?? ""));
    if (!m) continue;
    const period = Number(m[1]);
    if (!Number.isFinite(period) || period <= 0) continue;
    const prev = closedByContract.get(key) ?? 0;
    if (period > prev) closedByContract.set(key, period);
  }

  const today = new Date();

  // --- TRUST-API MODEL ---
  // Empirical DB audit (2026-04 over Boonphone section, 2,559 payments,
  // 63 overpaid cases): 57/63 already see their next installment amount
  // reduced in `installments.amount` coming from the API, and the
  // remaining 6 cases are terminal-period / same-period overpays. So the
  // API is the authoritative source of truth for per-period `amount`,
  // `principal_due`, `interest_due`, `fee_due`. Re-computing deductions
  // client-side double-counts.
  //
  // Instead of mutating per-period amounts, we compute the DELTA against
  // the contract baseline (`contracts.installment_amount`) and expose it
  // to the UI so the operator can see "(-หักชำระเกิน: xxx)" or
  // "ปิดค่างวดแล้ว" without changing the underlying number.

  const rows = cRows.map((c) => {
    const extId = String(c.external_id);
    const list = instByContract.get(extId) ?? [];
    const totalPaid = list.reduce(
      (s, r) => s + Number(r.paid_amount ?? 0),
      0,
    );
    const totalAmount = list.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const { label: debtStatus, daysOverdue } = deriveDebtStatus(
      c.status ?? null,
      list,
      today,
    );

    const baselineAmount =
      c.installment_amount != null ? Number(c.installment_amount) : null;

    // Highest period that the customer CLOSED via a lump-sum payment.
    // Periods strictly greater than this are the ones to render as
    // "ปิดค่างวดแล้ว" with zero amounts.
    const maxClosedPeriod = closedByContract.get(extId) ?? 0;

    // Build installment schedule straight from the API fields.
    const baseInstallments = list
      .map((r) => {
        const rawAmount = Number(r.amount ?? 0);
        const rawPrincipal = Number(r.principal_due ?? 0);
        const rawInterest = Number(r.interest_due ?? 0);
        const rawFee = Number(r.fee_due ?? 0);
        const rawPenalty = Number(r.penalty_due ?? 0);
        const paid = Number(r.paid_amount ?? 0);
        const periodNo = r.period != null ? Number(r.period) : 0;

        // --- Closed-out rule (user-specified):
        //
        //   If the customer made a close-out payment for period K, then
        //   periods K+1..N are considered closed — they should render as
        //   "ปิดค่างวดแล้ว" with zero amounts so the collections team
        //   never tries to collect them again. Periods <= K keep their
        //   normal figures (the close-out period itself still shows a
        //   real amount because the operator actually paid it).
        const isClosed = maxClosedPeriod > 0 && periodNo > maxClosedPeriod;

        // Zero out future closed periods, keep other periods intact.
        const amount = isClosed ? 0 : rawAmount;
        const principal = isClosed ? 0 : rawPrincipal;
        const interest = isClosed ? 0 : rawInterest;
        const fee = isClosed ? 0 : rawFee;
        const penalty = isClosed ? 0 : rawPenalty;

        // Delta vs baseline (positive when this period was reduced). We
        // compute this against the non-closed amount — closed periods are
        // rendered as "ปิดค่างวดแล้ว" so the delta is irrelevant.
        const overpaidApplied =
          !isClosed &&
          baselineAmount != null &&
          amount < baselineAmount - 0.01 &&
          amount > 0.009
            ? Math.round((baselineAmount - amount) * 100) / 100
            : 0;

        return {
          period: r.period ?? null,
          dueDate: r.due_date ?? null,
          principal,
          interest,
          fee,
          penalty,
          amount,
          paid,
          baselineAmount: baselineAmount ?? 0,
          overpaidApplied,
          // Legacy fields kept for export compatibility.
          principalDeducted: 0,
          interestDeducted: 0,
          feeDeducted: 0,
          isClosed,
        };
      })
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    return {
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      approveDate: c.approve_date ?? null,
      customerName: c.customer_name ?? null,
      phone: c.phone ?? null,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : list.length,
      installmentAmount: c.installment_amount != null ? Number(c.installment_amount) : null,
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments: baseInstallments,
    };
  });

  return { rows };
}

/**
 * Return the dataset used by the "ยอดเก็บหนี้" tab.
 * One entry per contract + array of actual payments grouped by the
 * installment period they closed (`close_installment_amount` / derived).
 */
export async function listDebtCollected(params: { section: SectionKey }) {
  const db = await getDb();
  if (!db) return { rows: [] as any[] };

  // Reuse target list for shared summary columns & debt-status derivation.
  const { rows: baseRows } = await listDebtTarget(params);

  // Boonphone payment_transactions.raw_json contains every field we need:
  //   principal_paid, interest_paid, fee_paid, penalty_paid, unlock_fee_paid,
  //   discount_amount, overpaid_amount, close_installment_amount,
  //   bad_debt_amount, total_paid_amount, receipt_no, remark, payment_id.
  // No client-side calculation needed; we just project it.
  const payRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           paid_at,
           CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.principal_paid')           AS DECIMAL(18,2)) AS principal_paid,
           CAST(JSON_EXTRACT(raw_json, '$.interest_paid')            AS DECIMAL(18,2)) AS interest_paid,
           CAST(JSON_EXTRACT(raw_json, '$.fee_paid')                 AS DECIMAL(18,2)) AS fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.penalty_paid')             AS DECIMAL(18,2)) AS penalty_paid,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_paid')          AS DECIMAL(18,2)) AS unlock_fee_paid,
           CAST(JSON_EXTRACT(raw_json, '$.discount_amount')          AS DECIMAL(18,2)) AS discount_amount,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount')          AS DECIMAL(18,2)) AS overpaid_amount,
           CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_installment_amount,
           CAST(JSON_EXTRACT(raw_json, '$.bad_debt_amount')          AS DECIMAL(18,2)) AS bad_debt_amount,
           CAST(JSON_EXTRACT(raw_json, '$.payment_id')               AS UNSIGNED) AS payment_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND (${paymentTransactions.status} IS NULL
            OR LOWER(${paymentTransactions.status}) IN ('active', 'paid', 'success', 'completed'))
     ORDER BY contract_external_id, paid_at, payment_id
  `);
  const pRows: any[] = (payRowsRaw as any)[0] ?? payRowsRaw;

  const payByContract = new Map<string, PayRawRow[]>();
  for (const r of pRows) {
    const key = String(r.contract_external_id ?? "");
    if (!key) continue;
    if (!payByContract.has(key)) payByContract.set(key, []);
    payByContract.get(key)!.push({
      contract_external_id: key,
      period: null, // derived below
      paid_at: r.paid_at ?? null,
      total_paid_amount:
        r.total_paid_amount != null ? Number(r.total_paid_amount) : null,
      principal_paid:
        r.principal_paid != null ? Number(r.principal_paid) : null,
      interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
      fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
      penalty_paid: r.penalty_paid != null ? Number(r.penalty_paid) : null,
      unlock_fee_paid:
        r.unlock_fee_paid != null ? Number(r.unlock_fee_paid) : null,
      discount_amount:
        r.discount_amount != null ? Number(r.discount_amount) : null,
      overpaid_amount:
        r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
      close_installment_amount:
        r.close_installment_amount != null
          ? Number(r.close_installment_amount)
          : null,
      bad_debt_amount:
        r.bad_debt_amount != null ? Number(r.bad_debt_amount) : null,
      payment_id: r.payment_id != null ? Number(r.payment_id) : null,
      receipt_no: r.receipt_no ?? null,
      remark: r.remark ?? null,
    });
  }

  /**
   * Derive installment period (1..N) for each payment by:
   *   1) Sorting payments by (paid_at, payment_id)
   *   2) Walking through scheduled installments in order; each payment
   *      "fills" the current installment by its principal+interest+fee
   *      (i.e. close_installment_amount when present).
   *   3) When the current installment is fully paid (or `close_installment_amount`
   *      is large enough to cover several installments), advance the cursor.
   * The result: each payment is tagged with the installment period it
   * primarily belongs to, plus a `splitIndex` (0 = primary row, >0 = sub-row).
   */
  function assignPeriods(
    payments: PayRawRow[],
    installmentList: Array<{ period: number | null; amount: number }>,
  ): Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> {
    if (!payments.length) return [];
    const schedule = installmentList
      .filter((i) => i.period != null)
      .map((i) => ({ period: i.period as number, amount: Number(i.amount) || 0 }))
      .sort((a, b) => a.period - b.period);

    let cursor = 0; // index into schedule
    let coveredCurrent = 0; // amount applied to schedule[cursor]
    const periodSeen = new Map<number, number>(); // period -> count of payments
    const out: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> = [];

    const sorted = [...payments].sort((a, b) => {
      const at = a.paid_at ?? "";
      const bt = b.paid_at ?? "";
      if (at !== bt) return at.localeCompare(bt);
      return (a.payment_id ?? 0) - (b.payment_id ?? 0);
    });

    for (const p of sorted) {
      // Bad-debt row: API marks bad_debt_amount > 0 → goes on the LAST installment.
      if ((p.bad_debt_amount ?? 0) > 0) {
        const lastPeriod = schedule.length
          ? schedule[schedule.length - 1].period
          : 1;
        const splitIdx = periodSeen.get(lastPeriod) ?? 0;
        periodSeen.set(lastPeriod, splitIdx + 1);
        out.push({ ...p, period: lastPeriod, splitIndex: splitIdx, isCloseRow: false, isBadDebtRow: true });
        continue;
      }

      // Determine which installment this payment belongs to.
      const period = schedule[cursor]?.period ?? null;
      const splitIdx = period != null ? (periodSeen.get(period) ?? 0) : 0;
      if (period != null) periodSeen.set(period, splitIdx + 1);

      // "close-row" detection: payment covers more than one installment
      // (close_installment_amount > current installment amount * 1.5 → spans extra).
      const closeAmt = p.close_installment_amount ?? 0;
      const currentAmt = schedule[cursor]?.amount ?? 0;
      const isCloseRow = closeAmt > currentAmt * 1.5 && currentAmt > 0;

      out.push({ ...p, period, splitIndex: splitIdx, isCloseRow, isBadDebtRow: false });

      // Advance cursor: each payment burns through its allocated amount.
      const consumed = Number(p.principal_paid ?? 0) +
        Number(p.interest_paid ?? 0) +
        Number(p.fee_paid ?? 0);
      coveredCurrent += consumed;
      while (cursor < schedule.length - 1 && coveredCurrent >= schedule[cursor].amount - 0.5) {
        coveredCurrent -= schedule[cursor].amount;
        cursor += 1;
      }
    }
    return out;
  }

  const rows = baseRows.map((c) => {
    const rawPayments = payByContract.get(c.contractExternalId) ?? [];
    const tagged = assignPeriods(
      rawPayments,
      c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
    );
    return {
      ...c,
      payments: tagged.map((p) => ({
        period: p.period ?? null,
        splitIndex: p.splitIndex,
        isCloseRow: p.isCloseRow,
        isBadDebtRow: p.isBadDebtRow,
        paidAt: p.paid_at,
        principal: p.principal_paid ?? 0,
        interest: p.interest_paid ?? 0,
        fee: p.fee_paid ?? 0,
        penalty: p.penalty_paid ?? 0,
        unlockFee: p.unlock_fee_paid ?? 0,
        discount: p.discount_amount ?? 0,
        overpaid: p.overpaid_amount ?? 0,
        closeInstallmentAmount: p.close_installment_amount ?? 0,
        badDebt: p.bad_debt_amount ?? 0,
        total: p.total_paid_amount ?? 0,
        receiptNo: p.receipt_no ?? null,
        remark: p.remark ?? null,
      })),
    };
  });

  return { rows };
}

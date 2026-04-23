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

/**
 * Pure helper: derive the bad-debt date for a contract.
 *
 * Business rule (user, 2026-04-23):
 *   "วันที่รับยอดสุดท้ายตอนที่ยังเป็นระงับสัญญาอยู่นั่นแหละคือวันที่ถูกบันทึกว่าเป็นหนี้เสีย"
 *
 * Inputs:
 *   payments      — payments of the contract; each carries `paid_at`
 *   suspendedAt   — ISO date/datetime the contract became suspended
 *                   (first suspended installment's due_date)
 *
 * Rule:
 *   Pick the LATEST `paid_at` whose value is strictly greater than
 *   `suspendedAt`. If no payment qualifies, fall back to `suspendedAt`.
 *
 * Exported so it can be unit-tested without touching the DB.
 */
export function deriveBadDebtDate(
  payments: Array<{ paid_at: string | null }>,
  suspendedAt: string | null,
): string | null {
  if (!suspendedAt) return null;
  const threshold = suspendedAt;
  let latest: string | null = null;
  for (const p of payments) {
    const t = p.paid_at ?? null;
    if (!t) continue;
    // Compare as ISO strings. MySQL DATETIME and DATE strings are ISO-sortable.
    if (t > threshold && (latest == null || t > latest)) {
      latest = t;
    }
  }
  return latest ?? suspendedAt;
}

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
  unlock_fee_due: number | null;
  /** Per-period status code extracted from raw_json.installment_status_code. */
  installment_status_code: string | null;
};

/**
 * Assign installment period + sub-row (splitIndex) + close/bad-debt flags
 * to each raw payment row. Exported for unit testing; consumers inside
 * listDebtCollected import it too.
 *
 * 1) Sorts payments by (paid_at, payment_id)
 * 2) Walks through scheduled installments in order; each payment
 *    "fills" the current installment by its principal+interest+fee
 *    (i.e. close_installment_amount when present).
 * 3) When the current installment is fully paid (or `close_installment_amount`
 *    is large enough to cover several installments), advance the cursor.
 * 4) `splitIndex` counts payments per period (0 = primary, 1 = 2nd, …)
 * 5) `isCloseRow` is true ONLY when receipt_no starts with "TXRTC"
 *    (Boonphone close-contract settlement). A positive
 *    `close_installment_amount` alone is NOT sufficient — every regular
 *    full-period payment also carries that field.
 * 6) `isBadDebtRow` is true when bad_debt_amount > 0; the payment is
 *    forced onto the LAST installment period.
 */
export function assignPayPeriods(
  payments: PayRawRow[],
  installmentList: Array<{ period: number | null; amount: number }>,
): Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> {
  if (!payments.length) return [];
  const schedule = installmentList
    .filter((i) => i.period != null)
    .map((i) => ({ period: i.period as number, amount: Number(i.amount) || 0 }))
    .sort((a, b) => a.period - b.period);

  let cursor = 0;
  let coveredCurrent = 0;
  const periodSeen = new Map<number, number>();
  const out: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> = [];

  const sorted = [...payments].sort((a, b) => {
    const at = a.paid_at ?? "";
    const bt = b.paid_at ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return (a.payment_id ?? 0) - (b.payment_id ?? 0);
  });

  for (const p of sorted) {
    if ((p.bad_debt_amount ?? 0) > 0) {
      const lastPeriod = schedule.length
        ? schedule[schedule.length - 1].period
        : 1;
      const splitIdx = periodSeen.get(lastPeriod) ?? 0;
      periodSeen.set(lastPeriod, splitIdx + 1);
      out.push({ ...p, period: lastPeriod, splitIndex: splitIdx, isCloseRow: false, isBadDebtRow: true });
      continue;
    }

    const period = schedule[cursor]?.period ?? null;
    const splitIdx = period != null ? (periodSeen.get(period) ?? 0) : 0;
    if (period != null) periodSeen.set(period, splitIdx + 1);

    const receipt = String(p.receipt_no ?? "");
    const isCloseRow = receipt.startsWith("TXRTC");

    out.push({ ...p, period, splitIndex: splitIdx, isCloseRow, isBadDebtRow: false });

    // Cursor advancement.
    //
    // Business rule (Phase 9M, 2026-04-23):
    //   TXRTC (close-contract) receipts — each receipt represents exactly
    //   ONE installment period (Boonphone API emits N receipts for N
    //   remaining periods, sometimes with the same paid_at). So we
    //   unconditionally advance the cursor by one per TXRTC receipt.
    //   This is the ONLY reliable rule because principal/interest/fee
    //   fields are often null on TXRTC close-out rows (and even
    //   `amount` is zero on the discount-only tail rows).
    //
    //   Regular TXRT payments — we still use the amount-based walk so
    //   that partial payments of the same period stay on that period.
    if (isCloseRow) {
      if (cursor < schedule.length - 1) {
        cursor += 1;
        coveredCurrent = 0;
      }
    } else {
      // Prefer principal+interest+fee when present; fall back to
      // close_installment_amount, then raw amount. Any of these tells us
      // "how much of the current installment did this payment burn".
      const pif =
        Number(p.principal_paid ?? 0) +
        Number(p.interest_paid ?? 0) +
        Number(p.fee_paid ?? 0);
      const consumed =
        pif > 0
          ? pif
          : Number(p.close_installment_amount ?? 0) > 0
            ? Number(p.close_installment_amount)
            : Number(p.total_paid_amount ?? 0);
      coveredCurrent += consumed;
      while (
        cursor < schedule.length - 1 &&
        schedule[cursor].amount > 0 &&
        coveredCurrent >= schedule[cursor].amount - 0.5
      ) {
        coveredCurrent -= schedule[cursor].amount;
        cursor += 1;
      }
    }
  }
  return out;
}

export type PayRawRow = {
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
           CAST(JSON_EXTRACT(raw_json, '$.penalty_due')    AS DECIMAL(18,2)) AS penalty_due,
           CAST(JSON_EXTRACT(raw_json, '$.unlock_fee_due')  AS DECIMAL(18,2)) AS unlock_fee_due,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS installment_status_code
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
      unlock_fee_due: r.unlock_fee_due != null ? Number(r.unlock_fee_due) : null,
      installment_status_code: r.installment_status_code ?? null,
    });
  }

  // --- Detect "ปิดค่างวด" (customer settles ALL remaining periods at once).
  //
  // Boonphone's signal for a real close-contract event is the receipt_no
  // prefix `TXRTC` (C = Close). Regular per-period receipts start with
  // `TXRT` and encode the period at the trailing "-N" suffix; close-out
  // receipts drop the suffix and come as a burst of N rows on the same
  // paid_at (one per remaining period).
  //
  // NOTE: a positive `close_installment_amount` alone does NOT indicate a
  // close-contract — it just means "this payment settles the current
  // period in full" (every full-period payment has it). See
  // scripts/audit-close-definition.ts for the DB audit showing all 2,534
  // `close_installment_amount > 0` rows have ratio 1.00 vs baseline.
  //
  // For each contract that has at least one `TXRTC` receipt, we want
  // `closeStartsAtPeriod` = first period that should render as
  // "ปิดค่างวดแล้ว". That is (max period paid BEFORE the close-out) + 1,
  // so the period the customer paid at the close-contract moment itself
  // keeps its real amount and only strictly-later periods get zeroed.
  const closedByContract = new Map<string, number>();
  const rawCloseData = await db.execute(sql`
    SELECT contract_external_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount,
           paid_at
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
       AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) IS NOT NULL
  `);
  const allPayRows: any[] = (rawCloseData as any)[0] ?? rawCloseData;

  // Pass 1: group by contract, split into (normalPaidPeriods, closeContractDates).
  // Also track overpaid_amount per period to derive overpaidApplied for the NEXT period.
  const normalPeriodsByContract = new Map<string, Set<number>>();
  const closeDatesByContract = new Map<string, Date[]>();
  const overpaidByContractPeriod = new Map<string, Map<number, number>>();
  // For bad-debt date derivation: every payment's paid_at per contract.
  const paidAtsByContract = new Map<string, string[]>();

  for (const pr of allPayRows) {
    const key = String(pr.contract_external_id ?? "");
    if (!key) continue;
    if (pr.paid_at) {
      const arr = paidAtsByContract.get(key) ?? [];
      arr.push(String(pr.paid_at));
      paidAtsByContract.set(key, arr);
    }
    const receipt = String(pr.receipt_no ?? "");
    if (receipt.startsWith("TXRTC")) {
      const dt = pr.paid_at ? new Date(pr.paid_at) : null;
      if (dt && !isNaN(dt.getTime())) {
        const list = closeDatesByContract.get(key) ?? [];
        list.push(dt);
        closeDatesByContract.set(key, list);
      }
    } else {
      // Regular single-period payment: period is the trailing -N suffix.
      const m = /-(\d+)$/.exec(receipt);
      if (!m) continue;
      const period = Number(m[1]);
      if (!Number.isFinite(period) || period <= 0) continue;
      const set = normalPeriodsByContract.get(key) ?? new Set<number>();
      set.add(period);
      normalPeriodsByContract.set(key, set);

      // Track overpaid amount for this period
      const overpaid = Number(pr.overpaid_amount ?? 0);
      if (overpaid > 0) {
        let periodMap = overpaidByContractPeriod.get(key);
        if (!periodMap) {
          periodMap = new Map<number, number>();
          overpaidByContractPeriod.set(key, periodMap);
        }
        periodMap.set(period, (periodMap.get(period) ?? 0) + overpaid);
      }
    }
  }

  // Pass 2: for every contract with a TXRTC payment, derive the highest
  // normal period paid BEFORE the earliest close-contract date.
  for (const [key, dates] of Array.from(closeDatesByContract.entries())) {
    const earliestClose = dates.reduce((a: Date, b: Date) => (a < b ? a : b));
    // We treat all normal payments for this contract as "before close" for
    // now — regular payments that happen after a close-contract event are
    // extremely rare in practice and would only push the closing period
    // higher, which is the safe direction (fewer rows incorrectly zeroed).
    const normals = normalPeriodsByContract.get(key);
    const maxNormalPeriod = normals && normals.size > 0
      ? Math.max(...Array.from(normals))
      : 0;
    // Periods <= maxNormalPeriod keep their amounts; periods >
    // maxNormalPeriod are the ones the customer settled at the
    // close-contract moment and should render as "ปิดค่างวดแล้ว".
    closedByContract.set(key, maxNormalPeriod);
    void earliestClose; // currently unused but kept for future refinement
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

    // --- USER RULE (2026-04-23): ระงับสัญญา / หนี้เสีย ---
    // เมื่อ contract.status = "ระงับสัญญา": หา period แรกที่ installment_status_code='ระงับสัญญา'
    // → periods >= that period ต้องแสดงเป็น "ระงับสัญญา" + ใช้ due_date ของ period นั้นเป็น suspendedAt
    // เมื่อ contract.status = "หนี้เสีย": ใช้รูปแบบเดียวกับระงับสัญญา แต่เปลี่ยนป้ายเป็น "หนี้เสีย"
    //   (per-period: override ทุก period ที่ installment_status_code เป็น ระงับสัญญา/หนี้เสีย)
    // ทั้งสองสถานะ: money fields = 0, ไม่นับเข้าเป้าเก็บหนี้
    const contractStatus = c.status ?? null;
    const isContractSuspended = contractStatus === "ระงับสัญญา";
    const isContractBadDebt = contractStatus === "หนี้เสีย";
    let suspendedFromPeriod = 0; // > 0 → periods >= this render as suspended
    let suspendedAt: string | null = null;
    if (isContractSuspended || isContractBadDebt) {
      const firstSuspended = list
        .filter(
          (r) =>
            r.installment_status_code === "ระงับสัญญา" ||
            r.installment_status_code === "หนี้เสีย",
        )
        .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
      if (firstSuspended?.period) {
        suspendedFromPeriod = Number(firstSuspended.period);
        suspendedAt = firstSuspended.due_date ?? null;
      }
      // For bad-debt contracts, the effective “status-change date” is
      // the LAST payment that arrived while the contract was still in
      // ระงับสัญญา (i.e. after `suspendedAt`). Falls back to
      // `suspendedAt` when no such payment exists.
      if (isContractBadDebt && suspendedAt) {
        const paidAts = paidAtsByContract.get(extId) ?? [];
        suspendedAt = deriveBadDebtDate(
          paidAts.map((t) => ({ paid_at: t })),
          suspendedAt,
        );
      }
    }

    // Build installment schedule.
    //
    // USER RULE (2026-04-23):
    //   ଇ Past/current periods must ALWAYS show the baseline amount — even
    //     after the customer has fully paid them. The collections team uses
    //     this report as "ยอดตั้งเก็บ" for the month, not "ยอดค้างชำระ".
    //   ଇ EXCEPTION: if a previous period generated an overpaid carry that
    //     got applied to THIS period, the API already reduced `amount`
    //     (e.g. baseline 4097 → amount 3944 when 153 was carried). We
    //     keep the reduced amount so the real outstanding is shown, and
    //     surface the delta via `overpaidApplied` for UI annotation.
    //   ଇ POST-CLOSE: periods strictly AFTER `maxClosedPeriod` render as
    //     "ปิดค่างวดแล้ว" with zero amounts.
    //
    // API observation (see scripts/audit-overpaid-carry.mjs):
    //   ଇ Boonphone sets `amount = 0` for the period where the customer
    //     paid in full AND also generated an overpaid carry (i.e. the
    //     overpaid is booked against that very period's row). Before the
    //     carry appears, the period would simply have amount=baseline and
    //     paid_amount=baseline. So when we see `amount=0, paid>0` outside
    //     of post-close, we restore baseline so the operator still sees the
    //     full monthly target.
    const baseInstallments = list
      .map((r) => {
        const rawAmount = Number(r.amount ?? 0);
        const rawPrincipal = Number(r.principal_due ?? 0);
        const rawInterest = Number(r.interest_due ?? 0);
        const rawFee = Number(r.fee_due ?? 0);
        const rawPenalty = Number(r.penalty_due ?? 0);
        const rawUnlockFee = Number(r.unlock_fee_due ?? 0);
        const paid = Number(r.paid_amount ?? 0);
        const periodNo = r.period != null ? Number(r.period) : 0;

        const isClosed = maxClosedPeriod > 0 && periodNo > maxClosedPeriod;
        // Per-period suspended flag: period is >= the first suspended period.
        // Bad-debt contract → re-use the same flag but surface a different label.
        const isSuspended =
          !isClosed &&
          suspendedFromPeriod > 0 &&
          periodNo >= suspendedFromPeriod;
        const suspendLabel = isContractBadDebt ? "หนี้เสีย" : "ระงับสัญญา";

        // --- Compute display amount (non-closed periods) ---
        let amount = rawAmount;
        let principal = rawPrincipal;
        let interest = rawInterest;
        let fee = rawFee;
        let penalty = rawPenalty;
        let unlockFee = rawUnlockFee;

        const paidInFullButZeroedByApi =
          !isClosed &&
          rawAmount <= 0.009 &&
          paid > 0.009 &&
          baselineAmount != null &&
          baselineAmount > 0;

        if (paidInFullButZeroedByApi) {
          // Restore baseline so the operator sees the full monthly target.
          // We don't have the original principal/interest/fee split here
          // because API zeroed them too — fall back to baseline on `amount`
          // and keep the sub-fields as best-effort (0 + annotation).
          amount = baselineAmount!;
        }

        if (isClosed || isSuspended) {
          amount = 0;
          principal = 0;
          interest = 0;
          fee = 0;
          penalty = 0;
          unlockFee = 0;
        } else {
          // Boonphone displays principal+interest scaled so that
          // principal + interest + fee + penalty = total amount.
          // The raw `principal_due` / `interest_due` in installments.raw_json
          // represents only the *base* split (excluding amortization of
          // accrued interest); the visible split on the Boonphone admin UI
          // is rescaled to fill the remainder after fee + penalty.
          // Example (contract 4092 period 1):
          //   raw principal_due = 1360, interest_due = 1768, fee = 100
          //   total amount       = 4486
          //   target principal+interest = 4486 - 100 - 0 = 4386
          //   scale = 4386 / (1360 + 1768) = 1.4022
          //   displayed principal = 1360 * 1.4022 ≈ 1907  ✓
          //   displayed interest  = 1768 * 1.4022 ≈ 2479  ✓
          const piRaw = rawPrincipal + rawInterest;
          const target = amount - fee - penalty;
          if (piRaw > 0.01 && target > 0.01) {
            const scale = target / piRaw;
            const scaledPrincipal = Math.round(rawPrincipal * scale * 100) / 100;
            // Use subtraction to keep the sum exact (avoids 0.01 rounding
            // drift between principal+interest+fee and amount).
            const scaledInterest = Math.round((target - scaledPrincipal) * 100) / 100;
            principal = scaledPrincipal;
            interest = scaledInterest;
          }
        }

        // overpaidApplied: The amount carried over from the PREVIOUS period's overpayment.
        // We look up the sum of `overpaid_amount` from payments that closed period (P-1).
        // This avoids false positives where `amount < baseline` due to other reasons
        // (like API-side discounts or penalty adjustments).
        let overpaidApplied = 0;
        if (!isClosed && !paidInFullButZeroedByApi && periodNo > 1) {
          const periodMap = overpaidByContractPeriod.get(extId);
          if (periodMap) {
            overpaidApplied = periodMap.get(periodNo - 1) ?? 0;
          }
        }

        return {
          period: r.period ?? null,
          dueDate: r.due_date ?? null,
          principal,
          interest,
          fee,
          penalty,
          unlockFee,
          amount,
          paid,
          baselineAmount: baselineAmount ?? 0,
          overpaidApplied,
          // Legacy fields kept for export compatibility.
          principalDeducted: 0,
          interestDeducted: 0,
          feeDeducted: 0,
          isClosed,
          isSuspended,
          suspendLabel: isSuspended ? suspendLabel : null,
          suspendedAt: isSuspended ? suspendedAt : null,
          // isArrears: computed below after the map, via a second pass
          isArrears: false, // placeholder — overwritten in arrears pass
        };
      })
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    // --- Cumulative arrears pass ---
    // Walk periods in order. Accumulate unpaid balance (due - paid) from
    // PAST and CURRENT periods only (dueDate <= today). Future periods
    // (dueDate > today) receive carry = 0 and keep their original amounts.
    //
    // Business rules (2026-04-23 rev2):
    //   1. Carry = sum of (due - paid) for each sub-field across periods
    //      whose dueDate <= today.
    //   2. TXRTC close-out resets carry to 0 (customer settled everything).
    //   3. Closed/suspended periods are skipped.
    //   4. Future periods (dueDate > today) are NOT modified - carry is not
    //      applied and their unpaid balance is NOT added to carry.
    //   5. isArrears = true only when carry-in > 0 on a past/current period.
    {
      const todayMs = Date.now();
      let carryPrincipal = 0;
      let carryInterest = 0;
      let carryFee = 0;
      let carryPenalty = 0;
      let carryUnlockFee = 0;

      for (const inst of baseInstallments) {
        const p = inst.period ?? 0;

        // Reset carry if this period is at or after a TXRTC close-out.
        if (maxClosedPeriod > 0 && p === maxClosedPeriod + 1) {
          carryPrincipal = 0;
          carryInterest = 0;
          carryFee = 0;
          carryPenalty = 0;
          carryUnlockFee = 0;
        }

        // Determine if this period is past or current (dueDate <= today).
        const dueDateMs = inst.dueDate
          ? Date.parse(`${inst.dueDate}T00:00:00`)
          : 0;
        const isPastOrCurrent = dueDateMs > 0 && dueDateMs <= todayMs;

        if (isPastOrCurrent && !inst.isClosed && !inst.isSuspended) {
          // Apply carry-in to this period.
          const hasCarry =
            carryPrincipal > 0.005 ||
            carryInterest > 0.005 ||
            carryFee > 0.005 ||
            carryPenalty > 0.005 ||
            carryUnlockFee > 0.005;

          if (hasCarry) {
            inst.principal += carryPrincipal;
            inst.interest += carryInterest;
            inst.fee += carryFee;
            inst.penalty += carryPenalty;
            inst.unlockFee += carryUnlockFee;
            inst.amount += carryPrincipal + carryInterest + carryFee + carryPenalty + carryUnlockFee;
            inst.isArrears = true;
          }

          // Accumulate unpaid balance from this period into carry for next.
          const paidTotal = inst.paid;
          const dueTotal =
            (inst.principal - carryPrincipal) +
            (inst.interest - carryInterest) +
            (inst.fee - carryFee) +
            (inst.penalty - carryPenalty) +
            (inst.unlockFee - carryUnlockFee);
          if (dueTotal > 0.005) {
            const ratio = Math.max(0, Math.min(1, paidTotal / dueTotal));
            const basePrincipal = inst.principal - carryPrincipal;
            const baseInterest = inst.interest - carryInterest;
            const baseFee = inst.fee - carryFee;
            const basePenalty = inst.penalty - carryPenalty;
            const baseUnlockFee = inst.unlockFee - carryUnlockFee;
            carryPrincipal += Math.max(0, basePrincipal * (1 - ratio));
            carryInterest += Math.max(0, baseInterest * (1 - ratio));
            carryFee += Math.max(0, baseFee * (1 - ratio));
            carryPenalty += Math.max(0, basePenalty * (1 - ratio));
            carryUnlockFee += Math.max(0, baseUnlockFee * (1 - ratio));
          }
          // If dueTotal is 0 (API zeroed the period) - no new carry.
        }
        // Future periods (isPastOrCurrent = false): skip carry application
        // and skip carry accumulation. Their amounts stay as-is.
      }
    }

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

  // Per-contract walk (uses the exported assignPayPeriods helper above).
  const rows = baseRows.map((c) => {
    const rawPayments = payByContract.get(c.contractExternalId) ?? [];
    const tagged = assignPayPeriods(
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

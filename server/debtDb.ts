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
  skipPeriods?: Set<number>,
): Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }> {
  if (!payments.length) return [];
  const schedule = installmentList
    .filter((i) => i.period != null)
    .map((i) => ({ period: i.period as number, amount: Number(i.amount) || 0 }))
    .sort((a, b) => a.period - b.period);

  let cursor = 0;
  // Phase 58: Skip periods that are fully covered by carry-forward
  // Advance cursor past any skipped periods at the start
  if (skipPeriods && skipPeriods.size > 0) {
    while (cursor < schedule.length && skipPeriods.has(schedule[cursor].period)) {
      cursor += 1;
    }
  }
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
        // Phase 58: Skip carry periods during TXRTC cursor advancement
        while (cursor < schedule.length && skipPeriods?.has(schedule[cursor].period)) {
          cursor += 1;
        }
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
        // Phase 58: Skip carry periods during cursor advancement
        while (cursor < schedule.length && skipPeriods?.has(schedule[cursor].period)) {
          cursor += 1;
        }
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

/**
 * Deduplicate installments per period — keep the row with the most data.
 *
 * DB may have 2 rows per (contract_external_id, period) when the API returns
 * duplicate installment_ids or when the sync upsert key collides.
 * Strategy: for each period, keep the row that has the largest `amount` value
 * (or the first row if amounts are equal). This is idempotent and safe.
 */
function dedupInstByPeriod(list: InstRawRow[]): InstRawRow[] {
  if (list.length === 0) return list;
  const byPeriod = new Map<number | null, InstRawRow>();
  for (const row of list) {
    const p = row.period;
    const existing = byPeriod.get(p);
    if (!existing) {
      byPeriod.set(p, row);
    } else {
      // Keep row with larger amount (more complete data)
      const existingAmt = Number(existing.amount ?? 0);
      const rowAmt = Number(row.amount ?? 0);
      if (rowAmt > existingAmt) byPeriod.set(p, row);
    }
  }
  // Return sorted by period ascending
  return Array.from(byPeriod.values()).sort((a, b) => (a.period ?? 0) - (b.period ?? 0));
}

/**
 * Fix installments whose due_date is out-of-order relative to adjacent periods.
 *
 * Boonphone API occasionally sends a wrong due_date for a period (e.g. period 1
 * gets 2027-01-05 while period 2 is 2026-04-05).  This helper detects any
 * period N where due_date > due_date of period N+1 and recalculates it from
 * the due-day-of-month inferred from the nearest correct neighbour.
 *
 * The fix is applied in-memory only — the DB row is not modified, so the
 * correction is re-applied automatically on every query without being wiped by
 * future syncs.
 */
function fixOutOfOrderDueDates(list: InstRawRow[]): InstRawRow[] {
  if (list.length < 2) return list;
  // Work on a sorted copy (ascending period)
  const sorted = [...list].sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

  // Find the first pair where period N > period N+1
  let hasOutOfOrder = false;
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i].due_date;
    const next = sorted[i + 1].due_date;
    if (curr && next && curr > next) {
      hasOutOfOrder = true;
      break;
    }
  }
  if (!hasOutOfOrder) return list; // fast-path: nothing to fix

  // Derive due-day-of-month from the first "good" period (period 2 or later)
  // by looking for a period whose due_date is in ascending order with its successor.
  let dueDayOfMonth: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i].due_date;
    if (!d) continue;
    const parsed = new Date(`${d}T00:00:00`);
    if (!isNaN(parsed.getTime())) {
      dueDayOfMonth = parsed.getDate();
      break;
    }
  }
  if (!dueDayOfMonth) return list; // cannot infer day — leave as-is

  // Anchor strategy: find the SMALLEST valid due_date in the list and treat it
  // as the due_date for period 1.  Then rebuild every period as:
  //   period N due_date = anchor + (N - 1) months
  //
  // This handles the Boonphone API bug where multiple periods may have wrong
  // years (e.g. period 1 = 2027-01-05 and period 10 = 2026-12-05 when the
  // correct sequence should start at 2026-04-05).
  let anchorDate: Date | null = null;

  for (const row of sorted) {
    if (!row.due_date) continue;
    const d = new Date(`${row.due_date}T00:00:00`);
    if (isNaN(d.getTime())) continue;
    if (!anchorDate || d < anchorDate) {
      anchorDate = d;
    }
  }

  if (!anchorDate) return list;

  return sorted.map((row) => {
    if (row.period == null || !row.due_date) return row;
    const expected = new Date(anchorDate!);
    expected.setMonth(expected.getMonth() + (row.period - 1));
    expected.setDate(dueDayOfMonth!);
    const expectedStr = expected.toISOString().slice(0, 10);
    if (row.due_date !== expectedStr) {
      return { ...row, due_date: expectedStr };
    }
    return row;
  });
}

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
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           status,
           product_type,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date,
           CAST(commission_net AS DECIMAL(18,2)) AS commission_net
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
  `);
  const cRows: Array<any> = (contractRowsRaw as any)[0] ?? contractRowsRaw;

  // --- Load installments with sub-fields extracted from raw_json once ---
  // Both Boonphone and Fastfone365 use the same API fields:
  // installment_status_code, principal_due, interest_due, fee_due, penalty_due, unlock_fee_due
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

  // --- Dedup installments per period (DB may have 2 rows per period) ---
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, dedupInstByPeriod(list));
  }
  // --- Fix out-of-order due_dates (Boonphone API bug) ---
  // Apply in-memory correction for any contract whose installments have a
  // period N with due_date > period N+1.  This is idempotent and safe.
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, fixOutOfOrderDueDates(list));
  }

  // --- Detect "ปิดค่างวด" (customer settles ALL remaining periods at once).
  //
  // Phase 52 rule (2026-04-26): use the LAST period that has paid_amount > 0
  // (from installments, which is already loaded into instByContract) as the
  // "close period". Periods strictly AFTER that period render as "ปิดค่างวดแล้ว".
  // Only applies to contracts that have status = 'สิ้นสุดสัญญา' (i.e. have a TXRTC
  // close payment). Active/suspended contracts are NOT affected.
  const closedByContract = new Map<string, number>();
  const overpaidByContractPeriod = new Map<string, Map<number, number>>();
  // For bad-debt date derivation: every payment's paid_at per contract.
  const paidAtsByContract = new Map<string, string[]>();

  {
    // Load all payments: needed for (a) TXRTC close detection, (b) overpaid tracking,
    // (c) paidAts for bad-debt date derivation.
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

    // Pass 1: collect paidAts, TXRTC close markers, and overpaid per period.
    const closeDatesByContract = new Map<string, Date[]>();
    const normalPeriodsByContract = new Map<string, Set<number>>();

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
        // Regular single-period payment: period is the -N suffix after the contract suffix (-01/-02).
        // Phase 57 fix: use /-0\d-(\d+)/ to correctly extract period from receipts like
        // TXRT...-01-2-1 (period=2) instead of matching the last -N (which would give 1).
        const m = /-0\d-(\d+)/.exec(receipt);
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

    // Pass 2 (Phase 52 fix v2): for every contract that has at least one TXRTC payment,
    // derive the close period as the HIGHEST period from TXRT normal receipts (suffix -N).
    // Periods strictly AFTER this are rendered as "ปิดค่างวดแล้ว" with zero amounts.
    //
    // Rationale: TXRT-N receipts explicitly identify which periods were paid normally.
    // The max TXRT period = last normally-paid period. Everything after = lump-sum closed.
    // This correctly handles cases where installments.paid_amount is partial or
    // inconsistent due to API data quirks.
    for (const key of Array.from(closeDatesByContract.keys())) {
      const normalPeriods = normalPeriodsByContract.get(key);
      const maxNormalPeriod = normalPeriods && normalPeriods.size > 0
        ? Math.max(...Array.from(normalPeriods))
        : 0;
      closedByContract.set(key, maxNormalPeriod);
    }
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
    //
    // Suspend/bad-debt detection: same codes for both Boonphone and Fastfone365.
    const contractStatus = c.status ?? null;
    const isContractSuspended = contractStatus === "ระงับสัญญา";
    const isContractBadDebt = contractStatus === "หนี้เสีย";
    let suspendedFromPeriod = 0; // > 0 → periods >= this render as suspended
    let suspendedAt: string | null = null;
    if (isContractSuspended || isContractBadDebt) {
      // installment_status_code values that indicate a suspended/bad-debt installment.
      // Same for both Boonphone and Fastfone365.
      const suspendCodes = ["ระงับสัญญา", "หนี้เสีย"];
      const firstSuspended = list
        .filter((r) => suspendCodes.includes(r.installment_status_code ?? ""))
        .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
      if (firstSuspended?.period) {
        suspendedFromPeriod = Number(firstSuspended.period);
        suspendedAt = firstSuspended.due_date ?? null;
      } else {
        // Phase 9AK fallback: contract.status = "ระงับสัญญา" but no installment
        // has matching status code. Treat ALL periods as suspended starting from period 1.
        const firstPeriod = list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
        if (firstPeriod) {
          suspendedFromPeriod = 1;
          suspendedAt = firstPeriod.due_date ?? null;
        }
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

        // Bug 4 fix (Phase 9AA): use closedByContract.has() so contracts with
        // only TXRTC receipts (maxNormalPeriod=0) are also detected correctly.
        // When maxNormalPeriod=0, period > 0 is always true for any real period.
        // Phase 59 fix: use > (strictly after maxClosedPeriod) instead of >=.
        // maxClosedPeriod = max period from TXRT normal receipts (e.g. 5 if TXRT...-5 exists).
        // Periods WITH a TXRT receipt (including maxClosedPeriod itself) are paid normally
        // and must NOT be marked isClosed. Only periods AFTER maxClosedPeriod (no TXRT receipt)
        // are closed by the TXRTC lump-sum payment.
        // Guard maxClosedPeriod > 0 so contracts with no normal receipts are unaffected.
        // Phase 53: periodNo > 1 — งวดที่ 1 แสดงยอดตั้งหนี้ปกติเสมอ แม้ maxClosedPeriod=1
        const isClosed = closedByContract.has(extId) && maxClosedPeriod > 0 && periodNo > 1 && periodNo > maxClosedPeriod;
        // Phase 54: งวดที่ลูกค้าชำระเข้ามาแล้ว (paid > 0) ให้แสดงยอดปกติ
        // เฉพาะงวดที่ยังไม่มีการชำระเท่านั้นที่แสดงเป็นระงับสัญญา
        const isSuspended =
          !isClosed &&
          suspendedFromPeriod > 0 &&
          periodNo >= suspendedFromPeriod &&
          paid <= 0;
        const suspendLabel = isContractBadDebt ? "หนี้เสีย" : "ระงับสัญญา";
        // --- Compute display amount (non-closed periods) ---
        let amount = rawAmount;
        let principal = rawPrincipal;
        let interest = rawInterest;
        let fee = rawFee;
        let penalty = rawPenalty;
        let unlockFee = rawUnlockFee;

        // Case A: API sent amount=0 but paid>0 (classic zeroed-by-api case)
        const paidInFullButZeroedByApi =
          !isClosed &&
          rawAmount <= 0.009 &&
          paid > 0.009 &&
          baselineAmount != null &&
          baselineAmount > 0;
        // Case B (Phase 9AC): API sent amount < baseline AND paid >= amount
        // (customer paid the reduced amount in full, but we should display baseline
        // so the collections team sees the full monthly target, not the reduced amount).
        // Example: baseline=2830, API amount=350 (penalty only), paid=2830
        // → netBaseline = max(0, 350-350) = 0 → sub-fields all zero → wrong.
        // Fix: treat as paidInFull and restore baseline sub-fields.
        const paidInFullWithReducedAmount =
          !isClosed &&
          !paidInFullButZeroedByApi &&
          rawAmount > 0.009 &&
          baselineAmount != null &&
          baselineAmount > 0 &&
          rawAmount < baselineAmount - 0.5 && // API amount is significantly less than baseline
          paid >= rawAmount - 0.5;            // customer paid the reduced amount in full
        const useBaselineDisplay = paidInFullButZeroedByApi || paidInFullWithReducedAmount;

        // overpaidApplied:: ยอดชำระเกินจากงวดก่อนหน้า (P-1) ที่นำมาหักงวดนี้
        // Bug fix (Phase 9AB): overpaidApplied is sourced from raw_json.overpaid_amount
        // of the PREVIOUS period's payment row.
        //
        // Phase 9AF fix: Two sub-cases for useBaselineDisplay:
        //   A) paidInFullWithReducedAmount: API already reduced amount (e.g. 4097→3944).
        //      → Do NOT apply overpaidApplied again (would double-deduct).
        //   B) paidInFullButZeroedByApi: API zeroed amount because customer paid in full.
        //      → If previous period had overpaid, we MUST still apply the carry-forward
        //        because the API did NOT reduce the next period's amount in this case.
        //        Example: CT0226-SNI001-0978-01 period 1 overpaid=1010, period 2 amount=0
        //        (zeroed by API after payment), so we must show baseline-1010=980.
        let overpaidApplied = 0;
        if (!isClosed && periodNo > 1) {
          // Skip carry-forward only when API already reduced the amount (paidInFullWithReducedAmount)
          // For paidInFullButZeroedByApi, we still apply carry so baseline display is reduced.
          const skipCarry = paidInFullWithReducedAmount;
          if (!skipCarry) {
            const periodMap = overpaidByContractPeriod.get(extId);
            if (periodMap) {
              overpaidApplied = periodMap.get(periodNo - 1) ?? 0;
            }
          }
        }

        if (isClosed || isSuspended) {
          amount = 0;
          principal = 0;
          interest = 0;
          fee = 0;
          penalty = 0;
          unlockFee = 0;
        } else {
          // --- Phase 9X: Formula-based principal/interest + overpaid deduction + API penalty/unlockFee ---
          //
          // principal/interest/fee คำนวณจากสูตร:
          //   basePrincipal = ceil(finance_amount / installment_count)
          //   baseFee       = 100 (ตายตัวต่องวด)
          //   baseInterest  = baseline_amount - basePrincipal - baseFee
          //
          // ถ้างวดก่อนหน้าจ่ายเกิน (overpaidApplied > 0) ให้หักออกจากยอดงวดนี้:
          //   effectiveBaseline = max(0, baseline - overpaidApplied)
          //   แล้วปรับ principal/interest ตามสัดส่วน
          //
          // penalty/unlockFee ดึงจาก API *_due โดยตรง
          //
          // isArrears = มี penalty_due > 0 หรือ unlock_fee_due > 0

          const financeAmt = c.finance_amount != null ? Number(c.finance_amount) : 0;
          const periods = c.installment_count != null ? Number(c.installment_count) : 0;
          const baseline = baselineAmount ?? 0;

          // Step 1: Compute formula baseline sub-fields
          let basePrincipal: number;
          let baseFee: number;
          let baseInterest: number;
          if (financeAmt > 0 && periods > 0) {
            basePrincipal = Math.ceil(financeAmt / periods);
            baseFee = 100;
            baseInterest = Math.max(0, baseline - basePrincipal - baseFee);
          } else {
            // Fallback: ใช้ค่าจาก API *_due
            basePrincipal = rawPrincipal;
            baseFee = rawFee > 0 ? rawFee : 100;
            baseInterest = rawInterest;
          }

          // Step 2: Apply overpaid deduction from previous period
          // Phase 48: ลำดับการหัก ดอกเบี้ย → ค่าดำเนินการ → เงินต้น
          let effectiveInterest = baseInterest;
          let effectiveFee = baseFee;
          let effectivePrincipal = basePrincipal;
          if (overpaidApplied > 0.009) {
            let rem = overpaidApplied;
            // 1) หักดอกเบี้ยก่อน
            const dInt = Math.min(rem, effectiveInterest);
            effectiveInterest = Math.max(0, effectiveInterest - dInt);
            rem = Math.max(0, rem - dInt);
            // 2) หักค่าดำเนินการ
            const dFee = Math.min(rem, effectiveFee);
            effectiveFee = Math.max(0, effectiveFee - dFee);
            rem = Math.max(0, rem - dFee);
            // 3) หักเงินต้น
            effectivePrincipal = Math.max(0, effectivePrincipal - rem);
          }

          // Step 3: penalty/unlockFee from API *_due
          // Bug 3 fix (Phase 9AA): future periods (dueDate > today) must show 0
          // for penalty/unlockFee — API may send non-zero values for future periods
          // but they are not yet overdue charges.
          const dueDateForPenalty = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
          const isFuturePeriod = dueDateForPenalty > today.getTime();
          penalty   = isFuturePeriod ? 0 : rawPenalty;   // penalty_due
          unlockFee = isFuturePeriod ? 0 : rawUnlockFee; // unlock_fee_due

          // Step 4: Determine final amount and scale sub-fields to fit
          if (useBaselineDisplay) {
            // Paid in full (API zeroed amount OR API sent reduced amount): restore baseline
            // Use integer values (no scaling needed — baseline sub-fields are already integers)
            principal = basePrincipal;
            interest  = baseInterest;
            fee       = baseFee;
            amount    = baseline;
            // Phase 9AF: For paidInFullButZeroedByApi (NOT paidInFullWithReducedAmount),
            // the API did NOT reduce the next period's amount, so we must apply overpaidApplied
            // to show the correct reduced baseline. Example: period 2 baseline=1990, overpaid
            // carry from period 1=1010 → display 980 (not 1990).
            if (paidInFullButZeroedByApi && overpaidApplied > 0.009) {
              // Phase 48: Apply carry in order: interest → fee → principal
              principal = Math.round(effectivePrincipal);
              interest  = Math.round(effectiveInterest);
              fee       = Math.round(effectiveFee);
              amount    = principal + interest + fee;
            }
          } else {
            // Use API amount as source of truth (it already includes penalty+unlockFee)
            // Derive principal/interest/fee from formula scaled to fit (amount - penalty - unlockFee)
            const apiAmount = rawAmount > 0.009 ? rawAmount : null;
            const baselineForCalc = apiAmount != null ? apiAmount : baseline;
            const netBaseline = Math.max(0, baselineForCalc - penalty - unlockFee);

            // Scale formula sub-fields to fit netBaseline
            // Phase 48: ใช้ effective values (หัก overpaid แล้ว) ทั้ง 3 fields
            fee       = Math.round(effectiveFee);
            principal = Math.round(effectivePrincipal);
            interest  = Math.round(effectiveInterest);

            // Phase 24 fix: if API amount equals baseline (API did NOT reduce it for overpaid carry),
            // we must deduct overpaidApplied from the displayed amount so the UI shows the correct
            // reduced target. Example: CT0226-SBR001-0909-01 period 2: apiAmount=2094 (=baseline),
            // overpaidApplied=50 → display 2044 (not 2094).
            const apiEqualsBaseline = apiAmount != null && Math.abs(apiAmount - baseline) < 0.5;
            const applyCarryToAmount = overpaidApplied > 0.009 && apiEqualsBaseline;
            amount = apiAmount != null
              ? (applyCarryToAmount ? Math.max(0, apiAmount - overpaidApplied) : apiAmount)
              : principal + interest + fee + penalty + unlockFee;
          }

          // isArrears = มีค่าปรับหรือค่าปลดล็อก **เฉพาะงวดที่ผ่านมาแล้ว/ปัจจุบัน** (dueDate <= today)
          // งวดอนาคต: API อาจส่ง unlock_fee_due > 0 มาด้วย แต่ยังไม่ถึงกำหนดจึงไม่นับเป็นค้างชำระ
          const todayForArrears = new Date();
          todayForArrears.setHours(0, 0, 0, 0);
          const dueDateMs = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
          const isPastOrCurrent = dueDateMs <= todayForArrears.getTime();
          const hasArrears = isPastOrCurrent && (rawPenalty > 0.005 || rawUnlockFee > 0.005);
          (r as any)._hasArrears = hasArrears;
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
          // Phase 9AH: netAmount = principal+interest+fee only (no penalty/unlockFee).
          // Frontend uses this for principalOnly display so it never needs to subtract
          // penalty from amount (which may or may not include penalty depending on period).
          netAmount: principal + interest + fee,
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
          // isArrears: true when any *_due field > 0 (API-based, no carry pass needed)
          isArrears: (r as any)._hasArrears === true,
          // isCurrentPeriod: will be set to true for the current period in the arrears pass below
          isCurrentPeriod: false,
        };
      })
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    // --- Arrears pass (Phase 9Z) ---
    // กฎ:
    //   1. isArrears = เฉพาะ "งวดปัจจุบัน" เท่านั้น
    //      งวดปัจจุบัน = งวดแรก (period ต่ำสุด) ที่ dueDate <= today
    //                    และ paid < amount (ยังไม่จ่ายครบ)
    //                    และ !isClosed && !isSuspended
    //   2. penalty ของงวดปัจจุบัน = sum penalty ของทุกงวดที่ dueDate <= today
    //      (รวมค่าปรับคงค้างทุกงวดที่ผ่านมา)
    //   3. unlockFee ของงวดปัจจุบัน = max unlockFee ของทุกงวดที่ dueDate <= today
    //      (ค่าปลดล็อกไม่ทบ แต่ค้างข้ามงวดได้)
    {
      const todayMs = Date.now();
      // Reset all isArrears (was set per-period in map above, now we re-derive)
      for (const inst of baseInstallments) {
        inst.isArrears = false;
      }
      // Find the "current period": the LATEST (highest period no) past/current period
      // that is not closed/suspended.
      // Phase 14 fix: previously used .find() which returned the FIRST (lowest) unpaid period,
      // causing the highlight to stay on period 1 even when period 2 due_date had already passed.
      // Now we pick the period with the highest period number among all past/current periods,
      // regardless of paid status. Overdue earlier periods are shown as-is (no special highlight).
      const currentPeriod = baseInstallments
        .filter((inst) => {
          if (inst.isClosed || inst.isSuspended) return false;
          if (!inst.dueDate) return false;
          const dueMs = Date.parse(`${inst.dueDate}T00:00:00`);
          return dueMs <= todayMs; // past or today (not future)
        })
        .sort((a, b) => Number(b.period ?? 0) - Number(a.period ?? 0))[0] ?? null;
      if (currentPeriod) {
        const currentPeriodNo = Number(currentPeriod.period ?? 0);
        // Sum penalty from all past/current periods BEFORE currentPeriod (dueDate <= today)
        // Bug 1 fix (Phase 9AA): only count penalty from PRIOR periods, not currentPeriod itself.
        // This prevents period 1 from being flagged as isArrears when it only has its own penalty_due.
        const priorPenalty = baseInstallments.reduce((sum, inst) => {
          if (inst.isClosed || inst.isSuspended) return sum;
          if (!inst.dueDate) return sum;
          const dueMs = Date.parse(`${inst.dueDate}T00:00:00`);
          if (dueMs > todayMs) return sum;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return sum; // skip current+future
          return sum + Number(inst.penalty ?? 0);
        }, 0);
        // Max unlockFee from all prior past/current periods (ค่าปลดล็อกไม่ทบ)
        const priorUnlockFee = baseInstallments.reduce((max, inst) => {
          if (inst.isClosed || inst.isSuspended) return max;
          if (!inst.dueDate) return max;
          const dueMs = Date.parse(`${inst.dueDate}T00:00:00`);
          if (dueMs > todayMs) return max;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return max; // skip current+future
          return Math.max(max, Number(inst.unlockFee ?? 0));
        }, 0);
        // isArrears = true only when there are PRIOR periods with penalty/unlockFee
        // (i.e. carry from previous periods). If currentPeriod is period 1 with no
        // prior periods, isArrears = false even if it has its own penalty_due.
        const hasCarryFromPrior = priorPenalty > 0.005 || priorUnlockFee > 0.005;
        currentPeriod.isArrears = hasCarryFromPrior;
        // Total penalty = prior carry + currentPeriod's own penalty_due
        const ownPenalty = Number(currentPeriod.penalty ?? 0);
        const ownUnlockFee = Number(currentPeriod.unlockFee ?? 0);
        const totalPenalty = priorPenalty + ownPenalty;
        const totalUnlockFee = Math.max(priorUnlockFee, ownUnlockFee);
        currentPeriod.penalty = totalPenalty;
        currentPeriod.unlockFee = totalUnlockFee;
        // Recalculate amount for current period to include accumulated charges
        // Bug fix (Phase 9AB): when baseNet=0 (API sent amount=0 for an unpaid period),
        // fall back to baselineAmount so the total is not just penalty alone.
        // Phase 49 fix: do NOT fallback to baselineAmount when overpaidApplied > 0
        // because baseNet=0 in that case means overpaid covered all components (correct),
        // not that API sent 0 erroneously. Fallback only when overpaidApplied=0.
        const baseNet = currentPeriod.principal + currentPeriod.interest + currentPeriod.fee;
        const noOverpaid = (currentPeriod.overpaidApplied ?? 0) < 0.009;
        const effectiveBase = baseNet > 0.009
          ? baseNet
          : (noOverpaid && currentPeriod.baselineAmount > 0.009 ? currentPeriod.baselineAmount : baseNet);
        currentPeriod.amount = effectiveBase + totalPenalty + totalUnlockFee;
        // Phase 9AH: keep netAmount in sync (netAmount = principal+interest+fee, no penalty)
        currentPeriod.netAmount = effectiveBase;
        // Mark this as the current period for UI highlighting
        currentPeriod.isCurrentPeriod = true;
      }
    }

    return {
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      approveDate: c.approve_date ?? null,
      customerName: c.customer_name ?? null,
      phone: c.phone ?? null,
      productType: c.product_type ?? null,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : list.length,
      installmentAmount: c.installment_amount != null ? Number(c.installment_amount) : null,
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments: baseInstallments,
      // bad debt info from contracts table (used by listDebtCollected for tooltip + real payment filtering)
      contractBadDebtAmount: c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null,
      contractBadDebtDate: c.bad_debt_date ?? null,
      financeAmount: c.finance_amount != null ? Number(c.finance_amount) : null,
      commissionNet: c.commission_net != null ? Number(c.commission_net) : null,
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

  // Both Boonphone and Fastfone365 use the same payment transactions endpoint.
  // payment_transactions.raw_json contains the same fields for both sections.
  const payRowsRaw = await db.execute(sql`
    SELECT contract_external_id,
           external_id AS payment_external_id,
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
           NULL AS installment_external_id,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
           JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark,
           status AS ff_status
      FROM ${paymentTransactions}
     WHERE ${paymentTransactions.section} = ${params.section}
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
      period: null, // period is derived by assignPayPeriods for both Boonphone and FF365
      // payment_external_id: numeric string = real payment from API, "pay-{id}-{n}" = synthetic
      payment_external_id: r.payment_external_id ?? null,
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
      // FF365 only: raw status from payment_transactions
      ff_status: r.ff_status ?? null,
    } as any);
  }

  // Per-contract walk.
  // Both Boonphone and Fastfone365 use the same logic:
  //   - Use only real payments (external_id is numeric) from the API
  //   - Synthetic payments (pay-{id}-{n}) are excluded
  //   - bad_debt_amount from contracts table drives isBadDebtRow detection
  const rows = baseRows.map((c) => {
    const rawPayments = payByContract.get(c.contractExternalId) ?? [];
    let tagged: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }>;

    const contractBadDebtAmount = (c as any).contractBadDebtAmount as number | null;
    const contractBadDebtDate = (c as any).contractBadDebtDate as string | null;

    // Use only real payments from the API.
    // Real payments are identified by:
    //   1. Numeric payment_external_id (Boonphone/FF365 standard)
    //   2. TXRT receipt pattern (TXRT...-N) — FF365 contracts without numeric pay_ext_id
    // Synthetic payments (pay-{id}-{n}) are excluded.
    const realPaymentsRaw = rawPayments.filter((p) => {
      const payExtId = (p as any).payment_external_id as string | null;
      const receiptNo = (p as any).receipt_no as string | null;
      const isNumericPayExt = payExtId != null && /^\d+$/.test(payExtId);
      const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
      return isNumericPayExt || isTxrtReceipt;
    });

    if (contractBadDebtAmount != null && contractBadDebtAmount > 0 && contractBadDebtDate) {
      // Contract has bad debt: build tooltip and create 1 bad debt row.
      let badDebtNote: string | null = null;
      const d = new Date(`${contractBadDebtDate}T00:00:00`);
      const day = String(d.getDate()).padStart(2, "0");
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const year = d.getFullYear() + 543;
      badDebtNote = `ยอดขายเครื่อง ${contractBadDebtAmount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} บาท (${day}/${month}/${year})`;

      // Assign periods from real payments, excluding the device-sale payment
      // (total_paid ≈ bad_debt_amount, difference ≤ 1 baht).
      const realAssignedForBadDebt = assignPayPeriods(
        realPaymentsRaw,
        c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
      );
      const normalPayments = realAssignedForBadDebt.filter((p) => {
        const totalPaid = (p as any).total_paid_amount as number | null;
        const isDeviceSalePayment =
          totalPaid != null &&
          Math.abs(totalPaid - contractBadDebtAmount) <= 1;
        return !isDeviceSalePayment;
      });

      // Phase 56 (revised): badDebtPeriod = งวดที่มียอดขายเครื่อง
      // Priority 1: ใช้ receipt_no suffix ของ TXRT payment ที่ amount ≈ contractBadDebtAmount
      //   เช่น TXRT1225-SRI001-19817-01-2 → period = 2
      // Priority 2: fallback ใช้ period ที่ assignPayPeriods assign ให้
      // Priority 3: fallback ใช้ lastNormalPeriod+1
      let badDebtPeriod: number;
      {
        // Try receipt_no suffix first (most reliable)
        const deviceSaleRaw = realPaymentsRaw.find((p) => {
          const totalPaid = (p as any).total_paid_amount as number | null;
          return totalPaid != null && Math.abs(totalPaid - contractBadDebtAmount) <= 1;
        });
        const receiptNo = deviceSaleRaw ? String((deviceSaleRaw as any).receipt_no ?? '') : '';
        const suffixMatch = receiptNo.match(/-([1-9]\d*)$/);
        if (suffixMatch) {
          // receipt_no suffix is the most reliable period indicator
          badDebtPeriod = parseInt(suffixMatch[1], 10);
        } else {
          // Fallback: use period from assignPayPeriods
          const deviceSalePayment = realAssignedForBadDebt.find((p) => {
            const totalPaid = (p as any).total_paid_amount as number | null;
            return totalPaid != null && Math.abs(totalPaid - contractBadDebtAmount) <= 1;
          });
          if (deviceSalePayment?.period != null) {
            badDebtPeriod = deviceSalePayment.period;
          } else {
            // Final fallback: lastNormalPeriod+1
            let lastNormalPeriod = 0;
            for (const p of normalPayments) {
              if (p.period != null && p.period > lastNormalPeriod) lastNormalPeriod = p.period;
            }
            badDebtPeriod = lastNormalPeriod + 1;
          }
        }
      }
      // Phase 55/56: patch installments so periods < badDebtPeriod show normal amounts.
      // งวดที่ลูกค้าจ่ายปกติก่อนหนี้เสีย ให้ตั้งหนี้ตามปกติ
      // เฉพาะงวดที่ >= badDebtPeriod เท่านั้นที่แสดงเป็นหนี้เสีย
      c.installments = c.installments.map((inst: any) => {
        const pNo = inst.period ?? 0;
        if (pNo > 0 && pNo < badDebtPeriod && inst.isSuspended) {
          return { ...inst, isSuspended: false, suspendLabel: null, suspendedAt: null };
        }
        return inst;
      });

      const badDebtRow: any = {
        contract_external_id: c.contractExternalId,
        period: badDebtPeriod,
        splitIndex: 0,
        isCloseRow: false,
        isBadDebtRow: true,
        paid_at: contractBadDebtDate,
        principal_paid: 0,
        interest_paid: 0,
        fee_paid: 0,
        penalty_paid: 0,
        unlock_fee_paid: 0,
        discount_amount: 0,
        overpaid_amount: 0,
        close_installment_amount: 0,
        bad_debt_amount: contractBadDebtAmount,
        total_paid_amount: 0,
        payment_id: null,
        receipt_no: null,
        remark: null,
        ff_status: null,
        payment_external_id: null,
        badDebtNote,
      };

      tagged = [
        ...normalPayments.map((p) => ({ ...p, isBadDebtRow: false })),
        badDebtRow,
      ];
    } else {
      // No bad debt: use real payments only, assign periods normally.
      const realAssigned = assignPayPeriods(
        realPaymentsRaw,
        c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
      );
      tagged = realAssigned.map((p) => ({ ...p, isBadDebtRow: false }));
    }
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
        // tooltip สำหรับ bad debt rows: "ยอดขายเครื่อง X บาท (DD/MM/YYYY)"
        badDebtNote: (p as any).badDebtNote ?? null,
      })),
    };
  });

  // hasPrincipalBreakdown: true = both Boonphone and Fastfone365 now have full breakdown
  //   (principal_paid, interest_paid, fee_paid, penalty_paid, etc. from payment transactions API)
  return { rows, hasPrincipalBreakdown: true };
}

/**
 * Streaming variant of listDebtTarget.
 *
 * Phase 43: แก้ Cloudflare 100s hard timeout โดยส่ง rows ทีละ batch ระหว่างคำนวณ
 * แทนที่จะรอ compute ทั้งหมดก่อนส่ง
 *
 * Strategy:
 *   1. Load ALL DB data upfront (contracts + installments + payments) — 1 round-trip
 *   2. Process contracts ทีละ BATCH_SIZE แล้ว yield batch ทันที
 *   3. ใช้ setImmediate ระหว่าง batch เพื่อ yield event loop ให้ Express flush chunk
 *
 * Caller (debtStream.ts) ต้อง:
 *   - เขียน opening `{"rows":[` ก่อน iterate
 *   - เขียน `,` ระหว่าง rows
 *   - เขียน closing `]}` หลัง iterate เสร็จ
 */
export async function* listDebtTargetStream(params: {
  section: SectionKey;
  /** rows per yield (default 100) */
  batchSize?: number;
}): AsyncGenerator<any[], void, unknown> {
  const BATCH = params.batchSize ?? 100;
  const db = await getDb();
  if (!db) return;

  // --- Load contract headers ---
  const contractRowsRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           installment_count,
           installment_amount,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           status,
           product_type,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date,
           CAST(commission_net AS DECIMAL(18,2)) AS commission_net
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
       AND (status IS NULL OR status != 'ยกเลิกสัญญา')
  `);
  const cRows: Array<any> = (contractRowsRaw as any)[0] ?? contractRowsRaw;
  if (!cRows.length) return;

  // --- Load installments ---
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

  // --- Dedup installments per period (DB may have 2 rows per period) ---
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, dedupInstByPeriod(list));
  }
  // Fix out-of-order due_dates
  for (const [key, list] of Array.from(instByContract.entries())) {
    instByContract.set(key, fixOutOfOrderDueDates(list));
  }

  // --- Load payments (for close detection + paidAts) ---
  // Phase 52 rule: close period = last period with paid_amount > 0 in installments.
  const closedByContract = new Map<string, number>();
  // Phase 58: เก็บ { amount, paidAt } แทน number เพื่อใช้ carry-forward และ date ใน listDebtCollected
  const overpaidByContractPeriod = new Map<string, Map<number, { amount: number; paidAt: string | null }>>();
  const paidAtsByContract = new Map<string, string[]>();
  // Phase 56: device-sale period = period of TXRT payment whose amount ≈ bad_debt_amount
  const deviceSalePeriodByContract = new Map<string, number>();
  {
    const rawCloseData = await db.execute(sql`
      SELECT contract_external_id,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
             CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid_amount,
             CAST(amount AS DECIMAL(18,2)) AS amount,
             paid_at
        FROM ${paymentTransactions}
       WHERE ${paymentTransactions.section} = ${params.section}
         AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) IS NOT NULL
    `);
    const allPayRows: any[] = (rawCloseData as any)[0] ?? rawCloseData;
    const normalPeriodsByContract = new Map<string, Set<number>>();
    const closeDatesByContract = new Map<string, Date[]>();

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
        // Phase 57 fix: use /-0\d-(\d+)/ to correctly extract period from receipts like
        // TXRT...-01-2-1 (period=2) instead of matching the last -N (which would give 1).
        const m = /-0\d-(\d+)/.exec(receipt);
        if (!m) continue;
        const period = Number(m[1]);
        if (!Number.isFinite(period) || period <= 0) continue;
        const set = normalPeriodsByContract.get(key) ?? new Set<number>();
        set.add(period);
        normalPeriodsByContract.set(key, set);
        const overpaid = Number(pr.overpaid_amount ?? 0);
        if (overpaid > 0) {
          let periodMap = overpaidByContractPeriod.get(key);
          if (!periodMap) {
            periodMap = new Map<number, { amount: number; paidAt: string | null }>();
            overpaidByContractPeriod.set(key, periodMap);
          }
          const existing = periodMap.get(period);
          // Phase 58: accumulate overpaid amounts per period; keep earliest paidAt
          periodMap.set(period, {
            amount: (existing?.amount ?? 0) + overpaid,
            paidAt: existing?.paidAt ?? (pr.paid_at ? String(pr.paid_at) : null),
          });
        }
      }
    }

    // Phase 56: Build deviceSalePeriodByContract
    // A contract's device-sale period = period of the TXRT payment whose amount ≈ bad_debt_amount.
    // We use the receipt_no suffix (e.g. TXRT...-2 → period 2) as the most reliable indicator.
    // We need bad_debt_amount per contract — look it up from cRows.
    const badDebtAmountByContract = new Map<string, number>();
    for (const c of cRows) {
      if (c.bad_debt_amount != null && Number(c.bad_debt_amount) > 0) {
        badDebtAmountByContract.set(String(c.external_id), Number(c.bad_debt_amount));
      }
    }
    for (const pr of allPayRows) {
      const key = String(pr.contract_external_id ?? '');
      if (!key) continue;
      const badDebtAmt = badDebtAmountByContract.get(key);
      if (!badDebtAmt) continue;
      const payAmt = Number(pr.amount ?? 0);
      if (Math.abs(payAmt - badDebtAmt) > 1) continue; // not a device-sale payment
      const receipt = String(pr.receipt_no ?? '');
      const m = /-([1-9]\d*)$/.exec(receipt);
      if (!m) continue;
      const period = Number(m[1]);
      if (!Number.isFinite(period) || period <= 0) continue;
      // Keep the smallest period (earliest device-sale payment)
      const existing = deviceSalePeriodByContract.get(key);
      if (existing == null || period < existing) {
        deviceSalePeriodByContract.set(key, period);
      }
    }

    // Pass 2 (Phase 52 fix v2): close period = max period from TXRT normal receipts (suffix -N).
    // Periods strictly AFTER this are rendered as "ปิดค่างวดแล้ว" with zero amounts.
    //
    // Phase 60 fix: สัญญาที่มี overpaid carry pool (ชำระเกิน) จะมี carry periods ที่ถูก skip
    // ดังนั้น TXRT-N suffix จาก DB ไม่ตรงกับ period จริงๆ ที่ re-mapped
    // ตัวอย่าง: TXRT-3 อาจครอบคลุม period 5 จริงๆ (ถ้ามี 2 carry periods)
    // วิธีแก้: maxNormalPeriod = max(normalPeriods) + carryCount
    // โดย carryCount = floor(totalOverpaid / baselineAmount) ต่อ contract

    // Build baselineByContract map จาก cRows สำหรับใช้คำนวณ carryCount
    const baselineByContractForClose = new Map<string, number>();
    for (const c of cRows) {
      if (c.installment_amount != null && Number(c.installment_amount) > 0) {
        baselineByContractForClose.set(String(c.external_id), Number(c.installment_amount));
      }
    }

    for (const key of Array.from(closeDatesByContract.keys())) {
      const normalPeriods = normalPeriodsByContract.get(key);
      const rawMaxNormal = normalPeriods && normalPeriods.size > 0
        ? Math.max(...Array.from(normalPeriods))
        : 0;
      // Phase 60: คำนวณ carryCount จาก overpaid pool
      // carryCount = จำนวน periods ที่ถูก skip เพราะ carry pool ครอบคลุม
      let carryCount = 0;
      const periodMap = overpaidByContractPeriod.get(key);
      const baseline = baselineByContractForClose.get(key);
      if (periodMap && baseline && baseline > 0) {
        let totalOverpaid = 0;
        for (const [, entry] of Array.from(periodMap.entries())) {
          totalOverpaid += entry.amount;
        }
        carryCount = Math.floor(totalOverpaid / baseline);
      }
      const maxNormalPeriod = rawMaxNormal > 0 ? rawMaxNormal + carryCount : 0;
      closedByContract.set(key, maxNormalPeriod);
    }
  }

  const today = new Date();

  // --- Process contracts in batches, yield each batch ---
  // Reuse the same per-contract logic from listDebtTarget
  function processContract(c: any): any {
    const extId = String(c.external_id);
    const list = instByContract.get(extId) ?? [];
    const totalPaid = list.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0);
    const totalAmount = list.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const { label: debtStatus, daysOverdue } = deriveDebtStatus(c.status ?? null, list, today);
    const baselineAmount = c.installment_amount != null ? Number(c.installment_amount) : null;
    const maxClosedPeriod = closedByContract.get(extId) ?? 0;
    const contractStatus = c.status ?? null;
    const isContractSuspended = contractStatus === "ระงับสัญญา";
    const isContractBadDebt = contractStatus === "หนี้เสีย";
    let suspendedFromPeriod = 0;
    let suspendedAt: string | null = null;
    if (isContractSuspended || isContractBadDebt) {
      const suspendCodes = ["ระงับสัญญา", "หนี้เสีย"];
      const firstSuspended = list
        .filter((r) => suspendCodes.includes(r.installment_status_code ?? ""))
        .sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
      if (firstSuspended?.period) {
        suspendedFromPeriod = Number(firstSuspended.period);
        suspendedAt = firstSuspended.due_date ?? null;
      } else {
        const firstPeriod = list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0))[0];
        if (firstPeriod) {
          suspendedFromPeriod = 1;
          suspendedAt = firstPeriod.due_date ?? null;
        }
      }
      if (isContractBadDebt && suspendedAt) {
        const paidAts = paidAtsByContract.get(extId) ?? [];
        suspendedAt = deriveBadDebtDate(
          paidAts.map((t) => ({ paid_at: t })),
          suspendedAt,
        );
      }
    }

    // Phase 58: Pre-compute cumulative carry pool per period.
    // For each period N that has overpaid, carry forward to N+1, N+2, ... until pool is exhausted.
    // carryForPeriod[P] = { carryUsed: amount used to reduce period P, sourcePaidAt: date of payment }
    const carryForPeriod = new Map<number, { carryUsed: number; sourcePaidAt: string | null }>();
    {
      const periodMap = overpaidByContractPeriod.get(extId);
      if (periodMap && baselineAmount != null && baselineAmount > 0) {
        // Collect all overpaid entries sorted by period
        const overpaidEntries = Array.from(periodMap.entries()).sort((a, b) => a[0] - b[0]);
        // Build a sorted list of all installment periods for this contract
        const sortedPeriods = list
          .map((r) => r.period != null ? Number(r.period) : 0)
          .filter((p) => p > 0)
          .sort((a, b) => a - b);
        // For each overpaid source period, distribute carry to subsequent periods
        for (const [srcPeriod, { amount: overpaidAmt, paidAt: srcPaidAt }] of overpaidEntries) {
          let remainingCarry = overpaidAmt;
          for (const targetPeriod of sortedPeriods) {
            if (targetPeriod <= srcPeriod) continue; // only apply to periods AFTER source
            if (remainingCarry < 0.009) break;
            // Check if target period is isClosed or isSuspended — skip carry for those
            const targetInst = list.find((r) => Number(r.period) === targetPeriod);
            if (!targetInst) continue;
            const targetPaid = Number(targetInst.paid_amount ?? 0);
            const targetIsClosed = closedByContract.has(extId) && maxClosedPeriod > 0 && targetPeriod > 1 && targetPeriod > maxClosedPeriod;
            const targetIsSuspended = !targetIsClosed && suspendedFromPeriod > 0 && targetPeriod >= suspendedFromPeriod && targetPaid <= 0;
            if (targetIsClosed || targetIsSuspended) continue; // skip suspended/closed periods
            // Determine if this target period has paidInFullWithReducedAmount (API already reduced)
            const targetRawAmount = Number(targetInst.amount ?? 0);
            const targetPaidInFullWithReduced = !targetIsClosed &&
              targetRawAmount > 0.009 && baselineAmount > 0 &&
              targetRawAmount < baselineAmount - 0.5 && targetPaid >= targetRawAmount - 0.5;
            if (targetPaidInFullWithReduced) continue; // API already handled this, skip
            // Apply carry to this period
            const carryUsed = Math.min(remainingCarry, baselineAmount);
            const existing = carryForPeriod.get(targetPeriod);
            carryForPeriod.set(targetPeriod, {
              carryUsed: (existing?.carryUsed ?? 0) + carryUsed,
              sourcePaidAt: existing?.sourcePaidAt ?? srcPaidAt,
            });
            remainingCarry = Math.max(0, remainingCarry - carryUsed);
          }
        }
      }
    }

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
        // Phase 59 fix: use > (strictly after maxClosedPeriod) instead of >=.
        // See listDebtCollectedStream isClosed comment above for full rationale.
        const isClosed = closedByContract.has(extId) && maxClosedPeriod > 0 && periodNo > 1 && periodNo > maxClosedPeriod;
        // Phase 54: งวดที่ลูกค้าชำระเข้ามาแล้ว (paid > 0) ให้แสดงยอดปกติ
        const isSuspended = !isClosed && suspendedFromPeriod > 0 && periodNo >= suspendedFromPeriod && paid <= 0;
        const suspendLabel = isContractBadDebt ? "หนี้เสีย" : "ระงับสัญญา";
        let amount = rawAmount;
        let principal = rawPrincipal;
        let interest = rawInterest;
        let fee = rawFee;
        let penalty = rawPenalty;
        let unlockFee = rawUnlockFee;
        const paidInFullButZeroedByApi = !isClosed && rawAmount <= 0.009 && paid > 0.009 && baselineAmount != null && baselineAmount > 0;
        const paidInFullWithReducedAmount = !isClosed && !paidInFullButZeroedByApi && rawAmount > 0.009 && baselineAmount != null && baselineAmount > 0 && rawAmount < baselineAmount - 0.5 && paid >= rawAmount - 0.5;
        const useBaselineDisplay = paidInFullButZeroedByApi || paidInFullWithReducedAmount;
        // Phase 58: use cumulative carry pool instead of single-period lookup
        let overpaidApplied = 0;
        let overpaidCarryLabel: string | null = null; // label for UI: "(-หักชำระเกิน: xxx)"
        let overpaidSourceLabel: string | null = null; // label for UI: "(+ชำระเกิน: xxx)" at source period
        if (!isClosed && !isSuspended && periodNo > 0) {
          const skipCarry = paidInFullWithReducedAmount;
          if (!skipCarry) {
            const carryEntry = carryForPeriod.get(periodNo);
            if (carryEntry && carryEntry.carryUsed > 0.009) {
              overpaidApplied = carryEntry.carryUsed;
              overpaidCarryLabel = `(-หักชำระเกิน: ${Math.round(carryEntry.carryUsed).toLocaleString('th-TH')})`;
            }
          }
          // Check if THIS period is a source of overpaid carry (i.e. it generated overpaid)
          const periodMap = overpaidByContractPeriod.get(extId);
          if (periodMap) {
            const srcEntry = periodMap.get(periodNo);
            if (srcEntry && srcEntry.amount > 0.009) {
              overpaidSourceLabel = `(+ชำระเกิน: ${Math.round(srcEntry.amount).toLocaleString('th-TH')})`;
            }
          }
        }
        if (isClosed || isSuspended) {
          amount = 0; principal = 0; interest = 0; fee = 0; penalty = 0; unlockFee = 0;
        } else {
          const financeAmt = c.finance_amount != null ? Number(c.finance_amount) : 0;
          const periods = c.installment_count != null ? Number(c.installment_count) : 0;
          const baseline = baselineAmount ?? 0;
          let basePrincipal: number, baseFee: number, baseInterest: number;
          if (financeAmt > 0 && periods > 0) {
            basePrincipal = Math.ceil(financeAmt / periods);
            baseFee = 100;
            baseInterest = Math.max(0, baseline - basePrincipal - baseFee);
          } else {
            basePrincipal = rawPrincipal;
            baseFee = rawFee > 0 ? rawFee : 100;
            baseInterest = rawInterest;
          }

          // Phase 58 fix: ถ้า carry ครอบคลุมทั้งงวด (overpaidApplied >= baseline) ให้ force amount=0
          // งวดนี้ถูกหักจาก carry pool จนเป็น 0 — ไม่ต้องตั้งเป้าอีก
          // paid=0 และไม่ใช่ paidInFullWithReducedAmount (ไม่ใช่งวดที่ API ลดให้แล้ว)
          const isFullyCoveredByCarry = overpaidApplied > 0.009 && baseline > 0 && overpaidApplied >= baseline - 0.5 && paid < 0.009;
          if (isFullyCoveredByCarry) {
            // งวดถูกหักจนเป็น 0 — แสดง 0 ทั้งหมด
            amount = 0; principal = 0; interest = 0; fee = 0; penalty = 0; unlockFee = 0;
          } else {
            // Phase 48: ลำดับการหัก ดอกเบี้ย → ค่าดำเนินการ → เงินต้น
            let effectiveInterest = baseInterest;
            let effectiveFee = baseFee;
            let effectivePrincipal = basePrincipal;
            if (overpaidApplied > 0.009) {
              let rem = overpaidApplied;
              const dInt = Math.min(rem, effectiveInterest);
              effectiveInterest = Math.max(0, effectiveInterest - dInt);
              rem = Math.max(0, rem - dInt);
              const dFee = Math.min(rem, effectiveFee);
              effectiveFee = Math.max(0, effectiveFee - dFee);
              rem = Math.max(0, rem - dFee);
              effectivePrincipal = Math.max(0, effectivePrincipal - rem);
            }
            const dueDateForPenalty = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
            const isFuturePeriod = dueDateForPenalty > today.getTime();
            penalty = isFuturePeriod ? 0 : rawPenalty;
            unlockFee = isFuturePeriod ? 0 : rawUnlockFee;
            if (useBaselineDisplay) {
              principal = basePrincipal; interest = baseInterest; fee = baseFee; amount = baseline;
              if (paidInFullButZeroedByApi && overpaidApplied > 0.009) {
                // Phase 48: Apply carry in order: interest → fee → principal
                principal = Math.round(effectivePrincipal);
                interest = Math.round(effectiveInterest);
                fee = Math.round(effectiveFee);
                amount = principal + interest + fee;
              }
            } else {
              const apiAmount = rawAmount > 0.009 ? rawAmount : null;
              const apiEqualsBaseline = apiAmount != null && Math.abs(apiAmount - baseline) < 0.5;
              const applyCarryToAmount = overpaidApplied > 0.009 && apiEqualsBaseline;
              // Phase 48: ใช้ effective values (หัก overpaid แล้ว) ทั้ง 3 fields
              fee = Math.round(effectiveFee);
              principal = Math.round(effectivePrincipal);
              interest = Math.round(effectiveInterest);
              amount = apiAmount != null
                ? (applyCarryToAmount ? Math.max(0, apiAmount - overpaidApplied) : apiAmount)
                : principal + interest + fee + penalty + unlockFee;
            }
            const todayForArrears = new Date();
            todayForArrears.setHours(0, 0, 0, 0);
            const dueDateMs = r.due_date ? Date.parse(`${r.due_date}T00:00:00`) : 0;
            const isPastOrCurrent = dueDateMs <= todayForArrears.getTime();
            const hasArrears = isPastOrCurrent && (rawPenalty > 0.005 || rawUnlockFee > 0.005);
            (r as any)._hasArrears = hasArrears;
          }
          // isFullyCoveredByCarry: _hasArrears already false (amount=0, no penalty)
        }
        return {
          period: r.period ?? null, dueDate: r.due_date ?? null,
          principal, interest, fee, penalty, unlockFee, amount,
          netAmount: principal + interest + fee,
          paid, baselineAmount: baselineAmount ?? 0, overpaidApplied,
          // Phase 58: label for UI "งวดที่ถูกหักชำระเกิน"
          overpaidCarryLabel,
          principalDeducted: 0, interestDeducted: 0, feeDeducted: 0,
          isClosed, isSuspended,
          suspendLabel: isSuspended ? suspendLabel : null,
          suspendedAt: isSuspended ? suspendedAt : null,
          isArrears: (r as any)._hasArrears === true,
          isCurrentPeriod: false,
          // Phase 58: annotation for source period that generated overpaid carry
          overpaidSourceLabel,
        };
      })
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0));

    // Arrears pass
    {
      const todayMs = Date.now();
      for (const inst of baseInstallments) inst.isArrears = false;
      const currentPeriod = baseInstallments
        .filter((inst) => {
          if (inst.isClosed || inst.isSuspended) return false;
          if (!inst.dueDate) return false;
          return Date.parse(`${inst.dueDate}T00:00:00`) <= todayMs;
        })
        .sort((a, b) => Number(b.period ?? 0) - Number(a.period ?? 0))[0] ?? null;
      if (currentPeriod) {
        const currentPeriodNo = Number(currentPeriod.period ?? 0);
        const priorPenalty = baseInstallments.reduce((sum, inst) => {
          if (inst.isClosed || inst.isSuspended || !inst.dueDate) return sum;
          if (Date.parse(`${inst.dueDate}T00:00:00`) > todayMs) return sum;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return sum;
          return sum + Number(inst.penalty ?? 0);
        }, 0);
        const priorUnlockFee = baseInstallments.reduce((max, inst) => {
          if (inst.isClosed || inst.isSuspended || !inst.dueDate) return max;
          if (Date.parse(`${inst.dueDate}T00:00:00`) > todayMs) return max;
          if (Number(inst.period ?? 0) >= currentPeriodNo) return max;
          return Math.max(max, Number(inst.unlockFee ?? 0));
        }, 0);
        const hasCarryFromPrior = priorPenalty > 0.005 || priorUnlockFee > 0.005;
        currentPeriod.isArrears = hasCarryFromPrior;
        const ownPenalty = Number(currentPeriod.penalty ?? 0);
        const ownUnlockFee = Number(currentPeriod.unlockFee ?? 0);
        currentPeriod.penalty = priorPenalty + ownPenalty;
        currentPeriod.unlockFee = Math.max(priorUnlockFee, ownUnlockFee);
        const baseNet = currentPeriod.principal + currentPeriod.interest + currentPeriod.fee;
        // Phase 49 fix: do NOT fallback to baselineAmount when overpaidApplied > 0
        // because baseNet=0 means overpaid covered all components (correct), not API error.
        const noOverpaidS = (currentPeriod.overpaidApplied ?? 0) < 0.009;
        const effectiveBase = baseNet > 0.009
          ? baseNet
          : (noOverpaidS && currentPeriod.baselineAmount > 0.009 ? currentPeriod.baselineAmount : baseNet);
        currentPeriod.amount = effectiveBase + currentPeriod.penalty + currentPeriod.unlockFee;
        currentPeriod.netAmount = effectiveBase;
        currentPeriod.isCurrentPeriod = true;
      }
    }

    // Phase 56: patch installments for bad-debt contracts
    // กฎ: งวดที่มียอดขายเครื่อง (deviceSalePeriod) เป็นจุดตัด
    //   - งวดก่อน badDebtPeriod (งวด 1..badDebtPeriod-1) → แสดงยอดปกติ (isSuspended = false)
    //   - งวดตั้งแต่ badDebtPeriod เป็นต้นไป → หนี้เสีย (isSuspended = true, amount = 0)
    const contractBadDebtAmount = c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null;
    if (contractBadDebtAmount != null && contractBadDebtAmount > 0 && isContractBadDebt) {
      const badDebtPeriod = deviceSalePeriodByContract.get(extId) ?? null;
      if (badDebtPeriod != null) {
        const suspendLabel = 'หนี้เสีย';
        const financeAmt = c.finance_amount != null ? Number(c.finance_amount) : 0;
        const periods = c.installment_count != null ? Number(c.installment_count) : 0;
        const baseline = c.installment_amount != null ? Number(c.installment_amount) : 0;
        for (const inst of baseInstallments) {
          const pNo = Number(inst.period ?? 0);
          if (pNo <= 0) continue;
          if (pNo < badDebtPeriod) {
            // งวดก่อน badDebtPeriod → ปกติ (ยกเลิก isSuspended ถ้ามี)
            if (inst.isSuspended) {
              inst.isSuspended = false;
              inst.suspendLabel = null;
              inst.suspendedAt = null;
              // Restore amounts from raw installment data
              const rawInst = list.find((r) => Number(r.period) === pNo);
              if (rawInst) {
                const rawAmount = Number(rawInst.amount ?? 0);
                const rawPrincipal = Number(rawInst.principal_due ?? 0);
                const rawInterest = Number(rawInst.interest_due ?? 0);
                const rawFee = Number(rawInst.fee_due ?? 0);
                if (financeAmt > 0 && periods > 0) {
                  inst.principal = Math.ceil(financeAmt / periods);
                  inst.fee = 100;
                  inst.interest = Math.max(0, baseline - inst.principal - inst.fee);
                  inst.amount = baseline;
                  inst.netAmount = inst.principal + inst.interest + inst.fee;
                } else if (rawAmount > 0.009) {
                  inst.principal = rawPrincipal > 0 ? rawPrincipal : inst.principal;
                  inst.interest = rawInterest > 0 ? rawInterest : inst.interest;
                  inst.fee = rawFee > 0 ? rawFee : inst.fee;
                  inst.amount = rawAmount;
                  inst.netAmount = inst.principal + inst.interest + inst.fee;
                }
              }
            }
          } else {
            // งวดตั้งแต่ badDebtPeriod เป็นต้นไป → หนี้เสีย (force isSuspended=true)
            if (!inst.isClosed) {
              inst.isSuspended = true;
              inst.suspendLabel = suspendLabel;
              inst.suspendedAt = inst.suspendedAt ?? inst.dueDate ?? null;
              inst.principal = 0; inst.interest = 0; inst.fee = 0;
              inst.penalty = 0; inst.unlockFee = 0;
              inst.amount = 0; inst.netAmount = 0;
              inst.isCurrentPeriod = false;
            }
          }
        }
      }
    }

    return {
      contractExternalId: extId,
      contractNo: c.contract_no ?? null,
      approveDate: c.approve_date ?? null,
      customerName: c.customer_name ?? null,
      phone: c.phone ?? null,
      productType: c.product_type ?? null,
      installmentCount: c.installment_count != null ? Number(c.installment_count) : list.length,
      installmentAmount: c.installment_amount != null ? Number(c.installment_amount) : null,
      totalAmount, totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus, daysOverdue,
      installments: baseInstallments,
      contractBadDebtAmount: c.bad_debt_amount != null ? Number(c.bad_debt_amount) : null,
      contractBadDebtDate: c.bad_debt_date ?? null,
      financeAmount: c.finance_amount != null ? Number(c.finance_amount) : null,
      commissionNet: c.commission_net != null ? Number(c.commission_net) : null,
    };
  }

  // Yield in batches
  let batch: any[] = [];
  for (const c of cRows) {
    batch.push(processContract(c));
    if (batch.length >= BATCH) {
      yield batch;
      batch = [];
      // Yield event loop so Express can flush the chunk
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (batch.length > 0) yield batch;
}

/**
 * Streaming variant of listDebtCollected.
 * Loads target rows first (via listDebtTargetStream), then streams collected rows.
 */
export async function* listDebtCollectedStream(params: {
  section: SectionKey;
  batchSize?: number;
}): AsyncGenerator<{ rows: any[]; meta?: Record<string, unknown> }, void, unknown> {
  const CONTRACT_BATCH = 500; // contracts per DB query batch (keeps memory low)
  const YIELD_BATCH = params.batchSize ?? 100; // rows per HTTP chunk
  const today = new Date(); // used by deriveDebtStatus

  const db = await getDb();
  if (!db) return;

  // Step 1: Load only contract headers (no installments) — small payload
  const contractHeadersRaw = await db.execute(sql`
    SELECT external_id,
           contract_no,
           approve_date,
           customer_name,
           phone,
           installment_count,
           CAST(installment_amount AS DECIMAL(18,2)) AS installment_amount,
           CAST(finance_amount AS DECIMAL(18,2)) AS finance_amount,
           status,
           product_type,
           CAST(bad_debt_amount AS DECIMAL(18,2)) AS bad_debt_amount,
           bad_debt_date
      FROM ${contracts}
     WHERE ${contracts.section} = ${params.section}
       AND (status IS NULL OR status != 'ยกเลิกสัญญา')
     ORDER BY external_id
  `);
  const allContractHeaders: any[] = (contractHeadersRaw as any)[0] ?? contractHeadersRaw;
  if (!allContractHeaders.length) return;

  // Step 2 + 3: Process contracts in batches — query BOTH installments AND payments per batch.
  // This avoids loading ALL 222K payment rows into memory at once (which caused OOM/503 in production).
  // Per-batch: ~100 contracts × ~15 payments = ~1,500 payment rows per query (~1MB) vs ~150MB for all.
  let yieldBatch: any[] = [];
  for (let batchStart = 0; batchStart < allContractHeaders.length; batchStart += CONTRACT_BATCH) {
    const contractBatch = allContractHeaders.slice(batchStart, batchStart + CONTRACT_BATCH);
    const batchIds = contractBatch.map((c: any) => String(c.external_id));
    // Build safe IN clause (IDs are numeric strings from the API)
    const batchIdsLiteral = batchIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
    const sectionLiteral = params.section.replace(/'/g, "''");

    // Query installments for this batch only (installments are smaller, per-batch is fine)
    // Include due_date and paid_amount for deriveDebtStatus calculation
    const instRaw = await db.execute(sql.raw(`
      SELECT contract_external_id,
             period,
             CAST(amount AS DECIMAL(18,2)) AS amount,
             due_date,
             CAST(paid_amount AS DECIMAL(18,2)) AS paid_amount
        FROM installments
       WHERE section = '${sectionLiteral}'
         AND contract_external_id IN (${batchIdsLiteral})
       ORDER BY contract_external_id, period
    `));
    const instRows: any[] = (instRaw as any)[0] ?? instRaw;
    const instByContractRaw = new Map<string, Array<{ period: number | null; amount: number; due_date: string | null; paid_amount: number | null }>>();
    for (const r of instRows) {
      const key = String(r.contract_external_id ?? "");
      if (!instByContractRaw.has(key)) instByContractRaw.set(key, []);
      instByContractRaw.get(key)!.push({
        period: r.period != null ? Number(r.period) : null,
        amount: r.amount != null ? Number(r.amount) : 0,
        due_date: r.due_date ?? null,
        paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
      });
    }
    // Dedup per period (DB may have 2 rows per period)
    const instByContract = new Map<string, Array<{ period: number | null; amount: number; due_date: string | null; paid_amount: number | null }>>();
    for (const [key, list] of Array.from(instByContractRaw.entries())) {
      const byPeriod = new Map<number | null, { period: number | null; amount: number; due_date: string | null; paid_amount: number | null }>();
      for (const row of list) {
        const p = row.period;
        const existing = byPeriod.get(p);
        if (!existing || row.amount > existing.amount) byPeriod.set(p, row);
      }
      instByContract.set(key, Array.from(byPeriod.values()).sort((a, b) => (a.period ?? 0) - (b.period ?? 0)));
    }

    // Query payments for this batch only (per-batch to avoid OOM with 222K rows)
    const payRaw = await db.execute(sql.raw(`
      SELECT contract_external_id,
             external_id AS payment_external_id,
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
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.remark'))     AS remark,
             status AS ff_status
        FROM payment_transactions
       WHERE section = '${sectionLiteral}'
         AND contract_external_id IN (${batchIdsLiteral})
       ORDER BY contract_external_id, paid_at, payment_id
    `));
    const payRows: any[] = (payRaw as any)[0] ?? payRaw;
    const batchPayByContract = new Map<string, PayRawRow[]>();
    for (const r of payRows) {
      const key = String(r.contract_external_id ?? "");
      if (!key) continue;
      if (!batchPayByContract.has(key)) batchPayByContract.set(key, []);
      batchPayByContract.get(key)!.push({
        contract_external_id: key,
        period: null,
        payment_external_id: r.payment_external_id ?? null,
        paid_at: r.paid_at ?? null,
        total_paid_amount: r.total_paid_amount != null ? Number(r.total_paid_amount) : null,
        principal_paid: r.principal_paid != null ? Number(r.principal_paid) : null,
        interest_paid: r.interest_paid != null ? Number(r.interest_paid) : null,
        fee_paid: r.fee_paid != null ? Number(r.fee_paid) : null,
        penalty_paid: r.penalty_paid != null ? Number(r.penalty_paid) : null,
        unlock_fee_paid: r.unlock_fee_paid != null ? Number(r.unlock_fee_paid) : null,
        discount_amount: r.discount_amount != null ? Number(r.discount_amount) : null,
        overpaid_amount: r.overpaid_amount != null ? Number(r.overpaid_amount) : null,
        close_installment_amount: r.close_installment_amount != null ? Number(r.close_installment_amount) : null,
        bad_debt_amount: r.bad_debt_amount != null ? Number(r.bad_debt_amount) : null,
        payment_id: r.payment_id != null ? Number(r.payment_id) : null,
        receipt_no: r.receipt_no ?? null,
        remark: r.remark ?? null,
        ff_status: r.ff_status ?? null,
      } as any);
    }

    // Process each contract in this batch
    for (const ch of contractBatch) {
      const extId = String(ch.external_id);
      // Build a contract object compatible with what listDebtTargetStream returns
      const instList = instByContract.get(extId) ?? [];
      // Compute totalAmount (sum of installment amounts) and totalPaid (sum of paid_amount)
      const totalAmount = instList.reduce((s, i) => s + (i.amount ?? 0), 0);
      const totalPaid = instList.reduce((s, i) => s + (i.paid_amount ?? 0), 0);
      // Derive debtStatus using contract status + installment due_date/paid_amount
      const instForStatus: InstRawRow[] = instList.map((i) => ({
        contract_external_id: extId,
        period: i.period,
        due_date: i.due_date,
        amount: i.amount,
        paid_amount: i.paid_amount,
        inst_status: null,
        principal_due: null,
        interest_due: null,
        fee_due: null,
        penalty_due: null,
        unlock_fee_due: null,
        installment_status_code: null,
      }));
      const { label: debtStatus, daysOverdue } = deriveDebtStatus(ch.status ?? null, instForStatus, today);
      const c = {
        contractExternalId: extId,
        contractNo: ch.contract_no ?? null,
        approveDate: ch.approve_date ?? null,
        customerName: ch.customer_name ?? null,
        phone: ch.phone ?? null,
        productType: ch.product_type ?? null,
        installmentCount: ch.installment_count != null ? Number(ch.installment_count) : null,
        installmentAmount: ch.installment_amount != null ? Number(ch.installment_amount) : null,
        financeAmount: ch.finance_amount != null ? Number(ch.finance_amount) : null,
        status: ch.status ?? null,
        totalAmount,
        totalPaid,
        remaining: Math.max(totalAmount - totalPaid, 0),
        debtStatus,
        daysOverdue,
        contractBadDebtAmount: ch.bad_debt_amount != null ? Number(ch.bad_debt_amount) : null,
        contractBadDebtDate: ch.bad_debt_date ?? null,
        installments: instList,
      };
      // Use per-batch payments Map (loaded per batch to avoid OOM)
      const rawPayments = batchPayByContract.get(extId) ?? [];
      const contractBadDebtAmount = c.contractBadDebtAmount as number | null;
      const contractBadDebtDate = c.contractBadDebtDate as string | null;
      // Real payments: numeric pay_ext_id OR TXRT receipt pattern
      const realPaymentsRaw = rawPayments.filter((p) => {
        const payExtId = (p as any).payment_external_id as string | null;
        const receiptNo = (p as any).receipt_no as string | null;
        const isNumericPayExt = payExtId != null && /^\d+$/.test(payExtId);
        const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(receiptNo);
        return isNumericPayExt || isTxrtReceipt;
      });
      // Phase 58: Pre-compute cumulative carry pool for listDebtCollected
      // งวดที่ถูกหักจนเป็น 0 → บันทึกวันที่ของ payment ที่มี overpaid (ไม่ใช่วันที่ครบกำหนด)
      const baselineAmountForCarry = c.installmentAmount;
      const overpaidCarryRows: Array<{ period: number; paidAt: string | null; carryUsed: number }> = [];
      if (baselineAmountForCarry != null && baselineAmountForCarry > 0) {
        // Build overpaid map from realPaymentsRaw (before bad-debt filtering)
        // Use receipt_no suffix to determine period
        const overpaidByPeriodLocal = new Map<number, { amount: number; paidAt: string | null }>();
        for (const p of rawPayments) {
          const receiptNo = (p as any).receipt_no as string | null;
          const overpaidAmt = (p as any).overpaid_amount as number | null;
          if (!receiptNo || !overpaidAmt || overpaidAmt <= 0) continue;
          // Phase 57 fix: use /-0\d-(\d+)/ to correctly extract period
          const m = /-0\d-(\d+)/.exec(receiptNo);
          if (!m) continue;
          const period = Number(m[1]);
          if (!Number.isFinite(period) || period <= 0) continue;
          const existing = overpaidByPeriodLocal.get(period);
          overpaidByPeriodLocal.set(period, {
            amount: (existing?.amount ?? 0) + overpaidAmt,
            paidAt: existing?.paidAt ?? ((p as any).paid_at ? String((p as any).paid_at) : null),
          });
        }
        if (overpaidByPeriodLocal.size > 0) {
          const sortedPeriods = instList
            .map((i) => i.period != null ? Number(i.period) : 0)
            .filter((p) => p > 0)
            .sort((a, b) => a - b);
          const overpaidEntries = Array.from(overpaidByPeriodLocal.entries()).sort((a, b) => a[0] - b[0]);
          for (const [srcPeriod, { amount: overpaidAmt, paidAt: srcPaidAt }] of overpaidEntries) {
            let remainingCarry = overpaidAmt;
            for (const targetPeriod of sortedPeriods) {
              if (targetPeriod <= srcPeriod) continue;
              if (remainingCarry < 0.009) break;
              // Phase 58 fix: Always distribute carry to next periods regardless of paid_amount
              // (API paid_amount reflects actual payments, not carry-adjusted)
              // assignPayPeriods will skip these periods via skipPeriods set
              const targetInst = instList.find((i) => Number(i.period) === targetPeriod);
              if (!targetInst) continue;
              const carryUsed = Math.min(remainingCarry, baselineAmountForCarry);
              if (carryUsed < 0.009) break; // carry exhausted, stop
              overpaidCarryRows.push({ period: targetPeriod, paidAt: srcPaidAt, carryUsed });
              remainingCarry = Math.max(0, remainingCarry - carryUsed);
            }
          }
        }
      }

      // Phase 58: Build skipPeriods set from overpaidCarryRows
      const skipPeriods = new Set<number>(overpaidCarryRows.map((cr) => cr.period));

      let tagged: Array<PayRawRow & { splitIndex: number; isCloseRow: boolean; isBadDebtRow: boolean }>;
      if (contractBadDebtAmount != null && contractBadDebtAmount > 0 && contractBadDebtDate) {
        let badDebtNote: string | null = null;
        const d = new Date(`${contractBadDebtDate}T00:00:00`);
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear() + 543;
        badDebtNote = `ยอดขายเครื่อง ${contractBadDebtAmount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} บาท (${day}/${month}/${year})`;
        const realAssignedForBadDebt = assignPayPeriods(
          realPaymentsRaw,
          c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
          skipPeriods,
        );
        const normalPayments = realAssignedForBadDebt.filter((p) => {
          const totalPaid = (p as any).total_paid_amount as number | null;
          return !(totalPaid != null && Math.abs(totalPaid - contractBadDebtAmount) <= 1);
        });
        // Phase 56 (revised): badDebtPeriod = งวดที่มียอดขายเครื่อง
        // Priority 1: ใช้ receipt_no suffix ของ TXRT payment ที่ amount ≈ contractBadDebtAmount
        //   เช่น TXRT1225-SRI001-19817-01-2 → period = 2
        // Priority 2: fallback ใช้ period ที่ assignPayPeriods assign ให้
        // Priority 3: fallback ใช้ lastNormalPeriod+1
        let badDebtPeriod: number;
        {
          // Try receipt_no suffix first (most reliable)
          const deviceSaleRaw = realPaymentsRaw.find((p) => {
            const totalPaid = (p as any).total_paid_amount as number | null;
            return totalPaid != null && Math.abs(totalPaid - contractBadDebtAmount) <= 1;
          });
          const receiptNo = deviceSaleRaw ? String((deviceSaleRaw as any).receipt_no ?? '') : '';
          const suffixMatch = receiptNo.match(/-([1-9]\d*)$/);
          if (suffixMatch) {
            // receipt_no suffix is the most reliable period indicator
            badDebtPeriod = parseInt(suffixMatch[1], 10);
          } else {
            // Fallback: use period from assignPayPeriods
            const deviceSalePayment = realAssignedForBadDebt.find((p) => {
              const totalPaid = (p as any).total_paid_amount as number | null;
              return totalPaid != null && Math.abs(totalPaid - contractBadDebtAmount) <= 1;
            });
            if (deviceSalePayment?.period != null) {
              badDebtPeriod = deviceSalePayment.period;
            } else {
              // Final fallback: lastNormalPeriod+1
              let lastNormalPeriod = 0;
              for (const p of normalPayments) {
                if (p.period != null && p.period > lastNormalPeriod) lastNormalPeriod = p.period;
              }
              badDebtPeriod = lastNormalPeriod + 1;
            }
          }
        }
        // Phase 55/56: patch installments so periods < badDebtPeriod show normal amounts.
        c.installments = c.installments.map((inst: any) => {
          const pNo = inst.period ?? 0;
          if (pNo > 0 && pNo < badDebtPeriod && inst.isSuspended) {
            return { ...inst, isSuspended: false, suspendLabel: null, suspendedAt: null };
          }
          return inst;
        });
        const badDebtRow: any = {
          contract_external_id: c.contractExternalId,
          period: badDebtPeriod, splitIndex: 0, isCloseRow: false, isBadDebtRow: true,
          paid_at: contractBadDebtDate, principal_paid: 0, interest_paid: 0, fee_paid: 0,
          penalty_paid: 0, unlock_fee_paid: 0, discount_amount: 0, overpaid_amount: 0,
          close_installment_amount: 0, bad_debt_amount: contractBadDebtAmount,
          total_paid_amount: 0, payment_id: null, receipt_no: null, remark: null,
          ff_status: null, payment_external_id: null, badDebtNote,
        };
        tagged = [...normalPayments.map((p) => ({ ...p, isBadDebtRow: false })), badDebtRow];
      } else {
        const realAssigned = assignPayPeriods(
          realPaymentsRaw,
          c.installments.map((i: { period: number | null; amount: number | string }) => ({ period: i.period, amount: Number(i.amount) || 0 })),
          skipPeriods,
        );
        tagged = realAssigned.map((p) => ({ ...p, isBadDebtRow: false }));
      }
      // Phase 58: Merge overpaidCarryRows into payments
      // งวดที่ถูกหักจนเป็น 0 → เพิ่ม row พิเศษ isOverpaidCarryRow=true เพื่อให้ frontend แสดงวันที่และยอด 0
      const overpaidCarryPayments = overpaidCarryRows
        .filter((cr) => {
          // Only add carry row if there's no existing payment for this period in tagged
          const existingForPeriod = tagged.find((t) => t.period === cr.period);
          return !existingForPeriod;
        })
        .map((cr) => ({
          period: cr.period,
          splitIndex: 0,
          isCloseRow: false,
          isBadDebtRow: false,
          isOverpaidCarryRow: true,
          paidAt: cr.paidAt,
          principal: 0, interest: 0, fee: 0, penalty: 0, unlockFee: 0,
          discount: 0, overpaid: 0,
          closeInstallmentAmount: 0, badDebt: 0,
          total: 0,
          receiptNo: null, remark: null, badDebtNote: null,
          overpaidCarryUsed: cr.carryUsed,
        }));
      const row = {
        ...c,
        payments: [
          ...tagged.map((p) => ({
            period: p.period ?? null, splitIndex: p.splitIndex, isCloseRow: p.isCloseRow, isBadDebtRow: p.isBadDebtRow,
            isOverpaidCarryRow: false,
            paidAt: p.paid_at, principal: p.principal_paid ?? 0, interest: p.interest_paid ?? 0,
            fee: p.fee_paid ?? 0, penalty: p.penalty_paid ?? 0, unlockFee: p.unlock_fee_paid ?? 0,
            discount: p.discount_amount ?? 0, overpaid: p.overpaid_amount ?? 0,
            closeInstallmentAmount: p.close_installment_amount ?? 0, badDebt: p.bad_debt_amount ?? 0,
            total: p.total_paid_amount ?? 0, receiptNo: p.receipt_no ?? null, remark: p.remark ?? null,
            badDebtNote: (p as any).badDebtNote ?? null,
            overpaidCarryUsed: 0,
          })),
          ...overpaidCarryPayments,
        ].sort((a, b) => (a.period ?? 0) - (b.period ?? 0)),
      };
      yieldBatch.push(row);
      if (yieldBatch.length >= YIELD_BATCH) {
        yield { rows: yieldBatch, meta: { hasPrincipalBreakdown: true } };
        yieldBatch = [];
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } // end for contractBatch
  } // end for batchStart
  if (yieldBatch.length > 0) {
    yield { rows: yieldBatch, meta: { hasPrincipalBreakdown: true } };
  }
}

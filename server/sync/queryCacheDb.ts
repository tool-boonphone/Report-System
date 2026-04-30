/**
 * queryCacheDb.ts — Query debt cache tables and re-assemble into frontend-ready shapes.
 *
 * Instead of running the full listDebtTargetStream / listDebtCollectedStream pipeline
 * (which takes 60–120s for Fastfone365), this module reads from the pre-populated
 * debt_target_cache / debt_collected_cache tables and re-assembles the rows into the
 * exact TargetRow / CollectedRow shapes that DebtReport.tsx expects.
 *
 * Performance:
 *   - SELECT from indexed cache tables: ~1–3s for 170k rows
 *   - No raw_json parsing, no complex business logic at query time
 *   - daysOverdue is re-derived from cached dueDate/paidAmount/totalAmount (fast)
 *
 * Limitations vs full stream:
 *   - phone: fetched via JOIN with contracts table (single query)
 *   - suspendedAt: null (not stored in cache)
 *   - splitIndex / isCloseRow / closeInstallmentAmount / badDebtNote: default values
 *     (these are derived from complex payment-splitting logic not stored in cache)
 *
 * Usage:
 *   import { streamTargetFromCache, streamCollectedFromCache } from "./queryCacheDb";
 *   // Replace listDebtTargetStream / listDebtCollectedStream in debtStream.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import type { SectionKey } from "../../shared/const";

// ─── Constants ────────────────────────────────────────────────────────────────
const TERMINAL_STATUSES = new Set(["ระงับสัญญา", "สิ้นสุดสัญญา", "หนี้เสีย"]);

function bucketFromDays(days: number): string {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

/**
 * Re-derive daysOverdue from cached installment rows.
 * Mirrors the logic in deriveDebtStatus() in debtDb.ts.
 */
function rederiveDaysOverdue(
  contractStatus: string | null,
  instRows: Array<{ dueDate: string | null; totalAmount: string; paidAmount: string; isClosed: boolean; isSuspended: boolean }>,
  today: Date,
): { debtStatus: string; daysOverdue: number } {
  if (contractStatus && TERMINAL_STATUSES.has(contractStatus)) {
    return { debtStatus: contractStatus, daysOverdue: 0 };
  }
  const todayMs = today.getTime();
  let maxDays = 0;
  for (const it of instRows) {
    if (it.isClosed || it.isSuspended) continue;
    if (!it.dueDate) continue;
    const dueMs = Date.parse(`${it.dueDate}T00:00:00`);
    if (Number.isNaN(dueMs)) continue;
    const paid = Number(it.paidAmount ?? 0);
    const amt = Number(it.totalAmount ?? 0);
    if (amt <= 0.001) continue;
    if (paid >= amt - 0.5) continue; // fully paid
    if (dueMs > todayMs) continue; // future
    const days = Math.floor((todayMs - dueMs) / 86_400_000);
    if (days > maxDays) maxDays = days;
  }
  return { debtStatus: bucketFromDays(maxDays), daysOverdue: maxDays };
}

// ─── Target (เป้าเก็บหนี้) ────────────────────────────────────────────────────

/**
 * Async generator that yields batches of TargetRow from debt_target_cache.
 * Each batch contains up to `batchSize` contracts (not rows).
 */
export async function* streamTargetFromCache(params: {
  section: SectionKey;
  batchSize?: number;
}): AsyncGenerator<any[]> {
  const { section, batchSize = 200 } = params;
  const db = await getDb();
  if (!db) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── 1. Load all cache rows for this section ──────────────────────────────
  const rawResult = await db.execute(sql`
    SELECT
      contract_external_id,
      contract_no,
      customer_name,
      approve_date,
      contract_status,
      product_type,
      installment_count,
      period,
      due_date,
      CAST(principal    AS DECIMAL(18,4)) AS principal,
      CAST(interest     AS DECIMAL(18,4)) AS interest,
      CAST(fee          AS DECIMAL(18,4)) AS fee,
      CAST(penalty      AS DECIMAL(18,4)) AS penalty,
      CAST(unlock_fee   AS DECIMAL(18,4)) AS unlock_fee,
      CAST(net_amount   AS DECIMAL(18,4)) AS net_amount,
      CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
      CAST(paid_amount  AS DECIMAL(18,4)) AS paid_amount,
      CAST(overpaid_applied AS DECIMAL(18,4)) AS overpaid_applied,
      CAST(baseline_amount  AS DECIMAL(18,4)) AS baseline_amount,
      is_paid,
      is_partial_paid,
      is_closed,
      is_suspended,
      is_current_period,
      is_future_period,
      is_arrears,
      is_bad_debt,
      debt_range
    FROM debt_target_cache
    WHERE section = ${section}
    ORDER BY contract_external_id, period
  `);
  const rows: any[] = (rawResult as any)[0] ?? rawResult;

  // ── 2. Load phone numbers from contracts (single JOIN-less query) ─────────
  const phoneResult = await db.execute(sql`
    SELECT external_id, phone
    FROM contracts
    WHERE section = ${section}
  `);
  const phoneRows: any[] = (phoneResult as any)[0] ?? phoneResult;
  const phoneMap = new Map<string, string | null>();
  for (const r of phoneRows) {
    phoneMap.set(String(r.external_id), r.phone ?? null);
  }

  // ── 3. Group rows by contract ─────────────────────────────────────────────
  const contractMap = new Map<string, any[]>();
  const contractOrder: string[] = [];
  for (const r of rows) {
    const key = String(r.contract_external_id);
    if (!contractMap.has(key)) {
      contractMap.set(key, []);
      contractOrder.push(key);
    }
    contractMap.get(key)!.push(r);
  }

  // ── 4. Yield batches ───────────────────────────────────────────────────────
  let batch: any[] = [];
  for (const extId of contractOrder) {
    const instRows = contractMap.get(extId)!;
    const first = instRows[0];

    // Re-derive daysOverdue from cached installment rows
    const { debtStatus, daysOverdue } = rederiveDaysOverdue(
      first.contract_status ?? null,
      instRows.map((r) => ({
        dueDate: r.due_date ?? null,
        totalAmount: String(r.total_amount ?? 0),
        paidAmount: String(r.paid_amount ?? 0),
        isClosed: !!r.is_closed,
        isSuspended: !!r.is_suspended,
      })),
      today,
    );

    // Compute contract-level totals
    const totalAmount = instRows.reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
    const totalPaid = instRows.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0);

    const contractStatus = first.contract_status ?? null;
    const suspendLabel = contractStatus === "หนี้เสีย" ? "หนี้เสีย"
      : contractStatus === "ระงับสัญญา" ? "ระงับสัญญา"
      : null;

    // Build installments array
    const installments = instRows.map((r) => ({
      period: r.period != null ? Number(r.period) : null,
      dueDate: r.due_date ?? null,
      principal: Number(r.principal ?? 0),
      interest: Number(r.interest ?? 0),
      fee: Number(r.fee ?? 0),
      penalty: Number(r.penalty ?? 0),
      unlockFee: Number(r.unlock_fee ?? 0),
      amount: Number(r.total_amount ?? 0),
      paid: Number(r.paid_amount ?? 0),
      baselineAmount: Number(r.baseline_amount ?? 0),
      overpaidApplied: Number(r.overpaid_applied ?? 0),
      netAmount: Number(r.net_amount ?? 0),
      isClosed: !!r.is_closed,
      isSuspended: !!r.is_suspended,
      suspendLabel: !!r.is_suspended ? suspendLabel : null,
      suspendedAt: null, // not stored in cache
      isCurrentPeriod: !!r.is_current_period,
      isFuturePeriod: !!r.is_future_period,
      isArrears: !!r.is_arrears,
      isPaid: !!r.is_paid,
      isPartialPaid: !!r.is_partial_paid,
    }));

    const targetRow = {
      contractExternalId: extId,
      contractNo: first.contract_no ?? null,
      approveDate: first.approve_date ?? null,
      customerName: first.customer_name ?? null,
      phone: phoneMap.get(extId) ?? null,
      productType: first.product_type ?? null,
      installmentCount: first.installment_count != null ? Number(first.installment_count) : null,
      installmentAmount: null, // not stored in cache
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments,
    };

    batch.push(targetRow);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (batch.length > 0) yield batch;
}

// ─── Collected (ยอดเก็บหนี้) ──────────────────────────────────────────────────

/**
 * Async generator that yields batches of CollectedRow from debt_collected_cache.
 * Each batch contains up to `batchSize` contracts (not rows).
 */
export async function* streamCollectedFromCache(params: {
  section: SectionKey;
  batchSize?: number;
}): AsyncGenerator<{ rows: any[]; meta: { hasPrincipalBreakdown: boolean } }> {
  const { section, batchSize = 200 } = params;
  const db = await getDb();
  if (!db) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── 1. Load all collected cache rows ─────────────────────────────────────
  const rawResult = await db.execute(sql`
    SELECT
      contract_external_id,
      contract_no,
      customer_name,
      approve_date,
      contract_status,
      product_type,
      installment_count,
      payment_external_id,
      period,
      paid_at,
      CAST(principal   AS DECIMAL(18,4)) AS principal,
      CAST(interest    AS DECIMAL(18,4)) AS interest,
      CAST(fee         AS DECIMAL(18,4)) AS fee,
      CAST(penalty     AS DECIMAL(18,4)) AS penalty,
      CAST(unlock_fee  AS DECIMAL(18,4)) AS unlock_fee,
      CAST(discount    AS DECIMAL(18,4)) AS discount,
      CAST(overpaid    AS DECIMAL(18,4)) AS overpaid,
      CAST(bad_debt    AS DECIMAL(18,4)) AS bad_debt,
      CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
      updated_by,
      is_bad_debt_row
    FROM debt_collected_cache
    WHERE section = ${section}
    ORDER BY contract_external_id, paid_at, payment_external_id
  `);
  const rows: any[] = (rawResult as any)[0] ?? rawResult;

  // ── 2. Load phone numbers from contracts ─────────────────────────────────
  const phoneResult = await db.execute(sql`
    SELECT external_id, phone
    FROM contracts
    WHERE section = ${section}
  `);
  const phoneRows: any[] = (phoneResult as any)[0] ?? phoneResult;
  const phoneMap = new Map<string, string | null>();
  for (const r of phoneRows) {
    phoneMap.set(String(r.external_id), r.phone ?? null);
  }

  // ── 3. Load target cache for contract-level totals + installments ─────────
  const targetResult = await db.execute(sql`
    SELECT
      contract_external_id,
      period,
      due_date,
      CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
      CAST(paid_amount  AS DECIMAL(18,4)) AS paid_amount,
      CAST(principal    AS DECIMAL(18,4)) AS principal,
      CAST(interest     AS DECIMAL(18,4)) AS interest,
      CAST(fee          AS DECIMAL(18,4)) AS fee,
      CAST(penalty      AS DECIMAL(18,4)) AS penalty,
      CAST(unlock_fee   AS DECIMAL(18,4)) AS unlock_fee,
      CAST(net_amount   AS DECIMAL(18,4)) AS net_amount,
      CAST(overpaid_applied AS DECIMAL(18,4)) AS overpaid_applied,
      CAST(baseline_amount  AS DECIMAL(18,4)) AS baseline_amount,
      is_paid, is_partial_paid, is_closed, is_suspended,
      is_current_period, is_future_period, is_arrears, is_bad_debt,
      install_count_override AS installment_count_override
    FROM (
      SELECT *,
        NULL AS install_count_override
      FROM debt_target_cache
      WHERE section = ${section}
    ) sub
    ORDER BY contract_external_id, period
  `);
  const targetRows: any[] = (targetResult as any)[0] ?? targetResult;
  const targetByContract = new Map<string, any[]>();
  for (const r of targetRows) {
    const key = String(r.contract_external_id);
    if (!targetByContract.has(key)) targetByContract.set(key, []);
    targetByContract.get(key)!.push(r);
  }

  // ── 4. Group collected rows by contract ───────────────────────────────────
  const contractMap = new Map<string, any[]>();
  const contractOrder: string[] = [];
  for (const r of rows) {
    const key = String(r.contract_external_id);
    if (!contractMap.has(key)) {
      contractMap.set(key, []);
      contractOrder.push(key);
    }
    contractMap.get(key)!.push(r);
  }

  // ── 5. Yield batches ───────────────────────────────────────────────────────
  let yieldBatch: any[] = [];
  for (const extId of contractOrder) {
    const payRows = contractMap.get(extId)!;
    const first = payRows[0];

    // Get installments from target cache
    const instRows = targetByContract.get(extId) ?? [];
    const contractStatus = first.contract_status ?? null;
    const suspendLabel = contractStatus === "หนี้เสีย" ? "หนี้เสีย"
      : contractStatus === "ระงับสัญญา" ? "ระงับสัญญา"
      : null;

    // Re-derive daysOverdue
    const { debtStatus, daysOverdue } = rederiveDaysOverdue(
      contractStatus,
      instRows.map((r) => ({
        dueDate: r.due_date ?? null,
        totalAmount: String(r.total_amount ?? 0),
        paidAmount: String(r.paid_amount ?? 0),
        isClosed: !!r.is_closed,
        isSuspended: !!r.is_suspended,
      })),
      today,
    );

    // Compute contract-level totals from target cache
    const totalAmount = instRows.reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
    const totalPaid = instRows.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0);

    // Build installments from target cache
    const installments = instRows.map((r) => ({
      period: r.period != null ? Number(r.period) : null,
      dueDate: r.due_date ?? null,
      principal: Number(r.principal ?? 0),
      interest: Number(r.interest ?? 0),
      fee: Number(r.fee ?? 0),
      penalty: Number(r.penalty ?? 0),
      unlockFee: Number(r.unlock_fee ?? 0),
      amount: Number(r.total_amount ?? 0),
      paid: Number(r.paid_amount ?? 0),
      baselineAmount: Number(r.baseline_amount ?? 0),
      overpaidApplied: Number(r.overpaid_applied ?? 0),
      netAmount: Number(r.net_amount ?? 0),
      isClosed: !!r.is_closed,
      isSuspended: !!r.is_suspended,
      suspendLabel: !!r.is_suspended ? suspendLabel : null,
      suspendedAt: null,
      isCurrentPeriod: !!r.is_current_period,
      isFuturePeriod: !!r.is_future_period,
      isArrears: !!r.is_arrears,
      isPaid: !!r.is_paid,
      isPartialPaid: !!r.is_partial_paid,
    }));

    // Build payments array from collected cache
    const payments = payRows.map((p) => ({
      period: p.period != null ? Number(p.period) : null,
      splitIndex: 0,          // not stored in cache — default 0
      isCloseRow: false,      // not stored in cache — default false
      isBadDebtRow: !!p.is_bad_debt_row,
      paidAt: p.paid_at ?? null,
      principal: Number(p.principal ?? 0),
      interest: Number(p.interest ?? 0),
      fee: Number(p.fee ?? 0),
      penalty: Number(p.penalty ?? 0),
      unlockFee: Number(p.unlock_fee ?? 0),
      discount: Number(p.discount ?? 0),
      overpaid: Number(p.overpaid ?? 0),
      closeInstallmentAmount: 0, // not stored in cache
      badDebt: Number(p.bad_debt ?? 0),
      total: Number(p.total_amount ?? 0),
      receiptNo: null,        // not stored in cache
      remark: null,           // not stored in cache
      badDebtNote: null,      // not stored in cache
      updatedBy: p.updated_by ?? null,
      updatedAt: null,        // not stored in cache
    }));

    const collectedRow = {
      contractExternalId: extId,
      contractNo: first.contract_no ?? null,
      approveDate: first.approve_date ?? null,
      customerName: first.customer_name ?? null,
      phone: phoneMap.get(extId) ?? null,
      productType: first.product_type ?? null,
      installmentCount: first.installment_count != null ? Number(first.installment_count) : null,
      installmentAmount: null,
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments,
      payments,
    };

    yieldBatch.push(collectedRow);
    if (yieldBatch.length >= batchSize) {
      yield { rows: yieldBatch, meta: { hasPrincipalBreakdown: true } };
      yieldBatch = [];
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (yieldBatch.length > 0) {
    yield { rows: yieldBatch, meta: { hasPrincipalBreakdown: true } };
  }
}

// ─── Paginated Chunk Queries (Phase 114) ──────────────────────────────────────
// แทนที่การโหลด ALL rows ในครั้งเดียว (~64MB) ด้วย LIMIT/OFFSET pagination
// แต่ละ chunk ~2,000 contracts → ~2-5MB ต่อ request → ผ่าน Cloudflare ได้

/**
 * Get total distinct contract count for target cache (for pagination).
 */
export async function getTargetContractCount(section: SectionKey): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT contract_external_id) AS cnt
    FROM debt_target_cache
    WHERE section = ${section}
  `);
  const rows: any[] = (result as any)[0] ?? result;
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Get total distinct contract count for collected cache (for pagination).
 */
export async function getCollectedContractCount(section: SectionKey): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT contract_external_id) AS cnt
    FROM debt_collected_cache
    WHERE section = ${section}
  `);
  const rows: any[] = (result as any)[0] ?? result;
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Get a paginated chunk of TargetRow from debt_target_cache.
 * Uses LIMIT/OFFSET on distinct contractExternalId to keep each response small.
 *
 * @param section - SectionKey ("Boonphone" | "Fastfone365")
 * @param offset  - number of contracts to skip (0-based)
 * @param limit   - number of contracts to return
 * @returns { rows: TargetRow[], totalContracts: number }
 */
export async function getTargetChunk(params: {
  section: SectionKey;
  offset: number;
  limit: number;
}): Promise<{ rows: any[]; totalContracts: number }> {
  const { section, offset, limit } = params;
  const db = await getDb();
  if (!db) return { rows: [], totalContracts: 0 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── 1. Get paginated contract IDs ─────────────────────────────────────────
  const idResult = await db.execute(sql`
    SELECT DISTINCT contract_external_id
    FROM debt_target_cache
    WHERE section = ${section}
    ORDER BY contract_external_id
    LIMIT ${limit} OFFSET ${offset}
  `);
  const idRows: any[] = (idResult as any)[0] ?? idResult;
  if (idRows.length === 0) {
    const total = await getTargetContractCount(section);
    return { rows: [], totalContracts: total };
  }
  const contractIds = idRows.map((r: any) => String(r.contract_external_id));

  // ── 2. Get total count (parallel with data query) ─────────────────────────
  const [totalResult, rawResult, phoneResult] = await Promise.all([
    getTargetContractCount(section),
    db.execute(sql`
      SELECT
        contract_external_id,
        contract_no,
        customer_name,
        approve_date,
        contract_status,
        product_type,
        installment_count,
        period,
        due_date,
        CAST(principal    AS DECIMAL(18,4)) AS principal,
        CAST(interest     AS DECIMAL(18,4)) AS interest,
        CAST(fee          AS DECIMAL(18,4)) AS fee,
        CAST(penalty      AS DECIMAL(18,4)) AS penalty,
        CAST(unlock_fee   AS DECIMAL(18,4)) AS unlock_fee,
        CAST(net_amount   AS DECIMAL(18,4)) AS net_amount,
        CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
        CAST(paid_amount  AS DECIMAL(18,4)) AS paid_amount,
        CAST(overpaid_applied AS DECIMAL(18,4)) AS overpaid_applied,
        CAST(baseline_amount  AS DECIMAL(18,4)) AS baseline_amount,
        is_paid,
        is_partial_paid,
        is_closed,
        is_suspended,
        is_current_period,
        is_future_period,
        is_arrears,
        is_bad_debt,
        debt_range
      FROM debt_target_cache
      WHERE section = ${section}
        AND contract_external_id IN (${sql.raw(contractIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(","))})
      ORDER BY contract_external_id, period
    `),
    db.execute(sql`
      SELECT external_id, phone
      FROM contracts
      WHERE section = ${section}
        AND external_id IN (${sql.raw(contractIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(","))})
    `),
  ]);

  const totalContracts = totalResult;
  const rows: any[] = (rawResult as any)[0] ?? rawResult;
  const phoneRows: any[] = (phoneResult as any)[0] ?? phoneResult;

  // ── 3. Build phone map ────────────────────────────────────────────────────
  const phoneMap = new Map<string, string | null>();
  for (const r of phoneRows) {
    phoneMap.set(String(r.external_id), r.phone ?? null);
  }

  // ── 4. Group rows by contract ─────────────────────────────────────────────
  const contractMap = new Map<string, any[]>();
  for (const r of rows) {
    const key = String(r.contract_external_id);
    if (!contractMap.has(key)) contractMap.set(key, []);
    contractMap.get(key)!.push(r);
  }

  // ── 5. Build TargetRow objects ────────────────────────────────────────────
  const result: any[] = [];
  for (const extId of contractIds) {
    const instRows = contractMap.get(extId) ?? [];
    if (instRows.length === 0) continue;
    const first = instRows[0];

    const { debtStatus, daysOverdue } = rederiveDaysOverdue(
      first.contract_status ?? null,
      instRows.map((r) => ({
        dueDate: r.due_date ?? null,
        totalAmount: String(r.total_amount ?? 0),
        paidAmount: String(r.paid_amount ?? 0),
        isClosed: !!r.is_closed,
        isSuspended: !!r.is_suspended,
      })),
      today,
    );

    const totalAmount = instRows.reduce((s: number, r: any) => s + Number(r.total_amount ?? 0), 0);
    const totalPaid = instRows.reduce((s: number, r: any) => s + Number(r.paid_amount ?? 0), 0);

    const contractStatus = first.contract_status ?? null;
    const suspendLabel = contractStatus === "หนี้เสีย" ? "หนี้เสีย"
      : contractStatus === "ระงับสัญญา" ? "ระงับสัญญา"
      : null;

    const installments = instRows.map((r: any) => ({
      period: r.period != null ? Number(r.period) : null,
      dueDate: r.due_date ?? null,
      principal: Number(r.principal ?? 0),
      interest: Number(r.interest ?? 0),
      fee: Number(r.fee ?? 0),
      penalty: Number(r.penalty ?? 0),
      unlockFee: Number(r.unlock_fee ?? 0),
      amount: Number(r.total_amount ?? 0),
      paid: Number(r.paid_amount ?? 0),
      baselineAmount: Number(r.baseline_amount ?? 0),
      overpaidApplied: Number(r.overpaid_applied ?? 0),
      netAmount: Number(r.net_amount ?? 0),
      isClosed: !!r.is_closed,
      isSuspended: !!r.is_suspended,
      suspendLabel: !!r.is_suspended ? suspendLabel : null,
      suspendedAt: null,
      isCurrentPeriod: !!r.is_current_period,
      isFuturePeriod: !!r.is_future_period,
      isArrears: !!r.is_arrears,
      isPaid: !!r.is_paid,
      isPartialPaid: !!r.is_partial_paid,
    }));

    result.push({
      contractExternalId: extId,
      contractNo: first.contract_no ?? null,
      approveDate: first.approve_date ?? null,
      customerName: first.customer_name ?? null,
      phone: phoneMap.get(extId) ?? null,
      productType: first.product_type ?? null,
      installmentCount: first.installment_count != null ? Number(first.installment_count) : null,
      installmentAmount: null,
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments,
    });
  }

  return { rows: result, totalContracts };
}

/**
 * Get a paginated chunk of CollectedRow from debt_collected_cache.
 * Uses LIMIT/OFFSET on distinct contractExternalId to keep each response small.
 *
 * @param section - SectionKey ("Boonphone" | "Fastfone365")
 * @param offset  - number of contracts to skip (0-based)
 * @param limit   - number of contracts to return
 * @returns { rows: CollectedRow[], totalContracts: number, hasPrincipalBreakdown: boolean }
 */
export async function getCollectedChunk(params: {
  section: SectionKey;
  offset: number;
  limit: number;
}): Promise<{ rows: any[]; totalContracts: number; hasPrincipalBreakdown: boolean }> {
  const { section, offset, limit } = params;
  const db = await getDb();
  if (!db) return { rows: [], totalContracts: 0, hasPrincipalBreakdown: true };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── 1. Get paginated contract IDs ─────────────────────────────────────────
  const idResult = await db.execute(sql`
    SELECT DISTINCT contract_external_id
    FROM debt_collected_cache
    WHERE section = ${section}
    ORDER BY contract_external_id
    LIMIT ${limit} OFFSET ${offset}
  `);
  const idRows: any[] = (idResult as any)[0] ?? idResult;
  if (idRows.length === 0) {
    const total = await getCollectedContractCount(section);
    return { rows: [], totalContracts: total, hasPrincipalBreakdown: true };
  }
  const contractIds = idRows.map((r: any) => String(r.contract_external_id));
  const idListSql = contractIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");

  // ── 2. Get total count + data in parallel ─────────────────────────────────
  const [totalContracts, rawResult, targetResult, phoneResult] = await Promise.all([
    getCollectedContractCount(section),
    db.execute(sql`
      SELECT
        contract_external_id,
        contract_no,
        customer_name,
        approve_date,
        contract_status,
        product_type,
        installment_count,
        payment_external_id,
        period,
        paid_at,
        CAST(principal   AS DECIMAL(18,4)) AS principal,
        CAST(interest    AS DECIMAL(18,4)) AS interest,
        CAST(fee         AS DECIMAL(18,4)) AS fee,
        CAST(penalty     AS DECIMAL(18,4)) AS penalty,
        CAST(unlock_fee  AS DECIMAL(18,4)) AS unlock_fee,
        CAST(discount    AS DECIMAL(18,4)) AS discount,
        CAST(overpaid    AS DECIMAL(18,4)) AS overpaid,
        CAST(bad_debt    AS DECIMAL(18,4)) AS bad_debt,
        CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
        updated_by,
        is_bad_debt_row
      FROM debt_collected_cache
      WHERE section = ${section}
        AND contract_external_id IN (${sql.raw(idListSql)})
      ORDER BY contract_external_id, paid_at, payment_external_id
    `),
    db.execute(sql`
      SELECT
        contract_external_id,
        period,
        due_date,
        CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
        CAST(paid_amount  AS DECIMAL(18,4)) AS paid_amount,
        CAST(principal    AS DECIMAL(18,4)) AS principal,
        CAST(interest     AS DECIMAL(18,4)) AS interest,
        CAST(fee          AS DECIMAL(18,4)) AS fee,
        CAST(penalty      AS DECIMAL(18,4)) AS penalty,
        CAST(unlock_fee   AS DECIMAL(18,4)) AS unlock_fee,
        CAST(net_amount   AS DECIMAL(18,4)) AS net_amount,
        CAST(overpaid_applied AS DECIMAL(18,4)) AS overpaid_applied,
        CAST(baseline_amount  AS DECIMAL(18,4)) AS baseline_amount,
        is_paid, is_partial_paid, is_closed, is_suspended,
        is_current_period, is_future_period, is_arrears, is_bad_debt
      FROM debt_target_cache
      WHERE section = ${section}
        AND contract_external_id IN (${sql.raw(idListSql)})
      ORDER BY contract_external_id, period
    `),
    db.execute(sql`
      SELECT external_id, phone
      FROM contracts
      WHERE section = ${section}
        AND external_id IN (${sql.raw(idListSql)})
    `),
  ]);

  const collectedRows: any[] = (rawResult as any)[0] ?? rawResult;
  const targetRows: any[] = (targetResult as any)[0] ?? targetResult;
  const phoneRows: any[] = (phoneResult as any)[0] ?? phoneResult;

  // ── 3. Build maps ─────────────────────────────────────────────────────────
  const phoneMap = new Map<string, string | null>();
  for (const r of phoneRows) {
    phoneMap.set(String(r.external_id), r.phone ?? null);
  }

  const targetByContract = new Map<string, any[]>();
  for (const r of targetRows) {
    const key = String(r.contract_external_id);
    if (!targetByContract.has(key)) targetByContract.set(key, []);
    targetByContract.get(key)!.push(r);
  }

  const contractMap = new Map<string, any[]>();
  for (const r of collectedRows) {
    const key = String(r.contract_external_id);
    if (!contractMap.has(key)) contractMap.set(key, []);
    contractMap.get(key)!.push(r);
  }

  // ── 4. Build CollectedRow objects ─────────────────────────────────────────
  const result: any[] = [];
  for (const extId of contractIds) {
    const payRows = contractMap.get(extId) ?? [];
    if (payRows.length === 0) continue;
    const first = payRows[0];

    const instRows = targetByContract.get(extId) ?? [];
    const contractStatus = first.contract_status ?? null;
    const suspendLabel = contractStatus === "หนี้เสีย" ? "หนี้เสีย"
      : contractStatus === "ระงับสัญญา" ? "ระงับสัญญา"
      : null;

    const { debtStatus, daysOverdue } = rederiveDaysOverdue(
      contractStatus,
      instRows.map((r) => ({
        dueDate: r.due_date ?? null,
        totalAmount: String(r.total_amount ?? 0),
        paidAmount: String(r.paid_amount ?? 0),
        isClosed: !!r.is_closed,
        isSuspended: !!r.is_suspended,
      })),
      today,
    );

    const totalAmount = instRows.reduce((s: number, r: any) => s + Number(r.total_amount ?? 0), 0);
    const totalPaid = instRows.reduce((s: number, r: any) => s + Number(r.paid_amount ?? 0), 0);

    const installments = instRows.map((r: any) => ({
      period: r.period != null ? Number(r.period) : null,
      dueDate: r.due_date ?? null,
      principal: Number(r.principal ?? 0),
      interest: Number(r.interest ?? 0),
      fee: Number(r.fee ?? 0),
      penalty: Number(r.penalty ?? 0),
      unlockFee: Number(r.unlock_fee ?? 0),
      amount: Number(r.total_amount ?? 0),
      paid: Number(r.paid_amount ?? 0),
      baselineAmount: Number(r.baseline_amount ?? 0),
      overpaidApplied: Number(r.overpaid_applied ?? 0),
      netAmount: Number(r.net_amount ?? 0),
      isClosed: !!r.is_closed,
      isSuspended: !!r.is_suspended,
      suspendLabel: !!r.is_suspended ? suspendLabel : null,
      suspendedAt: null,
      isCurrentPeriod: !!r.is_current_period,
      isFuturePeriod: !!r.is_future_period,
      isArrears: !!r.is_arrears,
      isPaid: !!r.is_paid,
      isPartialPaid: !!r.is_partial_paid,
    }));

    const payments = payRows.map((p: any) => ({
      period: p.period != null ? Number(p.period) : null,
      splitIndex: 0,
      isCloseRow: false,
      isBadDebtRow: !!p.is_bad_debt_row,
      paidAt: p.paid_at ?? null,
      principal: Number(p.principal ?? 0),
      interest: Number(p.interest ?? 0),
      fee: Number(p.fee ?? 0),
      penalty: Number(p.penalty ?? 0),
      unlockFee: Number(p.unlock_fee ?? 0),
      discount: Number(p.discount ?? 0),
      overpaid: Number(p.overpaid ?? 0),
      closeInstallmentAmount: 0,
      badDebt: Number(p.bad_debt ?? 0),
      total: Number(p.total_amount ?? 0),
      receiptNo: null,
      remark: null,
      badDebtNote: null,
      updatedBy: p.updated_by ?? null,
      updatedAt: null,
    }));

    result.push({
      contractExternalId: extId,
      contractNo: first.contract_no ?? null,
      approveDate: first.approve_date ?? null,
      customerName: first.customer_name ?? null,
      phone: phoneMap.get(extId) ?? null,
      productType: first.product_type ?? null,
      installmentCount: first.installment_count != null ? Number(first.installment_count) : null,
      installmentAmount: null,
      totalAmount,
      totalPaid,
      remaining: Math.max(totalAmount - totalPaid, 0),
      debtStatus,
      daysOverdue,
      installments,
      payments,
    });
  }

  return { rows: result, totalContracts, hasPrincipalBreakdown: true };
}

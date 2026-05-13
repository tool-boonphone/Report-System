/**
 * fillPeriodNos.ts
 *
 * Backfill / refresh period_no and sub_no for all payment_transactions.
 * Called after each sync so new/backdated payments get correct N-M labels.
 *
 * Algorithm (pure accumulation):
 *   - Sort payments by paid_at ASC, then external_id ASC
 *   - Accumulate payment.amount against installment_amount (per-period threshold)
 *   - When accumulated >= threshold → period N complete, advance to N+1
 *   - sub_no (M) = sequential count within period N
 *
 * No dependency on receipt_no, close_installment_amount, or installment schedule rows.
 */

import { sql, eq } from "drizzle-orm";
import { getDb } from "../db";
import { contracts, paymentTransactions } from "../../drizzle/schema";
import { computePayPeriods } from "./computePayPeriods";
import type { SectionKey } from "../../shared/const";

const CONTRACT_BATCH = 50;
const UPDATE_BATCH = 500;

/**
 * Fill period_no and sub_no for all payment_transactions of a given section.
 * Returns the number of rows updated.
 */
export async function fillPeriodNosForSection(
  section: SectionKey,
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("[fillPeriodNos] DB not available");

  console.log(`[fillPeriodNos] Starting for section: ${section}`);
  const startMs = Date.now();

  // ─── 1. Load all contracts with their installment_amount ─────────────────
  const contractRows = await db
    .select({
      externalId: contracts.externalId,
      installmentAmount: contracts.installmentAmount,
    })
    .from(contracts)
    .where(eq(contracts.section, section))
    .orderBy(contracts.externalId);

  console.log(`[fillPeriodNos] ${section}: ${contractRows.length} contracts to process`);

  // Build a map: externalId → installmentAmount
  const instAmtByContract = new Map<string, number>();
  for (const r of contractRows) {
    instAmtByContract.set(r.externalId, Number(r.installmentAmount) || 0);
  }

  const contractIds = contractRows.map((r: { externalId: string; installmentAmount: unknown }) => r.externalId);
  let totalUpdated = 0;

  // ─── 2. Process contracts in batches ─────────────────────────────────────
  for (let batchStart = 0; batchStart < contractIds.length; batchStart += CONTRACT_BATCH) {
    const batchIds = contractIds.slice(batchStart, batchStart + CONTRACT_BATCH);
    if (!batchIds.length) continue;

    // Load payments for this batch
    const payRowsRaw = await db.execute(sql`
      SELECT
        pt.id,
        pt.external_id,
        pt.contract_external_id,
        pt.paid_at,
        pt.amount
      FROM payment_transactions pt
      WHERE pt.section = ${section}        AND pt.contract_external_id IN (${sql.raw(batchIds.map((id: string) => `'${id.replace(/'/g, "''")}' `).join(","))})
      ORDER BY pt.contract_external_id, pt.paid_at, pt.id
    `);

    const payRows: Array<{
      id: number;
      external_id: string;
      contract_external_id: string;
      paid_at: string | null;
      amount: number;
    }> = ((payRowsRaw as any)[0] ?? payRowsRaw).map((r: any) => ({
      id: Number(r.id),
      external_id: String(r.external_id),
      contract_external_id: String(r.contract_external_id),
      paid_at: r.paid_at ? String(r.paid_at).slice(0, 10) : null,
      amount: Number(r.amount) || 0,
    }));

    // Group payments by contract
    const payByContract = new Map<string, typeof payRows>();
    for (const r of payRows) {
      const cid = r.contract_external_id;
      if (!payByContract.has(cid)) payByContract.set(cid, []);
      payByContract.get(cid)!.push(r);
    }

    // ─── 3. Compute period assignments ─────────────────────────────────────
    const allAssignments: Array<{ id: number; periodNo: number; subNo: number }> = [];

    for (const contractId of batchIds) {
      const payments = payByContract.get(contractId) ?? [];
      if (!payments.length) continue;

      const installmentAmount = instAmtByContract.get(contractId) ?? 0;

      const assignments = computePayPeriods(
        payments.map((p) => ({
          id: p.id,
          externalId: p.external_id,
          paidAt: p.paid_at ?? "1970-01-01",
          amount: p.amount,
        })),
        installmentAmount,
      );

      allAssignments.push(...assignments);
    }

    // ─── 4. Batch UPDATE using CASE WHEN ───────────────────────────────────
    for (let i = 0; i < allAssignments.length; i += UPDATE_BATCH) {
      const chunk = allAssignments.slice(i, i + UPDATE_BATCH);
      if (!chunk.length) continue;

      const ids = chunk.map((a) => a.id).join(",");
      const periodCase = chunk.map((a) => `WHEN ${a.id} THEN ${a.periodNo}`).join(" ");
      const subCase = chunk.map((a) => `WHEN ${a.id} THEN ${a.subNo}`).join(" ");

      await db.execute(sql`
        UPDATE payment_transactions
        SET period_no = CASE id ${sql.raw(periodCase)} END,
            sub_no    = CASE id ${sql.raw(subCase)} END
        WHERE id IN (${sql.raw(ids)})
      `);

      totalUpdated += chunk.length;
    }

    const pct = Math.round(((batchStart + batchIds.length) / contractIds.length) * 100);
    if (pct % 10 === 0 || batchStart + batchIds.length >= contractIds.length) {
      console.log(
        `[fillPeriodNos] ${section}: ${batchStart + batchIds.length}/${contractIds.length} contracts (${pct}%), ${totalUpdated} rows updated`,
      );
    }
  }

  const elapsed = Date.now() - startMs;
  console.log(`[fillPeriodNos] ${section}: done — ${totalUpdated} rows updated in ${elapsed}ms`);
  return totalUpdated;
}

/**
 * Fill period_no/sub_no for both sections.
 */
export async function fillPeriodNosAll(): Promise<void> {
  for (const section of ["Boonphone", "Fastfone365"] as SectionKey[]) {
    try {
      await fillPeriodNosForSection(section);
    } catch (err: any) {
      console.error(`[fillPeriodNos] ${section} failed:`, err?.message ?? err);
    }
  }
}

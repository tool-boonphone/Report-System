/**
 * fillPeriodNos.ts
 *
 * Backfill period_no and sub_no for all existing payment_transactions.
 * Also called after each sync to keep new payments up-to-date.
 */

import { sql, inArray, and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { contracts, installments, paymentTransactions } from "../../drizzle/schema";
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

  // ─── 1. Load all contract external_ids for this section ──────────────────
  const contractRows = await db
    .select({ externalId: contracts.externalId })
    .from(contracts)
    .where(eq(contracts.section, section))
    .orderBy(contracts.externalId);

  const contractIds: string[] = contractRows.map((r) => r.externalId);
  console.log(`[fillPeriodNos] ${section}: ${contractIds.length} contracts to process`);

  let totalUpdated = 0;

  // ─── 2. Process contracts in batches ─────────────────────────────────────
  for (let batchStart = 0; batchStart < contractIds.length; batchStart += CONTRACT_BATCH) {
    const batchIds = contractIds.slice(batchStart, batchStart + CONTRACT_BATCH);
    if (!batchIds.length) continue;

    // Load installments for this batch of contracts
    const instRows = await db
      .select({
        contractExternalId: installments.contractExternalId,
        period: installments.period,
        amount: installments.amount,
      })
      .from(installments)
      .where(
        and(
          eq(installments.section, section),
          inArray(installments.contractExternalId, batchIds as [string, ...string[]]),
        ),
      )
      .orderBy(installments.contractExternalId, installments.period);

    // Group installments by contract
    const instByContract = new Map<string, Array<{ period: number; amount: number }>>();
    for (const r of instRows) {
      const cid = r.contractExternalId;
      if (!instByContract.has(cid)) instByContract.set(cid, []);
      instByContract.get(cid)!.push({
        period: Number(r.period),
        amount: Number(r.amount) || 0,
      });
    }

    // Load payments for this batch of contracts
    const payRows = await db
      .select({
        id: paymentTransactions.id,
        externalId: paymentTransactions.externalId,
        contractExternalId: paymentTransactions.contractExternalId,
        paidAt: paymentTransactions.paidAt,
        amount: paymentTransactions.amount,
      })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.section, section),
          inArray(paymentTransactions.contractExternalId, batchIds as [string, ...string[]]),
        ),
      )
      .orderBy(
        paymentTransactions.contractExternalId,
        paymentTransactions.paidAt,
        paymentTransactions.id,
      );

    // Group payments by contract
    const payByContract = new Map<string, Array<{
      id: number;
      externalId: string;
      paidAt: string | null;
      amount: number;
    }>>();
    for (const r of payRows) {
      const cid = r.contractExternalId ?? "";
      if (!payByContract.has(cid)) payByContract.set(cid, []);
      payByContract.get(cid)!.push({
        id: r.id,
        externalId: r.externalId,
        paidAt: r.paidAt ?? null,
        amount: Number(r.amount) || 0,
      });
    }

    // ─── 3. Compute period assignments ─────────────────────────────────────
    const allAssignments: Array<{ id: number; periodNo: number; subNo: number }> = [];

    for (const contractId of batchIds) {
      const schedule = instByContract.get(contractId) ?? [];
      const payments = payByContract.get(contractId) ?? [];
      if (!payments.length) continue;

      const assignments = computePayPeriods(payments, schedule);
      allAssignments.push(...assignments);
    }

    // ─── 4. Batch UPDATE using CASE WHEN ───────────────────────────────────
    for (let i = 0; i < allAssignments.length; i += UPDATE_BATCH) {
      const chunk = allAssignments.slice(i, i + UPDATE_BATCH);
      if (!chunk.length) continue;

      const ids = chunk.map((a) => a.id).join(",");
      const periodCase = chunk
        .map((a) => `WHEN ${a.id} THEN ${a.periodNo}`)
        .join(" ");
      const subCase = chunk
        .map((a) => `WHEN ${a.id} THEN ${a.subNo}`)
        .join(" ");

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
  console.log(
    `[fillPeriodNos] ${section}: done — ${totalUpdated} rows updated in ${elapsed}ms`,
  );
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

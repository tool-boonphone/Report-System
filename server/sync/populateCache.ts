/**
 * populateCache.ts — Populate Engine for debt_target_cache & debt_collected_cache
 *
 * Strategy (Revised — Phase 113 Fix):
 *   Instead of duplicating business logic from debtDb.ts (which caused calculation errors),
 *   this module now calls listDebtTargetStream + listDebtCollectedStream DIRECTLY and
 *   serializes their output into the cache tables.
 *
 *   This guarantees 100% logic parity with the live stream — no duplication, no drift.
 *
 *   Extra contract metadata (partner_code, partner_name, device, model) is loaded
 *   separately from the contracts table and merged in before insert.
 *
 * Called from:
 *   - doSync() in runner.ts after bad_debt stage
 *   - cache.ts router (manual trigger via tRPC)
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { debtTargetCache, debtCollectedCache } from "../../drizzle/schema";
import { listDebtTargetStream, listDebtCollectedStream } from "../debtDb";
import type { SectionKey } from "../../shared/const";

const BATCH = 100;

// ─── Helper ───────────────────────────────────────────────────────────────────
function bucketFromDays(days: number): string {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

/** Extra contract metadata not included in stream output */
interface ContractMeta {
  status: string | null;
  partnerCode: string | null;
  partnerName: string | null;
  device: string | null;
  model: string | null;
}

// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * Populate debt_target_cache and debt_collected_cache for a given section.
 *
 * Calls listDebtTargetStream + listDebtCollectedStream directly so that
 * all business logic (suspendedFromPeriod, closedByContract patterns, etc.)
 * is computed by the authoritative source — debtDb.ts.
 *
 * @returns { targetRows, collectedRows } — number of rows inserted into each cache
 */
export async function populateDebtCache(
  section: SectionKey,
): Promise<{ targetRows: number; collectedRows: number }> {
  const db = await getDb();
  if (!db) throw new Error("[populateCache] DB not available");

  console.log(`[populateCache] Starting populate for section: ${section}`);
  const startMs = Date.now();

  // ─── 0. Load extra contract metadata (not in stream output) ──────────────
  const metaRaw = await db.execute(sql`
    SELECT external_id, status, partner_code, partner_name, device, model
    FROM contracts
    WHERE section = ${section}
  `);
  const metaRows: any[] = (metaRaw as any)[0] ?? metaRaw;
  const contractMeta = new Map<string, ContractMeta>();
  for (const r of metaRows) {
    contractMeta.set(String(r.external_id), {
      status: r.status ?? null,
      partnerCode: r.partner_code ?? null,
      partnerName: r.partner_name ?? null,
      device: r.device ?? null,
      model: r.model ?? null,
    });
  }
  console.log(`[populateCache] ${section}: loaded ${contractMeta.size} contract metadata rows`);

  // ─── 1. Delete existing rows for this section ─────────────────────────────
  await db.execute(sql`DELETE FROM debt_target_cache WHERE section = ${section}`);
  await db.execute(sql`DELETE FROM debt_collected_cache WHERE section = ${section}`);
  console.log(`[populateCache] ${section}: deleted existing cache rows`);

  // ─── 2. Populate debt_target_cache ────────────────────────────────────────
  let targetCount = 0;
  const targetStream = listDebtTargetStream({ section, batchSize: 200 });

  for await (const contractBatch of targetStream) {
    const insertRows: (typeof debtTargetCache.$inferInsert)[] = [];

    for (const contract of contractBatch) {
      const extId = String((contract as any).contractExternalId ?? "");
      if (!extId) continue;

      const meta = contractMeta.get(extId);
      const daysOverdue = Number((contract as any).daysOverdue ?? 0);
      const debtRange = bucketFromDays(daysOverdue);
      const contractStatus = meta?.status ?? null;

      for (const inst of (contract as any).installments ?? []) {
        const periodNo = inst.period != null ? Number(inst.period) : 0;

        insertRows.push({
          section,
          contractExternalId: extId,
          contractNo: (contract as any).contractNo ?? "",
          customerName: (contract as any).customerName ?? null,
          approveDate: (contract as any).approveDate ?? null,
          contractStatus,
          partnerCode: meta?.partnerCode ?? null,
          partnerName: meta?.partnerName ?? null,
          productType: (contract as any).productType ?? null,
          device: meta?.device ?? null,
          model: meta?.model ?? null,
          financeAmount: (contract as any).financeAmount != null
            ? String(Number((contract as any).financeAmount))
            : null,
          installmentCount: (contract as any).installmentCount != null
            ? Number((contract as any).installmentCount)
            : null,
          period: periodNo,
          dueDate: inst.dueDate ?? null,
          principal: String(Number(inst.principal ?? 0)),
          interest: String(Number(inst.interest ?? 0)),
          fee: String(Number(inst.fee ?? 0)),
          penalty: String(Number(inst.penalty ?? 0)),
          unlockFee: String(Number(inst.unlockFee ?? 0)),
          netAmount: String(Number(inst.netAmount ?? 0)),
          totalAmount: String(Number(inst.amount ?? 0)),
          paidAmount: String(Number(inst.paid ?? 0)),
          overpaidApplied: String(Number(inst.overpaidApplied ?? 0)),
          baselineAmount: String(Number(inst.baselineAmount ?? 0)),
          isPaid: !!inst.isPaid,
          isPartialPaid: !!inst.isPartialPaid,
          isClosed: !!inst.isClosed,
          isSuspended: !!inst.isSuspended,
          isCurrentPeriod: !!inst.isCurrentPeriod,
          isFuturePeriod: !!inst.isFuturePeriod,
          isArrears: !!inst.isArrears,
          isBadDebt: !!inst.isSuspended && (
            contractStatus === "หนี้เสีย" || inst.suspendLabel === "หนี้เสีย"
          ),
          debtRange,
        });
      }
    }

    // Batch insert
    for (let i = 0; i < insertRows.length; i += BATCH) {
      const batch = insertRows.slice(i, i + BATCH);
      if (batch.length > 0) {
        await db.insert(debtTargetCache).values(batch);
        targetCount += batch.length;
      }
    }
  }

  console.log(
    `[populateCache] ${section}: inserted ${targetCount} target rows (${Date.now() - startMs}ms)`,
  );

  // ─── 3. Populate debt_collected_cache ─────────────────────────────────────
  let collectedCount = 0;
  const collectedStream = listDebtCollectedStream({ section, batchSize: 200 });

  for await (const chunk of collectedStream) {
    const contractBatch = (chunk as any).rows ?? [];
    const insertRows: (typeof debtCollectedCache.$inferInsert)[] = [];

    for (const contract of contractBatch) {
      const extId = String((contract as any).contractExternalId ?? "");
      if (!extId) continue;

      const meta = contractMeta.get(extId);
      // listDebtCollectedStream uses `status` field (not `contractStatus`)
      const contractStatus = (contract as any).status ?? meta?.status ?? null;

      // Track close-row count per contract to generate unique payExtId
      const closeRowCounters = new Map<number, number>();

      for (const p of (contract as any).payments ?? []) {
        // Build a stable paymentExternalId
        // - Normal rows: {extId}-p{period}-s{splitIndex}
        // - Close rows (TXRTC): {extId}-close-p{period}-s{counter} (may share period with normal rows)
        let payExtId: string;
        if (p.isCloseRow) {
          const period = p.period ?? 0;
          const counter = (closeRowCounters.get(period) ?? 0) + 1;
          closeRowCounters.set(period, counter);
          payExtId = `${extId}-close-p${period}-s${counter}`;
        } else {
          payExtId = `${extId}-p${p.period ?? 0}-s${p.splitIndex ?? 0}`;
        }

        insertRows.push({
          section,
          contractExternalId: extId,
          contractNo: (contract as any).contractNo ?? "",
          customerName: (contract as any).customerName ?? null,
          approveDate: (contract as any).approveDate ?? null,
          contractStatus,
          partnerCode: meta?.partnerCode ?? null,
          partnerName: meta?.partnerName ?? null,
          productType: (contract as any).productType ?? null,
          device: meta?.device ?? null,
          model: meta?.model ?? null,
          financeAmount: (contract as any).financeAmount != null
            ? String(Number((contract as any).financeAmount))
            : null,
          installmentCount: (contract as any).installmentCount != null
            ? Number((contract as any).installmentCount)
            : null,
          paymentExternalId: payExtId,
          period: p.period != null ? Number(p.period) : null,
          paidAt: p.paidAt ?? null,
          principal: String(Number(p.principal ?? 0)),
          interest: String(Number(p.interest ?? 0)),
          fee: String(Number(p.fee ?? 0)),
          penalty: String(Number(p.penalty ?? 0)),
          unlockFee: String(Number(p.unlockFee ?? 0)),
          discount: String(Number(p.discount ?? 0)),
          overpaid: String(Number(p.overpaid ?? 0)),
          badDebt: String(Number(p.badDebt ?? 0)),
          totalAmount: String(Number(p.total ?? 0)),
          updatedBy: p.updatedBy ?? null,
          updatedAt: p.updatedAt ?? null,
          isBadDebtRow: !!p.isBadDebtRow,
          isCloseRow: !!p.isCloseRow,
        });
      }
    }

    // Batch insert
    for (let i = 0; i < insertRows.length; i += BATCH) {
      const batch = insertRows.slice(i, i + BATCH);
      if (batch.length > 0) {
        await db.insert(debtCollectedCache).values(batch);
        collectedCount += batch.length;
      }
    }
  }

  const totalMs = Date.now() - startMs;
  console.log(
    `[populateCache] ${section}: inserted ${targetCount} target rows, ${collectedCount} collected rows (total ${totalMs}ms)`,
  );
  return { targetRows: targetCount, collectedRows: collectedCount };
}

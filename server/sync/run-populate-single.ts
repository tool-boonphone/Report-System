/**
 * run-populate-single.ts — Populate cache for a single contract
 * Usage: npx tsx server/sync/run-populate-single.ts <contractExternalId> [section]
 *   e.g.: npx tsx server/sync/run-populate-single.ts CT1224-NBI003-6663-01 Fastfone365
 *
 * This script:
 * 1. Deletes existing cache rows for the given contractExternalId
 * 2. Re-populates both debt_target_cache and debt_collected_cache for that contract
 *    by streaming through listDebtTargetStream + listDebtCollectedStream and filtering
 *    to only the target contract.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { debtTargetCache, debtCollectedCache } from "../../drizzle/schema";
import { listDebtTargetStream, listDebtCollectedStream } from "../debtDb";
import type { SectionKey } from "../../shared/const";
import { pgRows } from "../db";

const contractExternalId = process.argv[2];
const section: SectionKey = (process.argv[3] ?? "Fastfone365") as SectionKey;

if (!contractExternalId) {
  console.error("Usage: npx tsx server/sync/run-populate-single.ts <contractExternalId> [section]");
  process.exit(1);
}

function bucketFromDays(days: number): string {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  console.log(`[SinglePopulate] Contract: ${contractExternalId}, Section: ${section}`);

  // ─── 0. Load contract metadata ────────────────────────────────────────────
  const metaRaw = await db.execute(sql`
    SELECT external_id, status, partner_code, partner_name, device, model
    FROM contracts
    WHERE section = ${section} AND external_id = ${contractExternalId}
  `);
  const metaRows: any[] = pgRows(metaRaw);
  if (metaRows.length === 0) {
    console.error(`[SinglePopulate] ❌ Contract ${contractExternalId} not found in section ${section}`);
    process.exit(1);
  }
  const meta = {
    status: metaRows[0].status ?? null,
    partnerCode: metaRows[0].partner_code ?? null,
    partnerName: metaRows[0].partner_name ?? null,
    device: metaRows[0].device ?? null,
    model: metaRows[0].model ?? null,
  };
  console.log(`[SinglePopulate] Found contract: status=${meta.status}`);

  // ─── 1. Delete existing rows for this contract ────────────────────────────
  await db.execute(sql`
    DELETE FROM debt_target_cache
    WHERE section = ${section} AND contract_external_id = ${contractExternalId}
  `);
  await db.execute(sql`
    DELETE FROM debt_collected_cache
    WHERE section = ${section} AND contract_external_id = ${contractExternalId}
  `);
  console.log(`[SinglePopulate] Deleted existing cache rows for ${contractExternalId}`);

  // ─── 2. Populate debt_target_cache ────────────────────────────────────────
  let targetCount = 0;
  let targetFound = false;
  const targetStream = listDebtTargetStream({ section, batchSize: 200 });

  for await (const contractBatch of targetStream) {
    const matchingContracts = (contractBatch as any[]).filter(
      (c: any) => String(c.contractExternalId ?? "") === contractExternalId
    );
    if (matchingContracts.length === 0) continue;

    const insertRows: (typeof debtTargetCache.$inferInsert)[] = [];
    for (const contract of matchingContracts) {
      const extId = String(contract.contractExternalId ?? "");
      const daysOverdue = Number(contract.daysOverdue ?? 0);
      const debtRange = bucketFromDays(daysOverdue);
      const contractStatus = meta.status;

      for (const inst of contract.installments ?? []) {
        const periodNo = inst.period != null ? Number(inst.period) : 0;
        insertRows.push({
          section,
          contractExternalId: extId,
          contractNo: contract.contractNo ?? "",
          customerName: contract.customerName ?? null,
          approveDate: contract.approveDate ?? null,
          contractStatus,
          partnerCode: meta.partnerCode,
          partnerName: meta.partnerName,
          productType: contract.productType ?? null,
          device: meta.device,
          model: meta.model,
          financeAmount: contract.financeAmount != null ? String(Number(contract.financeAmount)) : null,
          installmentCount: contract.installmentCount != null ? Number(contract.installmentCount) : null,
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

    if (insertRows.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < insertRows.length; i += BATCH) {
        const batch = insertRows.slice(i, i + BATCH);
        await db.insert(debtTargetCache).values(batch);
        targetCount += batch.length;
      }
      targetFound = true;
      break; // Found our contract, stop streaming
    }
  }

  if (!targetFound) {
    console.warn(`[SinglePopulate] ⚠️ Contract ${contractExternalId} not found in target stream`);
  }
  console.log(`[SinglePopulate] ✅ Target rows inserted: ${targetCount}`);

  // ─── 3. Populate debt_collected_cache ─────────────────────────────────────
  let collectedCount = 0;
  let collectedFound = false;
  const collectedStream = listDebtCollectedStream({ section, batchSize: 200 });

  for await (const chunk of collectedStream) {
    const contractBatch = ((chunk as any).rows ?? []) as any[];
    const matchingContracts = contractBatch.filter(
      (c: any) => String(c.contractExternalId ?? "") === contractExternalId
    );
    if (matchingContracts.length === 0) continue;

    const insertRows: (typeof debtCollectedCache.$inferInsert)[] = [];
    for (const contract of matchingContracts) {
      const extId = String(contract.contractExternalId ?? "");
      const contractStatus = contract.status ?? meta.status ?? null;
      const closeRowCounters = new Map<number, number>();

      for (const p of contract.payments ?? []) {
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
          contractNo: contract.contractNo ?? "",
          customerName: contract.customerName ?? null,
          approveDate: contract.approveDate ?? null,
          contractStatus,
          partnerCode: meta.partnerCode,
          partnerName: meta.partnerName,
          productType: contract.productType ?? null,
          device: meta.device,
          model: meta.model,
          financeAmount: contract.financeAmount != null ? String(Number(contract.financeAmount)) : null,
          installmentCount: contract.installmentCount != null ? Number(contract.installmentCount) : null,
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
          paymentTxAmount: String(Number(p.total ?? 0)),
          updatedBy: p.updatedBy ?? null,
          updatedAt: p.updatedAt ?? null,
          isBadDebtRow: !!p.isBadDebtRow,
          isCloseRow: !!p.isCloseRow,
          remark: p.remark ?? null,
        });
      }
    }

    if (insertRows.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < insertRows.length; i += BATCH) {
        const batch = insertRows.slice(i, i + BATCH);
        await db.insert(debtCollectedCache).values(batch);
        collectedCount += batch.length;
      }
      collectedFound = true;
      break; // Found our contract, stop streaming
    }
  }

  if (!collectedFound) {
    console.warn(`[SinglePopulate] ⚠️ Contract ${contractExternalId} not found in collected stream`);
  }
  console.log(`[SinglePopulate] ✅ Collected rows inserted: ${collectedCount}`);
  console.log(`[SinglePopulate] 🎉 Done! target=${targetCount}, collected=${collectedCount}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[SinglePopulate] ❌ Fatal error:", err);
  process.exit(1);
});

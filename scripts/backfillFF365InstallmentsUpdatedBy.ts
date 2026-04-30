/**
 * Backfill installments.updated_by / updated_at for Fastfone365
 * by fetching contract?action=detail for every contract that still has
 * at least one installment with null updated_by.
 *
 * Mirrors the logic in enrichInstallmentsWithUpdatedBy() in runner.ts.
 */
import { buildClientFromEnv } from "../server/api/partnerClient";
import { getDb } from "../server/db";
import { installments } from "../drizzle/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

const SECTION = "Fastfone365" as const;
const CONCURRENCY = 5;
const FLUSH_EVERY = 200;

async function main() {
  const client = buildClientFromEnv(SECTION);
  if (!client) throw new Error("Fastfone365 client not configured");

  const db = await getDb();
  if (!db) throw new Error("DB not available");

  // Find distinct contract IDs that have at least one installment with null updated_by
  const rows = await db
    .selectDistinct({ contractExternalId: installments.contractExternalId })
    .from(installments)
    .where(
      and(
        eq(installments.section, SECTION),
        isNull(installments.updatedBy),
      ),
    );

  console.log(`[backfill] FF365 contracts with null updated_by: ${rows.length}`);
  if (rows.length === 0) {
    console.log("[backfill] Nothing to do.");
    process.exit(0);
  }

  const contractIds = rows.map((r) => r.contractExternalId);
  const updates: Array<{
    contractExternalId: string;
    period: number;
    updatedBy: string | null;
    updatedAt: string | null;
  }> = [];
  let flushed = 0;
  let processed = 0;

  async function flush() {
    if (updates.length === 0) return;
    const batch = updates.splice(0, updates.length);
    for (const row of batch) {
      if (!row.updatedBy && !row.updatedAt) continue;
      await db!
        .update(installments)
        .set({
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(installments.section, SECTION),
            eq(installments.contractExternalId, row.contractExternalId),
            eq(installments.period, row.period),
          ),
        );
    }
    flushed += batch.length;
  }

  let idx = 0;
  async function worker() {
    while (idx < contractIds.length) {
      const my = idx++;
      const contractExtId = contractIds[my];
      try {
        const data: any = await client!.get("contract", {
          action: "detail",
          id: contractExtId,
        });
        const detailInsts: any[] = data?.contract?.installments ?? [];
        for (const inst of detailInsts) {
          const period = inst.no ?? inst.installment_no ?? inst.period;
          const updatedBy = inst.updated_by ? String(inst.updated_by) : null;
          const updatedAt = inst.updated_at ? String(inst.updated_at) : null;
          if (period != null && (updatedBy || updatedAt)) {
            updates.push({
              contractExternalId: contractExtId,
              period: Number(period),
              updatedBy,
              updatedAt,
            });
          }
        }
        if (updates.length >= FLUSH_EVERY) await flush();
      } catch {
        // swallow per-row errors; continue with next contract
      }
      processed++;
      if (processed % 500 === 0) {
        console.log(`[backfill] Progress: ${processed}/${contractIds.length} contracts, ${flushed} rows flushed`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await flush();

  console.log(`[backfill] Done! FF365 installments updated_by enriched: ${flushed} rows from ${contractIds.length} contracts`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Error:", err);
  process.exit(1);
});

/**
 * Backfill updated_by/updated_at ใน installments table สำหรับ Boonphone
 * โดยดึงจาก contract?action=detail → installments[].updated_by
 * Usage: npx tsx scripts/backfillBpInstallmentsUpdatedBy.ts
 */
import { buildClientFromEnv } from "../server/api/partnerClient";
import { getDb } from "../server/db";
import { installments } from "../drizzle/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

const SECTION = "Boonphone" as const;
const CONCURRENCY = 5;
const FLUSH_EVERY = 200;

async function main() {
  const client = buildClientFromEnv(SECTION);
  if (!client) { console.log("No client"); process.exit(1); }

  await client.login();
  console.log("Login OK");

  const db = await getDb();
  if (!db) { console.log("No DB"); process.exit(1); }

  // หา distinct contract IDs ที่มี installment ที่ยัง null updated_by
  const rows = await db
    .selectDistinct({ contractExternalId: installments.contractExternalId })
    .from(installments)
    .where(
      and(
        eq(installments.section, SECTION),
        isNull(installments.updatedBy),
      ),
    );

  console.log(`Found ${rows.length} contracts with null updated_by installments`);
  if (rows.length === 0) { console.log("Nothing to backfill"); process.exit(0); }

  const contractIds = rows.map((r) => r.contractExternalId);
  const updates: Array<{ contractExternalId: string; period: number; updatedBy: string | null; updatedAt: string | null }> = [];
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
    console.log(`  Flushed ${flushed} installment rows so far (${processed}/${contractIds.length} contracts)`);
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
            updates.push({ contractExternalId: contractExtId, period: Number(period), updatedBy, updatedAt });
          }
        }
        processed++;
        if (updates.length >= FLUSH_EVERY) await flush();
      } catch (e: any) {
        console.warn(`  Skipping contract ${contractExtId}: ${e?.message}`);
        processed++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await flush();

  console.log(`\nDone! Total installment rows updated: ${flushed} from ${contractIds.length} contracts`);

  // Verify
  const [check] = await db
    .select({ total: sql<number>`COUNT(*)`, hasUpdatedBy: sql<number>`SUM(CASE WHEN updated_by IS NOT NULL THEN 1 ELSE 0 END)` })
    .from(installments)
    .where(eq(installments.section, SECTION));
  console.log(`Verification: ${check.hasUpdatedBy}/${check.total} Boonphone installments now have updated_by`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

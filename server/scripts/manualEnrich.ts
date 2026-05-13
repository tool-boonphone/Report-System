/**
 * Manual enrich script — เติม updated_by/updated_at ใน installments
 * สำหรับสัญญาที่ยังมี null updated_by แล้ว re-populate debt_collected_cache
 *
 * Usage: npx tsx server/scripts/manualEnrich.ts [section]
 * Default section: Boonphone
 */

import { buildClientFromEnv } from "../api/partnerClient";
import { getDb } from "../db";
import { installments, debtCollectedCache } from "../../drizzle/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { populateDebtCache } from "../sync/populateCache";
import type { SectionKey } from "../../shared/const";

const section = (process.argv[2] ?? "Boonphone") as SectionKey;

const CONCURRENCY = 5;
const FLUSH_EVERY = 100;

async function main() {
  const client = buildClientFromEnv(section);
  if (!client || !client.isConfigured()) {
    console.error("❌ Missing API credentials for section:", section);
    process.exit(1);
  }

  const db = await getDb();
  if (!db) {
    console.error("❌ Cannot connect to database");
    process.exit(1);
  }

  console.log(`\n🔍 [${section}] ค้นหาสัญญาที่ยังไม่มี updated_by...`);

  // หา distinct contract_external_id ที่มี installment ที่ updated_by เป็น null
  const rows = await db
    .selectDistinct({ contractExternalId: installments.contractExternalId })
    .from(installments)
    .where(and(eq(installments.section, section), isNull(installments.updatedBy)));

  const contractIds = rows.map((r: { contractExternalId: string }) => r.contractExternalId);
  console.log(`📋 พบ ${contractIds.length} สัญญาที่ต้อง enrich\n`);

  if (contractIds.length === 0) {
    console.log("✅ ทุกสัญญามี updated_by ครบแล้ว");
  } else {
    let processed = 0;
    let enriched = 0;
    let errors = 0;
    const startTime = Date.now();

    const updates: Array<{
      contractExternalId: string;
      period: number;
      updatedBy: string | null;
      updatedAt: string | null;
    }> = [];

    const flush = async () => {
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
              eq(installments.section, section),
              eq(installments.contractExternalId, row.contractExternalId),
              eq(installments.period, row.period),
            ),
          );
        enriched++;
      }
    };

    let idx = 0;

    const worker = async () => {
      while (idx < contractIds.length) {
        const myIdx = idx++;
        const contractId = contractIds[myIdx];
        try {
          const data: any = await client!.get("contract", {
            action: "detail",
            id: contractId,
          });
          const detailInsts: any[] = data?.contract?.installments ?? [];
          for (const inst of detailInsts) {
            const period = inst.no ?? inst.installment_no ?? inst.period;
            const updatedBy = inst.updated_by ? String(inst.updated_by) : null;
            const updatedAt = inst.updated_at ? String(inst.updated_at) : null;
            if (period != null && (updatedBy || updatedAt)) {
              updates.push({
                contractExternalId: contractId,
                period: Number(period),
                updatedBy,
                updatedAt,
              });
            }
          }
          if (updates.length >= FLUSH_EVERY) await flush();
        } catch {
          errors++;
        }
        processed++;

        // แสดง progress ทุก 50 สัญญา
        if (processed % 50 === 0 || processed === contractIds.length) {
          const pct = Math.round((processed / contractIds.length) * 100);
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const eta =
            processed > 0
              ? Math.round((elapsed / processed) * (contractIds.length - processed))
              : "?";
          process.stdout.write(
            `\r⏳ ${processed}/${contractIds.length} (${pct}%) | enriched: ${enriched} | errors: ${errors} | elapsed: ${elapsed}s | ETA: ${eta}s   `,
          );
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    await flush();

    const totalMs = Date.now() - startTime;
    console.log(
      `\n\n✅ Enrich เสร็จ! enriched ${enriched} rows จาก ${contractIds.length} สัญญา (${Math.round(totalMs / 1000)}s)`,
    );
    if (errors > 0) console.log(`⚠️  errors: ${errors} สัญญา (ข้ามไป)`);
  }

  // Re-populate debt_collected_cache หลัง enrich เสร็จ
  console.log(`\n🔄 กำลัง re-populate debt_collected_cache สำหรับ ${section}...`);
  try {
    // ล้าง cache เก่าก่อน
    await db.delete(debtCollectedCache).where(eq(debtCollectedCache.section, section));
    console.log("🗑️  ล้าง cache เก่าแล้ว");

    // populate ใหม่
    const result = await populateDebtCache(section);
    console.log(`✅ Re-populate เสร็จ! target=${result.targetRows}, collected=${result.collectedRows} rows`);
    console.log(`\n🎉 เสร็จสิ้น! กรุณากด "ล้าง Cache" ใน TopBar แล้วโหลดข้อมูลใหม่`);
  } catch (err: any) {
    console.error("❌ Re-populate failed:", err?.message ?? err);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

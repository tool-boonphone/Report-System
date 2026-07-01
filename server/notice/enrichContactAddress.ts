/**
 * ดึงที่อยู่เต็มจาก contract detail API ก่อนพิมพ์ Notice
 * (customer list API มีแค่อำเภอ+จังหวัด — ไม่พอสำหรับจ่าหน้าซอง)
 */
import { and, eq, sql } from "drizzle-orm";
import { buildClientFromEnv } from "../api/partnerClient";
import { mapContractDetailOverrides } from "../api/mappers";
import { getDb } from "../db";
import { contracts } from "../../drizzle/schema";
import type { SectionKey } from "../../shared/const";

const CONCURRENCY = 12;

/** best-effort: อัปเดตที่อยู่ใน contracts จาก detail API สำหรับรายการที่จะพิมพ์ */
export async function enrichContactAddressesForPrint(
  section: SectionKey,
  externalIds: string[],
): Promise<void> {
  const client = buildClientFromEnv(section);
  if (!client || externalIds.length === 0) return;

  const db = await getDb(section);
  if (!db) return;

  const ids = Array.from(new Set(externalIds)).filter(Boolean);
  let idx = 0;

  const worker = async () => {
    while (idx < ids.length) {
      const myIdx = idx++;
      const contractId = ids[myIdx]!;
      try {
        const data: unknown = await client.get("contract", {
          action: "detail",
          id: contractId,
        });
        const row = mapContractDetailOverrides(section, data) as Record<string, unknown>;
        await db
          .update(contracts)
          .set({
            addrHouseNo: (row.addrHouseNo as string) ?? null,
            addrMoo: (row.addrMoo as string) ?? null,
            addrVillage: (row.addrVillage as string) ?? null,
            addrSoi: (row.addrSoi as string) ?? null,
            addrStreet: (row.addrStreet as string) ?? null,
            addrSubdistrict: (row.addrSubdistrict as string) ?? null,
            addrDistrict: (row.addrDistrict as string) ?? null,
            addrProvince: (row.addrProvince as string) ?? null,
            addrPostalCode: (row.addrPostalCode as string) ?? null,
            syncedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(eq(contracts.section, section), eq(contracts.externalId, contractId)));
      } catch (err) {
        console.warn(`[notice/enrichAddress] ${section} ${contractId}:`, (err as Error)?.message ?? err);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
}

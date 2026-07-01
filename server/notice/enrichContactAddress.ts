/**
 * ดึงที่อยู่เต็มจาก contract detail API ก่อนพิมพ์ Notice
 * (customer list API มีแค่อำเภอ+จังหวัด — ไม่พอสำหรับจ่าหน้าซอง)
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildClientFromEnv } from "../api/partnerClient";
import { isLikelyAddressLine, mergeAddressFields, parseThaiAddressLine } from "../api/addressFields";
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
  const workplaceRows = await db
    .select({ externalId: contracts.externalId, workplace: contracts.workplace })
    .from(contracts)
    .where(and(eq(contracts.section, section), inArray(contracts.externalId, ids)));
  const workplaceById = new Map(
    workplaceRows.map((r: { externalId: string; workplace: string | null }) => [r.externalId, r.workplace]),
  );

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
        const detail = mapContractDetailOverrides(section, data) as Record<string, unknown>;
        const workplace = workplaceById.get(contractId) ?? null;
        const mailing = mergeAddressFields(
          {
            addrHouseNo: (detail.addrHouseNo as string) ?? null,
            addrMoo: (detail.addrMoo as string) ?? null,
            addrVillage: (detail.addrVillage as string) ?? null,
            addrSoi: (detail.addrSoi as string) ?? null,
            addrStreet: (detail.addrStreet as string) ?? null,
            addrSubdistrict: (detail.addrSubdistrict as string) ?? null,
            addrDistrict: (detail.addrDistrict as string) ?? null,
            addrProvince: (detail.addrProvince as string) ?? null,
            addrPostalCode: (detail.addrPostalCode as string) ?? null,
          },
          isLikelyAddressLine(workplace) ? parseThaiAddressLine(workplace!) : {},
        );
        await db
          .update(contracts)
          .set({
            addrHouseNo: mailing.addrHouseNo,
            addrMoo: mailing.addrMoo,
            addrVillage: mailing.addrVillage,
            addrSoi: mailing.addrSoi,
            addrStreet: mailing.addrStreet,
            addrSubdistrict: mailing.addrSubdistrict,
            addrDistrict: mailing.addrDistrict,
            addrProvince: mailing.addrProvince,
            addrPostalCode: mailing.addrPostalCode,
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

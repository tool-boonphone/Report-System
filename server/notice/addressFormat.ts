import { isLikelyAddressLine, mergeAddressFields, parseThaiAddressLine, type ContactAddressFields } from "../api/addressFields";
import { inferSubdistrictFromMisplacedDistrict, isAmphoeInProvince } from "../api/thaiGeography";

/** ฟิลด์ที่อยู่สำหรับจ่าหน้าซองไปรษณีย์ / Notice */
export type NoticeMailingAddress = ContactAddressFields & {
  workplace?: string | null;
  /** อำเภอ/ตำบลตามบัตร ปชช. — ใช้เติมตำบลเมื่อมีแค่อำเภอจาก detail API */
  idDistrict?: string | null;
  idProvince?: string | null;
};

function clean(s: string | null | undefined): string {
  return (s ?? "").trim();
}

function withPrefix(value: string, prefix: string): string {
  if (!value) return "";
  if (value.startsWith(prefix)) return value;
  return `${prefix}${value}`;
}

function mergeMailingFields(
  base: NoticeMailingAddress,
  extra: Partial<ContactAddressFields>,
): NoticeMailingAddress {
  const merged = mergeAddressFields(base, extra);
  return { ...base, ...merged };
}

/**
 * รูปแบบที่อยู่สำหรับ Excel จ่าหน้าซอง
 * ตัวอย่าง: 34/46 ถ.คลองถนน ต.บางแม่นาง อ.บางใหญ่ จ.นนทบุรี
 */
export function formatNoticeMailingAddress(r: NoticeMailingAddress): string {
  const parts: string[] = [];

  const house = clean(r.addrHouseNo);
  if (house) parts.push(house);

  const moo = clean(r.addrMoo);
  if (moo) parts.push(moo.match(/^หมู่/) ? moo : `หมู่ ${moo}`);

  const village = clean(r.addrVillage);
  if (village) parts.push(village);

  const soi = clean(r.addrSoi);
  if (soi) parts.push(withPrefix(soi, "ซ."));

  const street = clean(r.addrStreet);
  if (street) parts.push(withPrefix(street, "ถ."));

  const subdistrict = clean(r.addrSubdistrict);
  if (subdistrict) parts.push(withPrefix(subdistrict, "ต."));

  const district = clean(r.addrDistrict);
  if (district) parts.push(withPrefix(district, "อ."));

  const province = clean(r.addrProvince);
  if (province) parts.push(withPrefix(province, "จ."));

  if (parts.length > 0) {
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // fallback ข้อมูลเก่า (มีแค่อำเภอ+จังหวัด)
  const legacy: string[] = [];
  if (district) legacy.push(withPrefix(district, "อ."));
  if (province) legacy.push(withPrefix(province, "จ."));
  return legacy.join(" ").trim();
}

/** ดึงชื่อตำบลจาก customer list ที่เคยเก็บใน addrDistrict ก่อน enrich ทับ */
export function extractListTambonFallback(
  district: string | null | undefined,
  province: string | null | undefined,
  subdistrict: string | null | undefined,
): string | null {
  if (subdistrict) return subdistrict;
  return inferSubdistrictFromMisplacedDistrict(district, province, null).addrSubdistrict;
}

/** รวมที่อยู่จาก detail API + workplace + ตำบลเดิมจาก customer list */
export function mergeEnrichedMailingFields(
  detail: ContactAddressFields,
  existing: Partial<ContactAddressFields>,
  workplace: string | null | undefined,
): ContactAddressFields {
  const workplaceFields = isLikelyAddressLine(workplace) ? parseThaiAddressLine(workplace!) : {};
  const listTambon = extractListTambonFallback(
    existing.addrDistrict,
    existing.addrProvince,
    existing.addrSubdistrict,
  );
  return mergeAddressFields(
    detail,
    workplaceFields,
    listTambon ? { addrSubdistrict: listTambon } : {},
  );
}

function fallbackSubdistrictFromIdCard(r: NoticeMailingAddress): string | null {
  const idTambon = clean(r.idDistrict);
  const prov = clean(r.addrProvince);
  const idProv = clean(r.idProvince);
  if (!idTambon || !prov) return null;
  if (isAmphoeInProvince(idTambon, prov)) return null;
  if (idProv && idProv !== prov) return null;
  const dist = clean(r.addrDistrict);
  if (dist && idTambon === dist) return null;
  return idTambon;
}

/**
 * รวมฟิลด์ที่อยู่จาก DB + parse workplace เติมส่วนที่ขาด (เช่น ต. จาก customer API)
 */
export function resolveNoticeMailingFields(r: NoticeMailingAddress): NoticeMailingAddress {
  let base: NoticeMailingAddress = r;
  const workplace = clean(r.workplace);
  if (isLikelyAddressLine(workplace)) {
    const parsed = parseThaiAddressLine(workplace);
    base = mergeMailingFields(r, parsed);
    // workplace มักมี ต./อ./จ. ครบกว่า customer list
    for (const key of ["addrHouseNo", "addrMoo", "addrVillage", "addrSoi", "addrStreet", "addrSubdistrict", "addrDistrict", "addrProvince", "addrPostalCode"] as const) {
      if (parsed[key]) base = { ...base, [key]: parsed[key] };
    }
  }
  const inferred = inferSubdistrictFromMisplacedDistrict(
    base.addrDistrict,
    base.addrProvince,
    base.addrSubdistrict,
  );
  if (
    inferred.addrSubdistrict !== (base.addrSubdistrict ?? null)
    || inferred.addrDistrict !== (base.addrDistrict ?? null)
  ) {
    base = { ...base, ...inferred };
  }
  if (!base.addrSubdistrict && base.addrDistrict && isAmphoeInProvince(base.addrDistrict, base.addrProvince ?? "")) {
    const idSub = fallbackSubdistrictFromIdCard(base);
    if (idSub) base = { ...base, addrSubdistrict: idSub };
  }
  return base;
}

/**
 * รวมที่อยู่จากฟิลด์แยก + parse จาก workplace / บรรทัดเต็ม
 * (customer list เก็บที่อยู่ใน workplace_name → contracts.workplace)
 */
export function resolveNoticeMailingAddress(r: NoticeMailingAddress): string {
  return formatNoticeMailingAddress(resolveNoticeMailingFields(r));
}

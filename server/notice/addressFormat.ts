import { isLikelyAddressLine, mergeAddressFields, parseThaiAddressLine, type ContactAddressFields } from "../api/addressFields";

/** ฟิลด์ที่อยู่สำหรับจ่าหน้าซองไปรษณีย์ / Notice */
export type NoticeMailingAddress = ContactAddressFields & {
  workplace?: string | null;
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

/**
 * รวมฟิลด์ที่อยู่จาก DB + parse workplace เติมส่วนที่ขาด (เช่น ต. จาก customer API)
 */
export function resolveNoticeMailingFields(r: NoticeMailingAddress): NoticeMailingAddress {
  const workplace = clean(r.workplace);
  if (isLikelyAddressLine(workplace)) {
    return mergeMailingFields(r, parseThaiAddressLine(workplace));
  }
  return r;
}

/**
 * รวมที่อยู่จากฟิลด์แยก + parse จาก workplace / บรรทัดเต็ม
 * (customer list เก็บที่อยู่ใน workplace_name → contracts.workplace)
 */
export function resolveNoticeMailingAddress(r: NoticeMailingAddress): string {
  return formatNoticeMailingAddress(resolveNoticeMailingFields(r));
}

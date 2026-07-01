/**
 * ดึงฟิลด์ที่อยู่จาก contact_address (contract detail API)
 * รองรับชื่อ field หลายแบบจาก partner API
 */
export type ContactAddressFields = {
  addrHouseNo: string | null;
  addrMoo: string | null;
  addrVillage: string | null;
  addrSoi: string | null;
  addrStreet: string | null;
  addrSubdistrict: string | null;
  addrDistrict: string | null;
  addrProvince: string | null;
  addrPostalCode: string | null;
};

function pick(addr: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = addr[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

export function mapContactAddressFields(
  contactAddr: Record<string, unknown> | null | undefined,
): ContactAddressFields {
  const a = contactAddr ?? {};
  return {
    addrHouseNo: pick(a, ["house_no", "house_number", "address_no", "no", "home_no"]),
    addrMoo: pick(a, ["moo", "village_no", "moo_no"]),
    addrVillage: pick(a, ["village", "village_name"]),
    addrSoi: pick(a, ["soi", "alley", "soi_name"]),
    addrStreet: pick(a, ["road", "street", "road_name"]),
    addrSubdistrict: pick(a, ["tambon", "subdistrict", "sub_district", "district_name"]),
    addrDistrict: pick(a, ["amphure", "amphoe", "district"]),
    addrProvince: pick(a, ["province"]),
    addrPostalCode: pick(a, ["zipcode", "zip_code", "postal_code", "postcode", "zip"]),
  };
}

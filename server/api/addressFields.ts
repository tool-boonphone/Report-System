/**
 * ดึงฟิลด์ที่อยู่จาก contact_address (contract detail API)
 * รองรับชื่อ field หลายแบบจาก partner API + parse บรรทัดที่อยู่เต็ม
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

const EMPTY_ADDRESS: ContactAddressFields = {
  addrHouseNo: null,
  addrMoo: null,
  addrVillage: null,
  addrSoi: null,
  addrStreet: null,
  addrSubdistrict: null,
  addrDistrict: null,
  addrProvince: null,
  addrPostalCode: null,
};

const PLACEHOLDER_RE = /^(ที่อยู่ปัจจุบัน|ที่อยู่ตามบัตร(?:ประชาชน)?|ที่อยู่ทำงาน|ที่ทำงาน)$/;

function pick(addr: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = addr[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** ข้อความที่น่าจะเป็นที่อยู่จริง (ไม่ใช่ placeholder จากฟอร์ม) */
export function isLikelyAddressLine(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  if (t.length < 4) return false;
  if (PLACEHOLDER_RE.test(t)) return false;
  return /บ้านเลขที่|หมู่|ตำบล|ถนน|ซอย|ม\.|ต\.|อ\.|จ\.|\d+\/\d+/.test(t);
}

/** แยกบรรทัดที่อยู่ภาษาไทย เช่น "บ้านเลขที่ 5/3 หมู่ 3 ตำบลเสม็ดใต้ อำเภอบางคล้า จังหวัดฉะเชิงเทรา 24110" */
export function parseThaiAddressLine(line: string): ContactAddressFields {
  let text = line.trim();
  if (!text) return { ...EMPTY_ADDRESS };

  const result: ContactAddressFields = { ...EMPTY_ADDRESS };

  const zipM = text.match(/\s(\d{5})\s*$/);
  if (zipM) {
    result.addrPostalCode = zipM[1]!;
    text = text.slice(0, text.length - zipM[0].length).trim();
  }

  const takeSuffix = (regex: RegExp, assign: (v: string) => void, group = 1): void => {
    const m = text.match(regex);
    if (!m) return;
    const val = (m[group] ?? "").trim();
    if (!val) return;
    assign(val);
    text = text.slice(0, m.index).trim();
  };

  takeSuffix(/จังหวัด\s*(.+?)\s*$/u, (v) => { result.addrProvince = v; });
  if (!result.addrProvince) takeSuffix(/จ\.(.+?)\s*$/u, (v) => { result.addrProvince = v; });

  takeSuffix(/อำเภอ\s*(.+?)\s*$/u, (v) => { result.addrDistrict = v; });
  if (!result.addrDistrict) takeSuffix(/อ\.(.+?)\s*$/u, (v) => { result.addrDistrict = v; });

  takeSuffix(/ตำบล\s*(.+?)\s*$/u, (v) => { result.addrSubdistrict = v; });
  if (!result.addrSubdistrict) takeSuffix(/ต\.(.+?)\s*$/u, (v) => { result.addrSubdistrict = v; });

  takeSuffix(/ถนน\s*(.+?)\s*$/u, (v) => { result.addrStreet = v; });
  if (!result.addrStreet) takeSuffix(/ถ\.(.+?)\s*$/u, (v) => { result.addrStreet = v; });

  takeSuffix(/ซอย\s*(.+?)\s*$/u, (v) => { result.addrSoi = v; });
  if (!result.addrSoi) takeSuffix(/ซ\.(.+?)\s*$/u, (v) => { result.addrSoi = v; });

  const houseM = text.match(/บ้านเลขที่\s*(\d+(?:\/\d+)?(?:-\d+)?)/u);
  if (houseM) {
    result.addrHouseNo = houseM[1]!;
    text = text.replace(houseM[0], " ").replace(/\s+/g, " ").trim();
  } else {
    const leadNum = text.match(/^(\d+(?:\/\d+)?(?:-\d+)?)\b/u);
    if (leadNum) {
      result.addrHouseNo = leadNum[1]!;
      text = text.slice(leadNum[0].length).trim();
    }
  }

  const mooM = text.match(/หมู่\s*(?:ที่\s*)?(\d+)/u) ?? text.match(/ม\.(\d+)/u);
  if (mooM) {
    result.addrMoo = mooM[1]!;
    text = text.replace(mooM[0], " ").replace(/\s+/g, " ").trim();
  }

  const villageM = text.match(/(?:หมู่บ้าน)([ก-๙a-zA-Z0-9][^\s]+(?:\s+[ก-๙a-zA-Z0-9][^\s]+)*)/u)
    ?? text.match(/(?<!เลขที่\s)บ้าน([ก-๙a-zA-Z0-9][^\s]+)/u);
  if (villageM) {
    result.addrVillage = villageM[1]!.trim();
  }

  return result;
}

export function mergeAddressFields(
  primary: ContactAddressFields,
  ...fallbacks: Array<Partial<ContactAddressFields>>
): ContactAddressFields {
  const merged = { ...primary };
  for (const fb of fallbacks) {
    for (const key of Object.keys(fb) as Array<keyof ContactAddressFields>) {
      if (!merged[key] && fb[key]) merged[key] = fb[key]!;
    }
  }
  return merged;
}

export function mapContactAddressFields(
  contactAddr: Record<string, unknown> | null | undefined,
): ContactAddressFields {
  const a = contactAddr ?? {};
  const structured: ContactAddressFields = {
    addrHouseNo: pick(a, ["house_no", "house_number", "address_no", "no", "home_no", "addr_no"]),
    addrMoo: pick(a, ["moo", "village_no", "moo_no"]),
    addrVillage: pick(a, ["village", "village_name"]),
    addrSoi: pick(a, ["soi", "alley", "soi_name"]),
    addrStreet: pick(a, ["road", "street", "road_name"]),
    addrSubdistrict: pick(a, [
      "tambon",
      "subdistrict",
      "sub_district",
      "tumbol",
      "tambon_name",
      "subdistrict_name",
      "ตำบล",
    ]),
    addrDistrict: pick(a, ["amphure", "amphoe", "district"]),
    addrProvince: pick(a, ["province"]),
    addrPostalCode: pick(a, ["zipcode", "zip_code", "postal_code", "postcode", "zip"]),
  };

  const fullLine = pick(a, [
    "address",
    "address_text",
    "full_address",
    "detail",
    "line1",
    "line2",
    "current_address",
    "contact_address",
    "addr",
    "address_detail",
    "description",
  ]);
  if (fullLine && isLikelyAddressLine(fullLine)) {
    return mergeAddressFields(structured, parseThaiAddressLine(fullLine));
  }

  return structured;
}

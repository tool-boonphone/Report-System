import geography from "../data/thaiGeography.json";

type GeographyData = {
  amphoeByProvince: Record<string, string[]>;
  tambonToAmphoe: Record<string, string>;
};

const data = geography as GeographyData;

const amphoeSets = new Map<string, Set<string>>();
for (const [province, names] of Object.entries(data.amphoeByProvince)) {
  amphoeSets.set(province, new Set(names));
}

function tambonKey(tambon: string, province: string): string {
  return `${tambon.trim()}\0${province.trim()}`;
}

/** ชื่อนี้เป็นอำเภอ/เขตในจังหวัดหรือไม่ */
export function isAmphoeInProvince(district: string, province: string): boolean {
  const set = amphoeSets.get(province.trim());
  if (!set) return false;
  return set.has(district.trim());
}

/** หาอำเภอจากชื่อตำบล + จังหวัด (ถ้ามีในฐานข้อมูล) */
export function resolveAmphoeForTambon(tambon: string, province: string): string | null {
  return data.tambonToAmphoe[tambonKey(tambon, province)] ?? null;
}

/**
 * ตำบลเมือง — ชื่อตำบลตรงกับชื่ออำเภอ (เช่น ต.ตาคลี อ.ตาคลี, ต.ปากท่อ อ.ปากท่อ)
 * API มักใส่แค่ชื่ออำเภอโดยไม่แยกตำบล
 */
export function isAmphoeSeatTambon(name: string, province: string): boolean {
  const n = name.trim();
  const p = province.trim();
  if (!n || !p) return false;
  if (!isAmphoeInProvince(n, p)) return false;
  return resolveAmphoeForTambon(n, p) === n;
}

/**
 * FF365 customer list มักเก็บชื่อตำบลใน current_district → addrDistrict
 * ถ้าไม่ใช่อำเภอ ให้ย้ายเป็น addrSubdistrict และเติมอำเภอจาก lookup
 */
export function inferSubdistrictFromMisplacedDistrict(
  district: string | null | undefined,
  province: string | null | undefined,
  subdistrict: string | null | undefined,
): { addrSubdistrict: string | null; addrDistrict: string | null } {
  const dist = (district ?? "").trim();
  const prov = (province ?? "").trim();
  const sub = (subdistrict ?? "").trim();
  if (sub || !dist || !prov) {
    return { addrSubdistrict: sub || null, addrDistrict: dist || null };
  }
  if (isAmphoeInProvince(dist, prov)) {
    return { addrSubdistrict: null, addrDistrict: dist };
  }
  return {
    addrSubdistrict: dist,
    addrDistrict: resolveAmphoeForTambon(dist, prov),
  };
}

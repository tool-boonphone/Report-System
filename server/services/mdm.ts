/**
 * MDM Service — Phase 140
 *
 * ดึงข้อมูล last online จาก MDM API (PJ-Soft / mdm-th.com)
 * โดยใช้ Serial Number (SN) เป็น key
 *
 * Design:
 *   - แต่ละ section (Boonphone / Fastfone365) ใช้ API Key แยกกัน
 *   - ใช้ in-memory cache แยกต่างหากสำหรับแต่ละ section (TTL 5 นาที)
 *   - เรียก MDM API เพียงครั้งเดียวต่อ section ต่อ 5 นาที แล้ว cache device list
 *   - getBatchLastOnlineDays รับ serials + section แล้วคืน Map<SN, days | null>
 *
 * API Keys:
 *   - Boonphone   : MDM_API_KEY_BOONPHONE  (env var)
 *   - Fastfone365 : MDM_API_KEY_FASTFONE365 (env var)
 *
 * Phase 2 (อนาคต): sync รายวันแล้วบันทึกลง DB
 */

import type { SectionKey } from "../../shared/const";

const MDM_BASE_URL = "https://mdm-th.com/api/mdm";

/** จำนวนมิลลิวินาทีที่ cache device list ไว้ (5 นาที) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * ดึง API Key ตาม section
 * ใช้ environment variable เป็นหลัก — fallback ไปยัง hardcode key สำหรับ backward compat
 */
function getApiKey(section: SectionKey): string {
  if (section === "Boonphone") {
    return (
      process.env.MDM_API_KEY_BOONPHONE ??
      "SQVU3kreXni6vBwOVhmiRF7gEGsxteB2Ui5CJJyCZbnYy606jhuIqX2Qv5YuWjji"
    );
  }
  if (section === "Fastfone365") {
    return (
      process.env.MDM_API_KEY_FASTFONE365 ??
      "16tyd01JeldHVEeHjyrLWxVEm0yPFnQfKwp0Qql9BL1LiXNdyfGDjdnvtR6ZCkhb"
    );
  }
  // fallback (ไม่ควรเกิดขึ้น)
  return process.env.MDM_API_KEY_BOONPHONE ?? "";
}

/** Cache สำหรับ device list แยกตาม section */
const deviceListCacheMap = new Map<
  SectionKey,
  { data: Map<string, string>; fetchedAt: number }
>();

/**
 * ดึง device list ทั้งหมดจาก MDM API แล้ว map SN → lastTime
 * ใช้ in-memory cache 5 นาที แยกต่างหากสำหรับแต่ละ section
 */
async function fetchDeviceListMap(
  section: SectionKey,
): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = deviceListCacheMap.get(section);

  // คืน cache ถ้ายังไม่หมดอายุ
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = getApiKey(section);
  if (!apiKey) {
    console.warn(`[MDM] No API key configured for section: ${section}`);
    return new Map();
  }

  const res = await fetch(`${MDM_BASE_URL}/devices`, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(15_000), // timeout 15 วินาที
  });

  if (!res.ok) {
    throw new Error(
      `MDM API error [${section}]: ${res.status} ${res.statusText}`,
    );
  }

  const json = await res.json();

  // response อาจเป็น array โดยตรง หรือ { data: [...] }
  const devices: Array<{ sn?: string; lastTime?: string }> = Array.isArray(json)
    ? json
    : (json?.data ?? json?.devices ?? []);

  const snMap = new Map<string, string>();
  for (const d of devices) {
    if (d.sn && d.lastTime) {
      snMap.set(d.sn.trim().toUpperCase(), d.lastTime);
    }
  }

  // บันทึก cache
  deviceListCacheMap.set(section, { data: snMap, fetchedAt: now });
  return snMap;
}

/**
 * คำนวณจำนวนวันที่ผ่านไปนับจาก lastTime จนถึงวันนี้
 * โดยตัด time ออก เปรียบเทียบแค่วันที่
 *
 * @returns 0 = วันนี้, 1 = เมื่อวาน, N = เมื่อ N วันที่แล้ว, null = ไม่มีข้อมูล
 */
function calcDaysSince(lastTime: string): number | null {
  // lastTime format: "2026-05-27 13:16:45"
  const datePart = lastTime.split(" ")[0]; // "2026-05-27"
  if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;

  const lastDate = new Date(`${datePart}T00:00:00`);
  if (isNaN(lastDate.getTime())) return null;

  const today = new Date();
  // ตัด time ออก — เปรียบเทียบแค่วันที่
  const todayDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );

  const diffMs = todayDate.getTime() - lastDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * ดึง lastOnlineDays สำหรับ SN เดียว
 * ใช้ device list cache เพื่อลด API calls
 *
 * @param serial  - Serial Number ของอุปกรณ์
 * @param section - Section ที่ต้องการดึงข้อมูล (Boonphone / Fastfone365)
 * @returns จำนวนวัน (0, 1, 2, N) หรือ null ถ้าไม่เจอ SN หรือ error
 */
export async function getDeviceLastOnlineDays(
  serial: string,
  section: SectionKey,
): Promise<number | null> {
  if (!serial || !serial.trim()) return null;
  try {
    const snMap = await fetchDeviceListMap(section);
    const lastTime = snMap.get(serial.trim().toUpperCase());
    if (!lastTime) return null;
    return calcDaysSince(lastTime);
  } catch (err) {
    console.error(`[MDM][${section}] getDeviceLastOnlineDays error:`, err);
    return null;
  }
}

/**
 * ดึง lastOnlineDays สำหรับ SN หลายตัวพร้อมกัน (batch)
 * ใช้ device list cache ร่วมกัน — เรียก API แค่ครั้งเดียวต่อ section
 *
 * @param serials - array ของ SN
 * @param section - Section ที่ต้องการดึงข้อมูล (Boonphone / Fastfone365)
 * @returns Map<SN, days | null>
 */
export async function getBatchLastOnlineDays(
  serials: string[],
  section: SectionKey,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!serials.length) return result;

  try {
    const snMap = await fetchDeviceListMap(section);
    for (const serial of serials) {
      if (!serial || !serial.trim()) {
        result.set(serial, null);
        continue;
      }
      const key = serial.trim().toUpperCase();
      const lastTime = snMap.get(key);
      result.set(serial, lastTime ? calcDaysSince(lastTime) : null);
    }
  } catch (err) {
    console.error(`[MDM][${section}] getBatchLastOnlineDays error:`, err);
    // คืน null ทั้งหมดถ้า error
    for (const serial of serials) {
      result.set(serial, null);
    }
  }

  return result;
}

/**
 * ล้าง device list cache ของ section ที่ระบุ หรือทั้งหมดถ้าไม่ระบุ
 * (ใช้สำหรับ testing หรือ force refresh)
 */
export function clearMdmCache(section?: SectionKey): void {
  if (section) {
    deviceListCacheMap.delete(section);
  } else {
    deviceListCacheMap.clear();
  }
}

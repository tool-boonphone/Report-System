/**
 * MDM Service — Phase 140 (v3)
 *
 * ดึงข้อมูล last online จาก MDM API (PJ-Soft / mdm-th.com)
 * โดยใช้ Serial Number (deviceId ใน MDM = serial_no ใน contracts table) เป็น key
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
 * Auth: X-API-Key: <API_KEY>
 * Endpoint: GET /api/mdm/devices?pageNum=1&pageSize=1000
 * Response: { total: number, rows: [{ deviceId, lastTime, contract, imei, ... }] }
 *
 * MDM field mapping:
 *   deviceId  = Serial Number (ตรงกับ serial_no ใน contracts table)
 *   lastTime  = เวลาออนไลน์ล่าสุด "YYYY-MM-DD HH:mm:ss"
 */

import type { SectionKey } from "../../shared/const";

const MDM_BASE_URL = "https://mdm-th.com/api/mdm";

/** จำนวนมิลลิวินาทีที่ cache device list ไว้ (5 นาที) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * ดึง API Key ตาม section
 * ใช้ environment variable เป็นหลัก — fallback ไปยัง hardcode key
 */
function getApiKey(section: SectionKey): string {
  if (section === "Boonphone") {
    return (
      process.env.MDM_API_KEY_BOONPHONE ??
      "isvEwiE1cRWyEy5bFWEVX6QSmQHv5a4PMvQ6NlV2mmFYSn46df6jn7chbSVJCBPq"
    );
  }
  if (section === "Fastfone365") {
    return (
      process.env.MDM_API_KEY_FASTFONE365 ??
      "u66XGmwOYbAWj2xBJaP5Z9hs0iuijligqBvx2YtHeIAIDwx87wCoojJbwpKwqBeW"
    );
  }
  return process.env.MDM_API_KEY_BOONPHONE ?? "";
}

/**
 * Cache สำหรับ device list แยกตาม section
 * Map<serialNo (uppercase), lastTime string>
 */
const deviceListCacheMap = new Map<
  SectionKey,
  { data: Map<string, string>; fetchedAt: number }
>();

/**
 * ดึง device list ทั้งหมดจาก MDM API แล้ว map serialNo → lastTime
 * ใช้ in-memory cache 5 นาที แยกต่างหากสำหรับแต่ละ section
 *
 * MDM API:
 *   GET /api/mdm/devices?pageNum=1&pageSize=1000
 *   X-API-Key: <API_KEY>
 *   Response: { total: number, rows: [{ deviceId, lastTime, ... }] }
 *   deviceId = Serial Number ของอุปกรณ์
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

  // ดึงข้อมูลแบบ pagination จนครบทุก device
  const PAGE_SIZE = 1000;
  // Map<serialNo (uppercase), lastTime>
  const snMap = new Map<string, string>();
  let pageNum = 1;
  let total = 0;
  let fetched = 0;

  do {
    const url = `${MDM_BASE_URL}/devices?pageNum=${pageNum}&pageSize=${PAGE_SIZE}`;
    const res = await fetch(url, {
      headers: {
        "X-API-Key": apiKey,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(30_000), // timeout 30 วินาที
    });

    if (!res.ok) {
      throw new Error(
        `MDM API error [${section}] page ${pageNum}: ${res.status} ${res.statusText}`,
      );
    }

    const json = await res.json();

    // response format: { total: number, rows: [...] }
    const devices: Array<{
      deviceId?: string;
      lastTime?: string;
    }> = Array.isArray(json)
      ? json
      : (json?.rows ?? json?.data ?? json?.devices ?? []);

    if (pageNum === 1) {
      total = json?.total ?? devices.length;
      console.log(`[MDM][${section}] Total devices: ${total}`);
    }

    for (const d of devices) {
      // deviceId ใน MDM = Serial Number ของอุปกรณ์ (ตรงกับ serial_no ใน contracts table)
      if (d.deviceId && d.lastTime) {
        snMap.set(d.deviceId.trim().toUpperCase(), d.lastTime);
      }
    }

    fetched += devices.length;
    pageNum++;
  } while (fetched < total && total > 0);

  console.log(`[MDM][${section}] Loaded ${snMap.size} devices (total: ${total})`);

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
 * @param serial  - Serial Number ของอุปกรณ์ (ตรงกับ serial_no ใน contracts table)
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
 * @param serials - array ของ Serial Number (ตรงกับ serial_no ใน contracts table)
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
      // normalize เป็น uppercase เพื่อ case-insensitive match
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

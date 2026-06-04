/**
 * MDM Router — Phase 140
 *
 * tRPC endpoints สำหรับดึงข้อมูล last online จาก MDM API (PJ-Soft)
 * ใช้ Serial Number (SN) เป็น key แยกตาม section
 *
 * Endpoints:
 *   - mdm.batchLastOnlineDays({ section, serials }) → Record<SN, days | null>
 */
import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import { sectionSchema, type SectionKey } from "../../shared/const";
import { getBatchLastOnlineDays, getDeviceLocation } from "../services/mdm";
import { getDb } from "../db";
import { deviceLocationLogs } from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";

/**
 * ใช้ permission watch_group/view เป็น baseline
 * (ทั้ง watch_group และ suspected_bad_debt ต้องการ online data)
 */
const viewProcedure = requirePermission("watch_group", "view");

export const mdmRouter = router({
  /**
   * ดึง lastOnlineDays สำหรับ SN หลายตัวพร้อมกัน แยกตาม section
   * คืน object { [sn]: days | null }
   *
   * days = 0 → ออนไลน์วันนี้
   * days = 1 → ออนไลน์เมื่อวาน
   * days = N → ออนไลน์เมื่อ N วันที่แล้ว
   * null → ไม่พบ SN ใน MDM หรือ API error
   */
  batchLastOnlineDays: viewProcedure
    .input(
      z.object({
        section: sectionSchema,
        serials: z.array(z.string()).max(500), // จำกัดไม่เกิน 500 SN ต่อ request
      })
    )
    .query(async ({ input }) => {
      const { section, serials } = input;

      // กรอง SN ที่ว่างออก
      const validSerials = serials.filter((s) => s && s.trim());
      if (validSerials.length === 0) return {};

      const resultMap = await getBatchLastOnlineDays(validSerials, section);

      // แปลง Map เป็น plain object เพื่อส่งผ่าน tRPC
      const result: Record<string, number | null> = {};
      Array.from(resultMap.entries()).forEach(([sn, days]) => {
        result[sn] = days;
      });
      return result;
    }),

  /**
   * ดึงประวัติ GPS location จาก device_location_logs table
   * (append-only log ที่บันทึกระหว่าง MDM sync)
   *
   * @param section  - Section ที่ต้องการดึงข้อมูล
   * @param serialNo - Serial Number ของอุปกรณ์
   * @param limit    - จำนวน record สูงสุดที่ต้องการ (default 20, max 100)
   */
  getLocationLogs: viewProcedure
    .input(
      z.object({
        section: sectionSchema,
        serialNo: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const db = await getDb(section);
      if (!db) return [];

      const logs = await db
        .select()
        .from(deviceLocationLogs)
        .where(
          and(
            eq(deviceLocationLogs.section, section),
            eq(deviceLocationLogs.serialNo, input.serialNo.trim().toUpperCase()),
          )
        )
        .orderBy(desc(deviceLocationLogs.recordedAt))
        .limit(input.limit);

      return logs;
    }),

  /**
   * ดึง GPS location ปัจจุบันของ device จาก MDM API โดยตรง (real-time)
   * ใช้ mdmDeviceId (MDM internal ID) ไม่ใช่ Serial Number
   *
   * @param section     - Section ที่ต้องการดึงข้อมูล
   * @param mdmDeviceId - MDM internal ID ของอุปกรณ์
   */
  fetchLiveLocation: viewProcedure
    .input(
      z.object({
        section: sectionSchema,
        mdmDeviceId: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const location = await getDeviceLocation(input.mdmDeviceId, section);
      return location; // null ถ้า device offline หรือไม่มี GPS
    }),
});

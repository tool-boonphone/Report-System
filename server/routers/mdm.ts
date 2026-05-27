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
import { sectionSchema } from "../../shared/const";
import { getBatchLastOnlineDays } from "../services/mdm";

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
});

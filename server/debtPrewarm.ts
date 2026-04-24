/**
 * debtPrewarm.ts — Pre-warm debt cache ตอน server start
 *
 * เรียก listDebtTarget + listDebtCollected สำหรับทุก section ใน background
 * เพื่อให้ผู้ใช้คนแรกได้รับข้อมูลจาก cache แทนที่จะรอ query ~7 วินาที
 */
import { listDebtTarget, listDebtCollected } from "./debtDb";
import { setCachedTarget, setCachedCollected } from "./debtCache";
import { SECTIONS } from "../shared/const";

/**
 * prewarmDebtCache — เรียกใน background หลัง server start
 * ไม่ block startup, error ไม่ crash server
 */
export async function prewarmDebtCache(): Promise<void> {
  console.log("[debtPrewarm] Starting background cache pre-warm...");
  const startAll = Date.now();

  for (const section of SECTIONS) {
    // Pre-warm target (เป้าเก็บหนี้)
    try {
      const t0 = Date.now();
      const targetResult = await listDebtTarget({ section });
      setCachedTarget(section, targetResult);
      console.log(
        `[debtPrewarm] ✓ listTarget(${section}) cached in ${Date.now() - t0}ms`
      );
    } catch (err) {
      console.warn(`[debtPrewarm] ✗ listTarget(${section}) failed:`, err);
    }

    // Pre-warm collected (ยอดเก็บหนี้)
    try {
      const t0 = Date.now();
      const collectedResult = await listDebtCollected({ section });
      setCachedCollected(section, collectedResult);
      console.log(
        `[debtPrewarm] ✓ listCollected(${section}) cached in ${Date.now() - t0}ms`
      );
    } catch (err) {
      console.warn(`[debtPrewarm] ✗ listCollected(${section}) failed:`, err);
    }
  }

  console.log(
    `[debtPrewarm] All sections pre-warmed in ${Date.now() - startAll}ms`
  );
}

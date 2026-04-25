/**
 * debtPrewarm.ts — Pre-warm debt cache ตอน server start
 *
 * เรียก listDebtTargetStream + listDebtCollectedStream สำหรับทุก section ใน background
 * เพื่อให้ผู้ใช้คนแรกได้รับข้อมูลจาก cache แทนที่จะรอ query ~7 วินาที
 *
 * Phase 32: เพิ่ม registerBgRefresh เพื่อให้ debtCache.ts สามารถ trigger
 *   background refresh ได้เมื่อ cache ใกล้หมดอายุ (stale-while-revalidate)
 *
 * Phase 45: เปลี่ยนจาก listDebtTarget/listDebtCollected (โหลดทั้งหมดพร้อมกัน ~185MB)
 *   มาใช้ listDebtTargetStream + listDebtCollectedStream (streaming, ลด peak memory)
 *   เพื่อป้องกัน OOM ใน Cloud Run ระหว่าง prewarm
 */
import { listDebtTargetStream, listDebtCollectedStream } from "./debtDb";
import { setCachedTarget, setCachedCollected, registerBgRefresh } from "./debtCache";
import { SECTIONS } from "../shared/const";
import type { SectionKey } from "../shared/const";

/**
 * Collect all rows from a target stream generator into an array.
 * Uses streaming to avoid holding all data in memory at once during computation.
 */
async function collectStreamTarget(section: SectionKey): Promise<{ rows: any[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const gen = listDebtTargetStream({ section, batchSize: 200 });
  for await (const batch of gen) {
    // listDebtTargetStream yields any[] (raw batch array) directly
    rows.push(...(batch as any[])); // eslint-disable-line @typescript-eslint/no-explicit-any
    // Yield to event loop between batches to prevent blocking
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { rows };
}

/**
 * Collect all rows from a collected stream generator into an array.
 */
async function collectStreamCollected(section: SectionKey): Promise<{ rows: any[]; hasPrincipalBreakdown: boolean }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let hasPrincipalBreakdown = true;
  const gen = listDebtCollectedStream({ section, batchSize: 200 });
  for await (const chunk of gen) {
    rows.push(...chunk.rows);
    if (chunk.meta?.hasPrincipalBreakdown != null) {
      hasPrincipalBreakdown = chunk.meta.hasPrincipalBreakdown as boolean;
    }
    // Yield to event loop between batches to prevent blocking
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { rows, hasPrincipalBreakdown };
}

/**
 * prewarmDebtCache — เรียกใน background หลัง server start
 * ไม่ block startup, error ไม่ crash server
 */
export async function prewarmDebtCache(): Promise<void> {
  // Register background refresh callbacks ก่อน (Phase 32: stale-while-revalidate)
  // Phase 45: ใช้ stream functions เพื่อลด peak memory
  registerBgRefresh(
    async (section: string) => {
      return await collectStreamTarget(section as SectionKey);
    },
    async (section: string) => {
      return await collectStreamCollected(section as SectionKey);
    },
  );

  console.log("[debtPrewarm] Starting background cache pre-warm (streaming mode)...");
  const startAll = Date.now();

  for (const section of SECTIONS) {
    // Pre-warm target (เป้าเก็บหนี้)
    try {
      const t0 = Date.now();
      const targetResult = await collectStreamTarget(section);
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
      const collectedResult = await collectStreamCollected(section);
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

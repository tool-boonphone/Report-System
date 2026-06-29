import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, appProcedure } from "../_core/trpc";
import { runSectionSync, isSyncRunning, getSyncStatus, requestCancelSync, SYNC_STAGES, syncMdmOnlineDays } from "../sync/runner";
import { isPostProcessRunning, runPostSyncPipeline } from "../sync/postProcess";
import {
  getLastSyncedAt,
  listSyncLogs,
  getRunningSyncs,
  getDbSyncStatus,
  getPostProcessStatus,
  clearStuckSyncLogs,
} from "../sync/syncLog";
import { desc, eq, and, gt, lt, sql } from "drizzle-orm";
import { syncLogs, contracts, deviceLocationLogs } from "../../drizzle/schema";
import { getDb } from "../db";
import { sectionSchema, type SectionKey } from "../../shared/const";
import { getDeviceLocation } from "../services/mdm";

// sectionSchema imported from shared/const — normalizes any case to canonical SectionKey

export const syncRouter = router({
  /**
   * Kick off a manual sync (fire-and-forget).
   * Returns immediately with { queued: true } so Cloud Run doesn't timeout.
   * Frontend polls sync.status for live progress updates.
   */
  trigger: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input }) => {
      const section = input.section as SectionKey;
      if (isSyncRunning(section)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Sync for ${section} is already running`,
        });
      }
      // Fire-and-forget: start sync in background, return immediately.
      // Cloud Run has a ~60s request timeout; sync takes 5-15 min, so we
      // must NOT await here. The frontend polls sync.status for progress.
      runSectionSync(section, "manual").catch((err) => {
        console.error(`[sync.trigger] ${section} failed:`, err?.message ?? err);
      });
      return { queued: true, section };
    }),

  /**
   * Resume post-sync only: fillPeriodNos + populate debt cache (no API re-download).
   * Fire-and-forget; uses entity=post_process log (not auto-cleared by entity=all zombie check).
   */
  postProcess: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Re-Sync" });
        }
      }
      const section = input.section as SectionKey;
      if (isSyncRunning(section)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Sync สำหรับ ${section} ยังรันอยู่ — รอให้จบหรือยกเลิกก่อน`,
        });
      }
      if (isPostProcessRunning(section)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Post-process สำหรับ ${section} กำลังรันอยู่แล้ว`,
        });
      }
      runPostSyncPipeline(section).catch((err) => {
        console.error(`[sync.postProcess] ${section} failed:`, err?.message ?? err);
      });
      return { queued: true, section };
    }),

  /**
   * Sync status — reads from DB (cross-instance safe for Cloud Run).
   * Falls back to in-memory lock if DB returns running=false but lock is set
   * (same-instance fast path).
   */
  status: appProcedure.query(async () => {
    // Fetch DB status for both sections in parallel
    const [bpDb, ffDb, bpPost, ffPost] = await Promise.all([
      getDbSyncStatus("Boonphone"),
      getDbSyncStatus("Fastfone365"),
      getPostProcessStatus("Boonphone"),
      getPostProcessStatus("Fastfone365"),
    ]);

    // In-memory fallback (same instance)
    const bpMem = getSyncStatus("Boonphone");
    const ffMem = getSyncStatus("Fastfone365");

    const bpRunning = (bpDb?.running ?? false) || isSyncRunning("Boonphone");
    const ffRunning = (ffDb?.running ?? false) || isSyncRunning("Fastfone365");
    const bpPostRunning = (bpPost?.running ?? false) || isPostProcessRunning("Boonphone");
    const ffPostRunning = (ffPost?.running ?? false) || isPostProcessRunning("Fastfone365");

    // Helper: derive stageIndex from currentStage when in-memory is unavailable (cross-instance)
    const deriveStageIndex = (stage: string | null | undefined): number | null => {
      if (stage == null) return null;
      const idx = SYNC_STAGES.indexOf(stage as any);
      return idx >= 0 ? idx : null;
    };

    // Prefer DB as primary source (cross-instance safe).
    // Fall back to in-memory only when DB has no data (same-instance fast path).
    const bpCurrentStage = bpDb?.currentStage ?? bpMem?.currentStage ?? null;
    const ffCurrentStage = ffDb?.currentStage ?? ffMem?.currentStage ?? null;

    // progress: DB is primary (written by setStage/setSubProgress via updateSyncLogStage).
    // In-memory fallback only when DB progress is null (e.g. very start of sync before first DB write).
    const bpProgress = bpDb?.progress ?? bpMem?.progress ?? null;
    const ffProgress = ffDb?.progress ?? ffMem?.progress ?? null;

    // stageIndex: derive from currentStage (works cross-instance).
    // totalStages: always use SYNC_STAGES.length when running.
    const bpStageIndex = bpMem?.stageIndex ?? deriveStageIndex(bpCurrentStage);
    const ffStageIndex = ffMem?.stageIndex ?? deriveStageIndex(ffCurrentStage);
    const bpTotalStages = bpRunning ? SYNC_STAGES.length : null;
    const ffTotalStages = ffRunning ? SYNC_STAGES.length : null;

    return {
      Boonphone: {
        running: bpRunning,
        startedAt: bpDb?.startedAt?.getTime() ?? bpMem?.startedAt ?? null,
        progress: bpProgress,
        currentStage: bpCurrentStage,
        stageIndex: bpStageIndex,
        totalStages: bpTotalStages,
        postProcess: {
          running: bpPostRunning,
          startedAt: bpPost?.startedAt?.getTime() ?? null,
          progress: bpPost?.progress ?? null,
          currentStage: bpPost?.currentStage ?? null,
        },
      },
      Fastfone365: {
        running: ffRunning,
        startedAt: ffDb?.startedAt?.getTime() ?? ffMem?.startedAt ?? null,
        progress: ffProgress,
        currentStage: ffCurrentStage,
        stageIndex: ffStageIndex,
        totalStages: ffTotalStages,
        postProcess: {
          running: ffPostRunning,
          startedAt: ffPost?.startedAt?.getTime() ?? null,
          progress: ffPost?.progress ?? null,
          currentStage: ffPost?.currentStage ?? null,
        },
      },
      active: await getRunningSyncs(),
    };
  }),

  /**
   * Trigger MDM online days sync only (fast, ~30s).
   * ดึง MDM device list ครั้งเดียว แล้ว bulk update last_online_days ใน contracts
   * ไม่ต้องรอ Full Sync — ใช้ได้ทันทีหลัง deploy
   */
  /**
   * ตรวจสอบว่า MDM ข้อมูลเก่าหรือไม่ (last_online_days เป็น null สำหรับเครื่องที่มี serial_no)
   */
  isMdmStale: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const { getDb } = await import("../db");
      const { contracts } = await import("../../drizzle/schema");
      const { eq, and, isNotNull, count } = await import("drizzle-orm");
      
      const db = await getDb(section);
      if (!db) return { stale: false, staleCount: 0 };
      
      // ตรวจว่ามีข้อมูล MDM ใน DB แล้วหรือยัง
      // stale = true เฉพาะเมื่อ last_online_days เป็น NULL ทั้งหมด (ยังไม่เคย sync)
      // ถ้ามีข้อมูลอยู่แม้แต่ 1 record → stale: false ไม่ต้องโหลดใหม่
      const [mdmRes, serialRes] = await Promise.all([
        db.select({ value: count() }).from(contracts).where(
          and(eq(contracts.section, section), isNotNull(contracts.lastOnlineDays))
        ),
        db.select({ value: count() }).from(contracts).where(
          and(eq(contracts.section, section), isNotNull(contracts.serialNo))
        ),
      ]);
      const mdmCount = Number(mdmRes[0]?.value ?? 0);
      const serialCount = Number(serialRes[0]?.value ?? 0);
      // stale = true เฉพาะเมื่อยังไม่มีข้อมูล MDM เลย
      const stale = serialCount > 0 && mdmCount === 0;
      const staleCount = stale ? serialCount : 0;
      return { stale, staleCount };
    }),

  syncMdm: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Sync" });
        }
      }
      const section = input.section as SectionKey;
      // Fire-and-forget — รัน background ไม่ต้องรอ
      syncMdmOnlineDays(section).then((count) => {
        console.log(`[sync.syncMdm] ${section}: updated ${count} contracts`);
      }).catch((err) => {
        console.error(`[sync.syncMdm] ${section} failed:`, err?.message ?? err);
      });
      return { queued: true, section };
    }),

  /**
   * testMdm — Diagnostic endpoint: ทดสอบ MDM API connection โดยตรง
   * คืน status, masked key, และ body preview เพื่อ debug 403 บน Render
   */
  testMdm: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const rawKey =
        section === "Boonphone"
          ? (process.env.MDM_API_KEY_BOONPHONE ?? "")
          : (process.env.MDM_API_KEY_FASTFONE365 ?? "");
      const trimmedKey = rawKey.trim();
      const maskedKey = trimmedKey
        ? `${trimmedKey.slice(0, 6)}...${trimmedKey.slice(-4)} (len=${trimmedKey.length}, rawLen=${rawKey.length})`
        : "(empty)";
      const url = `https://mdm-th.com/api/mdm/devices?pageNum=1&pageSize=1`;
      try {
        const res = await fetch(url, {
          headers: {
            "X-API-Key": trimmedKey,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://mdm-th.com/",
            "Origin": "https://mdm-th.com",
          },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.text();
        return {
          section,
          maskedKey,
          url,
          status: res.status,
          statusText: res.statusText,
          bodyPreview: body.slice(0, 500),
          ok: res.ok,
        };
      } catch (err: any) {
        return {
          section,
          maskedKey,
          url,
          status: 0,
          statusText: "fetch error",
          bodyPreview: err?.message ?? String(err),
          ok: false,
        };
      }
    }),

  /**
   * getMdmApiKey — ส่ง MDM API key ไปยัง client เพื่อให้ client fetch MDM โดยตรง
   * จำเป็นเพราะ Cloudflare block IP ของ Render server (datacenter IP)
   * แต่ไม่ block IP ของ browser (residential/mobile IP)
   * Requires: login + sync permission
   */
  getMdmApiKey: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      // ไม่ต้องตรวจ permission — ทุก user ที่ login แล้วใช้งาน MDM ได้
      const section = input.section as SectionKey;
      const apiKey =
        section === "Boonphone"
          ? (process.env.MDM_API_KEY_BOONPHONE ?? "isvEwiE1cRWyEy5bFWEVX6QSmQHv5a4PMvQ6NlV2mmFYSn46df6jn7chbSVJCBPq").trim()
          : (process.env.MDM_API_KEY_FASTFONE365 ?? "u66XGmwOYbAWj2xBJaP5Z9hs0iuijligqBvx2YtHeIAIDwx87wCoojJbwpKwqBeW").trim();
      return { section, apiKey };
    }),

  /**
   * saveMdmData — รับ MDM device data จาก client แล้ว bulk update last_online_days ใน contracts
   * Client fetch MDM โดยตรง (ผ่าน residential IP ไม่ถูก Cloudflare block)
   * แล้วส่ง { serialNo, lastOnlineDays, lastOnlineAt, deviceLock }[] มาให้ server บันทึกลง DB
   * Requires: login + sync permission
   */
  saveMdmData: appProcedure
    .input(
      z.object({
        section: sectionSchema,
        devices: z.array(
          z.object({
            serialNo: z.string(),
            mdmDeviceId: z.number().int().nullable().optional(), // MDM internal ID — ใช้ดึง GPS location
            lastOnlineDays: z.number().int().nullable(),
            lastOnlineAt: z.string().nullable(), // "YYYY-MM-DD HH:mm:ss"
            deviceLock: z.boolean().nullable().optional(), // true=ล็อค, false=ปลดล็อค, null/undefined=ไม่มีข้อมูล
            lastType: z.number().int().nullable().optional(), // 0=offline, 1=online ณ ขณะ sync
            lossStatus: z.number().int().nullable().optional(), // 0=ปกติ, 1=Lost Mode (ดึง GPS ได้)
          })
        ).max(20000), // เพิ่มจาก 10,000 เป็น 20,000 รองรับ dataset ขนาดใหญ่
      })
    )
    .mutation(async ({ input }) => {
      // ไม่ต้องตรวจ permission — ทุก user ที่ login แล้วใช้งาน MDM ได้
      const section = input.section as SectionKey;
      const db = await getDb(section);
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

      // สร้าง Map<serialNo (uppercase), { mdmDeviceId, days, lastOnlineAt, deviceLock }> จาก input
      const snMap = new Map<string, { mdmDeviceId: number | null; days: number | null; lastOnlineAt: string | null; deviceLock: boolean | null; lastType: number | null; lossStatus: number | null }>();
      for (const d of input.devices) {
        if (d.serialNo) {
          snMap.set(d.serialNo.trim().toUpperCase(), {
            mdmDeviceId: d.mdmDeviceId ?? null,
            days: d.lastOnlineDays,
            lastOnlineAt: d.lastOnlineAt,
            deviceLock: d.deviceLock ?? null,
            lastType: d.lastType ?? null,
            lossStatus: d.lossStatus ?? null,
          });
        }
      }

      // ดึง externalId + serialNo ทั้งหมดของ section
      const rows = await db
        .select({ externalId: contracts.externalId, serialNo: contracts.serialNo })
        .from(contracts)
        .where(eq(contracts.section, section));

      const validRows = rows.filter((r: { externalId: string; serialNo: string | null }) => r.serialNo);
      console.log(`[saveMdmData] ${section}: ${validRows.length} contracts with serial_no, ${snMap.size} MDM devices`);

      if (validRows.length === 0) {
        return { section, updated: 0, total: 0 };
      }

      // สร้าง Map<externalId, MDM data> จาก validRows + snMap
      // เพื่อให้ UPDATE เฉพาะ row ที่พบใน MDM เท่านั้น
      // (ไม่ reset row ที่ไม่พบใน batch นี้ให้เป็น NULL)
      const matchedRows: { externalId: string; mdmDeviceId: number | null; days: number | null; lastOnlineAt: string | null; deviceLock: boolean | null; lastType: number | null; lossStatus: number | null }[] = [];
      for (const r of validRows) {
        const key = r.serialNo!.trim().toUpperCase();
        const mdm = snMap.get(key);
        if (mdm !== undefined) {
          matchedRows.push({
            externalId: r.externalId,
            mdmDeviceId: mdm.mdmDeviceId ?? null,
            days: mdm.days ?? null,
            lastOnlineAt: mdm.lastOnlineAt ?? null,
            deviceLock: mdm.deviceLock ?? null,
            lastType: mdm.lastType ?? null,
            lossStatus: mdm.lossStatus ?? null,
          });
        }
      }

      console.log(`[saveMdmData] ${section}: matched ${matchedRows.length}/${validRows.length} contracts to MDM devices`);

      if (matchedRows.length === 0) {
        // ไม่มี contract ใดที่ตรงกับ MDM เลย ไม่ต้อง UPDATE
        return { section, updated: 0, total: validRows.length };
      }

      // Bulk UPDATE ด้วย raw parameterized SQL CASE WHEN
      // UPDATE เฉพาะ row ที่ match เท่านั้น ไม่แตะต้อง row ที่ไม่พบ
      const BULK_BATCH = 500;
      let updated = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pool = (db as any).$client as import("pg").Pool;

      for (let i = 0; i < matchedRows.length; i += BULK_BATCH) {
        const batchRows = matchedRows.slice(i, i + BULK_BATCH);

        // params layout: [eid1, mdmId1, days1, at1, lock1, eid2, mdmId2, days2, at2, lock2, ..., section]
        const mdmIdWhenClauses: string[] = [];
        const daysWhenClauses: string[] = [];
        const atWhenClauses: string[] = [];
        const lockWhenClauses: string[] = [];
        const lossStatusWhenClauses: string[] = [];
        const inPlaceholders: string[] = [];
        const params: (string | number | boolean | null)[] = [];
        let paramIdx = 1;

        for (const r of batchRows) {
          const eidIdx = paramIdx++;
          const mdmIdIdx = paramIdx++;
          const daysIdx = paramIdx++;
          const atIdx = paramIdx++;
          const lockIdx = paramIdx++;
          const lossIdx = paramIdx++;

          params.push(r.externalId, r.mdmDeviceId, r.days, r.lastOnlineAt, r.deviceLock, r.lossStatus);

          mdmIdWhenClauses.push(`WHEN external_id = $${eidIdx} THEN $${mdmIdIdx}::integer`);
          daysWhenClauses.push(`WHEN external_id = $${eidIdx} THEN $${daysIdx}::integer`);
          atWhenClauses.push(`WHEN external_id = $${eidIdx} THEN $${atIdx}::varchar`);
          lockWhenClauses.push(`WHEN external_id = $${eidIdx} THEN $${lockIdx}::boolean`);
          lossStatusWhenClauses.push(`WHEN external_id = $${eidIdx} THEN $${lossIdx}::integer`);
          inPlaceholders.push(`$${eidIdx}`);

          if (r.days !== null) updated++;
        }

        // เพิ่ม section param สุดท้าย
        const sectionIdx = paramIdx++;
        params.push(section);

        const bulkSql = `
          UPDATE contracts
          SET
            mdm_device_id    = CASE ${mdmIdWhenClauses.join(" ")} ELSE mdm_device_id END,
            last_online_days = CASE ${daysWhenClauses.join(" ")} ELSE last_online_days END,
            last_online_at   = CASE ${atWhenClauses.join(" ")} ELSE last_online_at END,
            device_lock      = CASE ${lockWhenClauses.join(" ")} ELSE device_lock END,
            loss_status      = CASE ${lossStatusWhenClauses.join(" ")} ELSE loss_status END
          WHERE section = $${sectionIdx}
            AND external_id IN (${inPlaceholders.join(", ")})
        `;

        await pool.query(bulkSql, params);
      }

      console.log(`[saveMdmData] ${section}: updated ${updated}/${matchedRows.length} matched contracts (bulk SQL, with mdm_device_id)`);

      // ─── GPS Loop: ดึง GPS เฉพาะเครื่องที่ online (days=0) และถูกล็อก (deviceLock=true) ───
      // กรอง matchedRows เฉพาะที่ online วันนี้ (days=0) และ deviceLock=true
      // lastType=1 = MDM รายงานว่าเครื่องออนไลน์อยู่ ณ ขณะที่ sync → ดึง GPS ได้
      // lastType=0 = offline → ข้ามไปเลย ไม่ดึงซ้ำ
      // เงื่อนไข GPS: lastType=1 (online ณ ขณะ sync) + lossStatus=1 (Lost Mode เปิดอยู่ — MDM ดึง GPS ได้)
      const gpsTargets = matchedRows.filter(
        (r) => r.lastType === 1 && r.lossStatus === 1 && r.mdmDeviceId != null
      );

      if (gpsTargets.length > 0) {
        console.log(`[saveMdmData][GPS] ${section}: ${gpsTargets.length} devices to fetch GPS (lastType=1 online + lossStatus=1 Lost Mode)`);

        // สร้าง Map<externalId, serialNo> เพื่อ lookup serialNo ตอน insert log
        const externalIdToSerial = new Map<string, string>();
        for (const r of validRows) {
          if (r.serialNo) externalIdToSerial.set(r.externalId, r.serialNo);
        }

        // ดึง GPS แบบ sequential (ไม่ parallel เพื่อไม่ให้ MDM rate limit)
        // ใช้ delay 200ms ระหว่างแต่ละ request
        const GPS_DELAY_MS = 200;
        let gpsSuccess = 0;
        let gpsFail = 0;

        for (const target of gpsTargets) {
          try {
            const loc = await getDeviceLocation(target.mdmDeviceId!, section);
            if (loc && loc.latitude && loc.longitude) {
              const serialNo = externalIdToSerial.get(target.externalId) ?? "";
              // Insert ลง device_location_logs
              await db.insert(deviceLocationLogs).values({
                section,
                serialNo,
                mdmDeviceId: target.mdmDeviceId!,
                latitude: loc.latitude,
                longitude: loc.longitude,
                altitude: loc.altitude ?? null,
                speed: loc.speed ?? null,
              });
              gpsSuccess++;
            } else {
              gpsFail++;
            }
          } catch (gpsErr) {
            // ดึงไม่ได้ → ข้ามไปเลย ไม่ retry
            gpsFail++;
            console.warn(`[saveMdmData][GPS] ${section}: mdmDeviceId=${target.mdmDeviceId} skip (no retry):`, (gpsErr as Error).message);
          }
          // delay เพื่อไม่ให้ MDM rate limit
          await new Promise((res) => setTimeout(res, GPS_DELAY_MS));
        }

        console.log(`[saveMdmData][GPS] ${section}: GPS done — success=${gpsSuccess}, fail/offline=${gpsFail}`);
      } else {
        console.log(`[saveMdmData][GPS] ${section}: no devices qualify for GPS fetch (need lastType=1 online + locked)`);
      }
      // ─────────────────────────────────────────────────────────────────────────────────

      return { section, updated, total: validRows.length };
    }),

  /** Last successful sync timestamp for a section. */
  lastSyncedAt: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const ts = await getLastSyncedAt({
        section: input.section as SectionKey,
      });
      return { section: input.section, lastSyncedAt: ts };
    }),

  /**
   * Force-clear all in_progress sync logs for a section.
   * Use when a sync got stuck (e.g. Cloud Run killed the process mid-sync).
   * Requires canSync permission on sync_api.
   */
  clearStuck: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      // Permission check — only users with sync permission can clear stuck syncs
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Re-Sync" });
        }
      }
      const section = input.section as SectionKey;
      const cleared = await clearStuckSyncLogs(section);
      return { section, cleared };
    }),

  /**
   * Cancel a running sync for a section.
   * Sets a cancellation flag that will be checked between stages.
   * Note: if sync is stuck mid-request (e.g. API hang), it will cancel after the current request times out.
   */
  cancel: appProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input, ctx }) => {
      // Permission check
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ยกเลิก Sync" });
        }
      }
      const section = input.section as SectionKey;
      const wasRunning = requestCancelSync(section);
      // Also clear DB lock so UI stops showing running state
      await clearStuckSyncLogs(section);
      console.log(`[sync.cancel] ${section}: cancel requested (wasRunning=${wasRunning})`);
      return { section, cancelled: true, wasRunning };
    }),

  /**
   * Summary of the last sync run for a section.
   * Returns the overall row (entity='all') plus all entity-level rows
   * from the same sync run, so the UI can show a detailed breakdown.
   */
  lastRunSummary: appProcedure
    .input(z.object({ section: sectionSchema }))
    .query(async ({ input }) => {
      const section = input.section as SectionKey;
      const db = await getDb(section);
      if (!db) return null;

      // Find the most recent entity='all' row (any status)
      const overallRows = await db
        .select()
        .from(syncLogs)
        .where(and(eq(syncLogs.section, section), eq(syncLogs.entity, "all")))
        .orderBy(desc(syncLogs.startedAt))
        .limit(1);

      const overall = overallRows[0];
      if (!overall) return null;

      // Get all entity-level rows from the same sync run
      // (started within 30 seconds of the overall row)
      const windowStart = new Date(overall.startedAt!.getTime() - 30_000);
      const windowEnd = new Date(overall.startedAt!.getTime() + 30_000);
      const entityRows = await db
        .select()
        .from(syncLogs)
        .where(
          and(
            eq(syncLogs.section, section),
            gt(syncLogs.startedAt, windowStart),
            lt(syncLogs.startedAt, windowEnd),
          ),
        )
        .orderBy(syncLogs.startedAt);

      return {
        overall,
        entities: entityRows.filter((r: typeof entityRows[number]) => r.entity !== "all"),
      };
    }),

  /** Recent sync log entries. Default last 50. */
  recent: appProcedure
    .input(
      z
        .object({
          section: sectionSchema.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return await listSyncLogs(
        input?.section as SectionKey | undefined,
        input?.limit ?? 50,
      );
    }),
});

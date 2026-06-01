import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, appProcedure } from "../_core/trpc";
import { runSectionSync, isSyncRunning, getSyncStatus, requestCancelSync, SYNC_STAGES, syncMdmOnlineDays } from "../sync/runner";
import {
  getLastSyncedAt,
  listSyncLogs,
  getRunningSyncs,
  getDbSyncStatus,
  clearStuckSyncLogs,
} from "../sync/syncLog";
import { desc, eq, and, gt, lt, sql } from "drizzle-orm";
import { syncLogs, contracts } from "../../drizzle/schema";
import { getDb } from "../db";
import { sectionSchema, type SectionKey } from "../../shared/const";

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
   * Sync status — reads from DB (cross-instance safe for Cloud Run).
   * Falls back to in-memory lock if DB returns running=false but lock is set
   * (same-instance fast path).
   */
  status: appProcedure.query(async () => {
    // Fetch DB status for both sections in parallel
    const [bpDb, ffDb] = await Promise.all([
      getDbSyncStatus("Boonphone"),
      getDbSyncStatus("Fastfone365"),
    ]);

    // In-memory fallback (same instance)
    const bpMem = getSyncStatus("Boonphone");
    const ffMem = getSyncStatus("Fastfone365");

    const bpRunning = (bpDb?.running ?? false) || isSyncRunning("Boonphone");
    const ffRunning = (ffDb?.running ?? false) || isSyncRunning("Fastfone365");

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
      },
      Fastfone365: {
        running: ffRunning,
        startedAt: ffDb?.startedAt?.getTime() ?? ffMem?.startedAt ?? null,
        progress: ffProgress,
        currentStage: ffCurrentStage,
        stageIndex: ffStageIndex,
        totalStages: ffTotalStages,
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
      const { eq, and, isNotNull, isNull, count } = await import("drizzle-orm");
      
      const db = await getDb(section);
      if (!db) return { stale: false, staleCount: 0 };
      
      // นับจำนวนเครื่องที่มี serial_no แต่ last_online_days เป็น null
      const res = await db
        .select({ value: count() })
        .from(contracts)
        .where(
          and(
            eq(contracts.section, section),
            isNotNull(contracts.serialNo),
            isNull(contracts.lastOnlineDays)
          )
        );
        
      const staleCount = res[0]?.value ?? 0;
      return { stale: staleCount > 0, staleCount };
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
    .query(async ({ input, ctx }) => {
      // Permission check — เฉพาะ user ที่มีสิทธิ์ sync เท่านั้น
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Sync" });
        }
      }
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
            lastOnlineDays: z.number().int().nullable(),
            lastOnlineAt: z.string().nullable(), // "YYYY-MM-DD HH:mm:ss"
            deviceLock: z.boolean().nullable().optional(), // true=ล็อค, false=ปลดล็อค, null/undefined=ไม่มีข้อมูล
          })
        ).max(20000), // เพิ่มจาก 10,000 เป็น 20,000 รองรับ dataset ขนาดใหญ่
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Permission check
      const { checkPermission } = await import("../authDb");
      if (ctx.appUser) {
        const allowed = checkPermission(ctx.appUser, "sync_api", "sync");
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ใช้งาน Sync" });
        }
      }
      const section = input.section as SectionKey;
      const db = await getDb(section);
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

      // สร้าง Map<serialNo (uppercase), { days, lastOnlineAt, deviceLock }> จาก input
      const snMap = new Map<string, { days: number | null; lastOnlineAt: string | null; deviceLock: boolean | null }>();
      for (const d of input.devices) {
        if (d.serialNo) {
          snMap.set(d.serialNo.trim().toUpperCase(), {
            days: d.lastOnlineDays,
            lastOnlineAt: d.lastOnlineAt,
            deviceLock: d.deviceLock ?? null,
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

      // Bulk update ทีละ 200 rows (เพิ่มจาก 100 เพื่อลดจำนวน round-trips)
      let updated = 0;
      const BATCH = 200;
      for (let i = 0; i < validRows.length; i += BATCH) {
        const batch = validRows.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (r: { externalId: string; serialNo: string | null }) => {
            const key = r.serialNo!.trim().toUpperCase();
            const mdm = snMap.get(key);
            // ถ้าเจอใน MDM ใช้ค่าจริง, ถ้าไม่เจอ set -1 (แทน null)
            // เพื่อให้ isMdmStale รู้ว่า sync แล้ว แต่เครื่องนี้ไม่อยู่ใน MDM
            const days = mdm !== undefined ? (mdm.days ?? -1) : -1;
            const lastOnlineAt = mdm?.lastOnlineAt ?? null;
            // deviceLock: ถ้า SN เจอใน MDM ให้ใช้ค่าจริง, ถ้าไม่เจอให้ set null
            const deviceLock = mdm !== undefined ? (mdm.deviceLock ?? null) : null;
            await db
              .update(contracts)
              .set({
                lastOnlineDays: days,
                lastOnlineAt: lastOnlineAt,
                deviceLock: deviceLock,
              })
              .where(and(eq(contracts.section, section), eq(contracts.externalId, r.externalId)));
            if (days !== null && days >= 0) updated++; // นับเฉพาะที่เจอใน MDM จริงๆ
          })
        );
      }

      console.log(`[saveMdmData] ${section}: updated ${updated}/${validRows.length} contracts (with deviceLock)`);
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

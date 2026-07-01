/**
 * Sync runner v2 — ดึงข้อมูลจาก Boonphone / Fastfone365 API แล้ว upsert ลง DB
 *
 * หลักการออกแบบ:
 *  1. เรียบง่าย — sequential pagination เท่านั้น ไม่มี parallel batch
 *  2. Idempotent — sync ซ้ำได้ไม่เสียหาย (upsert ทุก entity)
 *  3. ไม่ลบข้อมูล — ไม่มี cleanupTodayPayments หรือ delete detection
 *  4. Best-effort — installments/payments fail ได้ โดยไม่หยุด contracts
 *  5. Progress tracking — อัพเดต DB ทุก stage เพื่อให้ UI แสดงได้
 *
 * ลำดับ sync:
 *  1. partners    → in-memory map (ไม่ upsert ลง DB)
 *  2. customers   → upsert cached_customers
 *  3. contracts   → upsert contracts (list endpoint เท่านั้น)
 *  3b. enrich IMEI/Serial No → ดึง detail endpoint ทุกสัญญา (parallel 5 req)
 *  4. installments → upsert installments
 *  5. payments    → upsert payment_transactions
 *  6. bad_debt    → compute & store bad-debt columns บน contracts
 *  7. cache       → populate debt_target_cache + debt_collected_cache
 */

import { buildClientFromEnv, PartnerClient, PartnerApiError } from "../api/partnerClient";

import {
  mapContractListItem,
  mapContractDetailOverrides,
  mapCustomerProfile,
  mapInstallment,
  mapPayment,
  mapCommission,
  type CustomerListItem,
  type PartnerListItem,
} from "../api/mappers";

import {
  upsertContracts,
  upsertInstallments,
  upsertPayments,
  upsertCachedCustomers,
  upsertCommissions,
  loadCachedCustomersBySection,
} from "./dbUpsert";
import {
  insertSyncLog,
  finishSyncLog,
  updateSyncLogStage,
  getLastCustomersResumePage,
  getLastContractsResumePage,
  setCancelRequestedInDb,
  isCancelRequestedInDb,
} from "./syncLog";
import type { SectionKey, SyncTrigger } from "../../shared/const";

import { fillPeriodNosForSection } from "./fillPeriodNos";
import { populateDebtCache } from "./populateCache";
import { pgRows, ensureSectionSchemaReady } from "../db";
import { rebuildIncomeMonthlySummary, populateIncomeType } from "../accountingDb";
import { populateMonthlySummaryCache, populateDueMonthCache } from "../monthlySummaryDb";
import { populateMonthlyCollectionSnapshot, backfillFrozenBreakdown, hasTargetDetailSnapshot, previousCalendarMonth } from "../monthlyCollectionSnapshotDb";
import { populateTargetDetailSnapshot as populateMonthlyTargetDetailSnapshot } from "../monthlyTargetDetailSnapshotDb";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Constants & types                                                           */
/* ─────────────────────────────────────────────────────────────────────────── */

const OVERALL_TIMEOUT_MS = 180 * 60 * 1000; // 180 min ceiling
const STALE_INPROGRESS_MS = OVERALL_TIMEOUT_MS + 5 * 60 * 1000;

export const SYNC_STAGES = [
  "partners",
  "customers",
  "contracts",
  "imei_enrich",
  "installments",
  "payments",
  "commissions",
  "bad_debt",
  "mdm_online",  // ดึง MDM device list และ bulk update last_online_days ใน contracts
  "populate",
  "monthly_cache",
] as const;
export type SyncStage = (typeof SYNC_STAGES)[number];

export interface SyncLockInfo {
  startedAt: number;
  triggeredBy: SyncTrigger;
  progress: number;
  currentStage: string;
  stageIndex: number;
  totalStages: number;
}

type LockMap = Record<string, SyncLockInfo | null>;
const _locks: LockMap = { Boonphone: null, Fastfone365: null };
const _overallLogId: Record<string, number> = { Boonphone: 0, Fastfone365: 0 };
const _cancelRequested: Record<string, boolean> = { Boonphone: false, Fastfone365: false };

/* ─────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

export function requestCancelSync(section: SectionKey): boolean {
  // Set in-memory flag (same instance)
  _cancelRequested[section] = true;
  // Also write to DB so other instances can detect it
  setCancelRequestedInDb(section).catch(() => {});
  return _locks[section] !== null;
}

export function isCancelRequested(section: SectionKey): boolean {
  return _cancelRequested[section] === true;
}

export function getSyncStatus(section: SectionKey): SyncLockInfo | null {
  return _locks[section];
}

export function isSyncRunning(section: SectionKey): boolean {
  return _locks[section] !== null;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Progress helpers                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

function setStage(section: SectionKey, stageIndex: number) {
  const lock = _locks[section];
  if (!lock) return;
  const totalStages = SYNC_STAGES.length;
  const progress = Math.round(5 + (stageIndex / totalStages) * 90);
  const currentStage = SYNC_STAGES[stageIndex] ?? "finishing";
  _locks[section] = { ...lock, progress, stageIndex, currentStage, totalStages };
  const logId = _overallLogId[section];
  if (logId) {
        updateSyncLogStage({ id: logId, section, currentStage, progress }).catch(() => {});
  }
}
function setSubProgress(section: SectionKey, stageName: string, current: number, total: number) {
  const lock = _locks[section];
  if (!lock) return;
  const stageIndex = SYNC_STAGES.indexOf(stageName as any);
  const totalStages = SYNC_STAGES.length;
  const stageStart = Math.round(5 + (stageIndex / totalStages) * 90);
  const stageEnd = Math.round(5 + ((stageIndex + 1) / totalStages) * 90);
  const subFraction = total > 0 ? current / total : 0;
  const progress = Math.min(stageEnd - 1, Math.round(stageStart + subFraction * (stageEnd - stageStart)));
  const currentStage = total > 0 ? `${stageName} (${current}/${total})` : stageName;
  _locks[section] = { ...lock, progress, currentStage };
  // อัพเดต DB ด้วยเพื่อให้ frontend poll แล้วเห็น progress จริง
  const logId = _overallLogId[section];
  if (logId) {
        updateSyncLogStage({ id: logId, section, currentStage, progress }).catch(() => {});
  }
}
/* ─────────────────────────────────────────────────────────────────────────── */
/* DB lock check (cross-process via sync_logs table)                          */
/* ─────────────────────────────────────────────────────────────────────────── */

async function isSectionLockedInDb(section: SectionKey): Promise<boolean> {
  try {
    const { getDb } = await import("../db");
    const { syncLogs } = await import("../../drizzle/schema");
    const { and, eq, gt } = await import("drizzle-orm");
    const db = await getDb(section);
    if (!db) return false;
    const threshold = new Date(Date.now() - STALE_INPROGRESS_MS);
    const rows = await db
      .select({ id: syncLogs.id })
      .from(syncLogs)
      .where(
        and(
          eq(syncLogs.section, section),
          eq(syncLogs.entity, "all"),
          eq(syncLogs.status, "in_progress"),
          gt(syncLogs.startedAt, threshold),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Entry point                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function runSectionSync(
  section: SectionKey,
  triggeredBy: SyncTrigger,
): Promise<{ ok: boolean; rowCount: number; message?: string }> {
  // In-memory lock
  if (_locks[section]) {
    return { ok: false, rowCount: 0, message: `[${section}] sync already in progress` };
  }
  // DB lock (cross-process)
  if (await isSectionLockedInDb(section)) {
    return { ok: false, rowCount: 0, message: `[${section}] sync already in progress (another process)` };
  }

  const client = buildClientFromEnv(section);
  if (!client || !client.isConfigured()) {
    return { ok: false, rowCount: 0, message: `[${section}] API credentials are not configured` };
  }

  try {
    await ensureSectionSchemaReady(section);
  } catch (schemaErr: any) {
    const msg = schemaErr?.message ?? String(schemaErr);
    console.error(`[sync] ${section}: schema ensure failed:`, msg);
    return { ok: false, rowCount: 0, message: msg };
  }

  _locks[section] = {
    startedAt: Date.now(),
    triggeredBy,
    progress: 0,
    currentStage: "เริ่มต้น",
    stageIndex: -1,
    totalStages: SYNC_STAGES.length,
  };
  _cancelRequested[section] = false;

  try {
    const work = doSync(client, section, triggeredBy);
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`[${section}] sync exceeded ${OVERALL_TIMEOUT_MS}ms`)), OVERALL_TIMEOUT_MS),
    );
    return await Promise.race([work, timeout]);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[sync] ${section} failed:`, msg);
    return { ok: false, rowCount: 0, message: msg };
  } finally {
    _locks[section] = null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main sync orchestrator                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

async function doSync(
  client: PartnerClient,
  section: SectionKey,
  triggeredBy: SyncTrigger,
): Promise<{ ok: boolean; rowCount: number }> {
  const overall = await insertSyncLog({ section, entity: "all", triggeredBy });
  _overallLogId[section] = overall.id;

  // Self-ping ทุก 30 วินาที เพื่อป้องกัน Render/Cloud Run kill idle instance
  const selfPingUrl = process.env.SELF_PING_URL
    ? `${process.env.SELF_PING_URL}/api/ping`
    : `http://localhost:${process.env.PORT ?? 3000}/api/ping`;
  const selfPingInterval = setInterval(() => {
    fetch(selfPingUrl).catch(() => {});
  }, 30_000);

  // checkCancel: ตรวจทั้ง in-memory (same instance) และ DB (cross-instance)
  // DB check ทำทุก ~5 วินาที เพื่อไม่ให้ query DB บ่อยเกินไป
  let _lastDbCancelCheck = 0;
  const checkCancel = async () => {
    if (_cancelRequested[section]) throw new Error(`[${section}] sync cancelled by user`);
    // DB check ทุก 5 วินาที
    const now = Date.now();
    if (now - _lastDbCancelCheck > 5_000) {
      _lastDbCancelCheck = now;
      const logId = _overallLogId[section];
      if (logId) {
        const dbCancel = await isCancelRequestedInDb({ id: logId, section }).catch(() => false);
        if (dbCancel) {
          _cancelRequested[section] = true;
          throw new Error(`[${section}] sync cancelled by user (DB flag)`);
        }
      }
    }
  };

  let overallRows = 0;

  try {
    // ── Stage 1: Partners ─────────────────────────────────────────────────
    await checkCancel();
    setStage(section, 0);
    const partnersById = await syncPartners(client, section);
    console.log(`[sync] ${section}: partners loaded — ${partnersById.size} entries`);

    // ── Stage 2: Customers ────────────────────────────────────────────────
    await checkCancel();
    setStage(section, 1);
    let customersById = new Map<string, CustomerListItem>();
    try {
      customersById = await syncCustomers(client, section);
      console.log(`[sync] ${section}: customers synced — ${customersById.size} rows`);
    } catch (custErr: any) {
      if (_cancelRequested[section]) throw custErr;
      console.warn(`[sync] ${section}: customers failed, loading from DB cache:`, custErr?.message ?? custErr);
      try {
        const dbMap = await loadCachedCustomersBySection(section);
        if (dbMap.size > 0) {
          console.log(`[sync] ${section}: loaded ${dbMap.size} customers from DB cache`);
          for (const [id, row] of Array.from(dbMap.entries())) {
            customersById.set(id, {
              customer_id: row.customerId,
              customer_code: row.customerCode ?? undefined,
              full_name: row.fullName ?? undefined,
              nationality: row.nationality ?? undefined,
              id_document_no: row.idDocumentNo ?? undefined,
              gender: row.gender ?? undefined,
              age_years: row.ageYears ?? undefined,
              occupation_title: row.occupationTitle ?? undefined,
              monthly_income: row.monthlyIncome ?? undefined,
              workplace_name: row.workplaceName ?? undefined,
              mobile_phone: row.mobilePhone ?? undefined,
              idcard_district: row.idcardDistrict ?? undefined,
              idcard_province: row.idcardProvince ?? undefined,
              current_district: row.currentDistrict ?? undefined,
              current_province: row.currentProvince ?? undefined,
              work_district: row.workDistrict ?? undefined,
              work_province: row.workProvince ?? undefined,
            } as CustomerListItem);
          }
        }
      } catch (dbErr: any) {
        console.warn(`[sync] ${section}: DB cache load also failed:`, dbErr?.message ?? dbErr);
      }
    }

    // ── Stage 3: Contracts ────────────────────────────────────────────────
    await checkCancel();
    setStage(section, 2);
    const contractsStartPage = await getLastContractsResumePage(section);
    const contractRows = await syncContracts(
      client,
      section,
      partnersById,
      customersById,
      contractsStartPage > 0 ? contractsStartPage : 1,
    );
    overallRows += contractRows;
    console.log(`[sync] ${section}: contracts synced — ${contractRows} rows`);

    // ── Stage 3b: Enrich IMEI / Serial No (best-effort) ──────────────────
    await checkCancel();
    setStage(section, 3); // imei_enrich
    if (section === "Fastfone365") {
      console.log(`[sync] ${section}: Skipping imei_enrich (performance optimization)`);
    } else {
      try {
        await enrichContractDeviceIds(client, section);
        console.log(`[sync] ${section}: IMEI/Serial No enrichment done`);
      } catch (enrichErr: any) {
        console.warn(`[sync] ${section}: IMEI enrichment failed (non-fatal):`, enrichErr?.message ?? enrichErr);
      }
    }

    // ── Stage 5: Installments (best-effort) ───────────────────────────────
    await checkCancel();
    setStage(section, 4);
    let instFailed = false;
    try {
      const instRows = await syncInstallments(client, section);
      overallRows += instRows;
      console.log(`[sync] ${section}: installments synced — ${instRows} rows`);
    } catch (instErr: any) {
      if (_cancelRequested[section]) throw instErr;
      instFailed = true;
      console.warn(`[sync] ${section}: installments failed (non-fatal):`, instErr?.message ?? instErr);
    }

    // ── Stage 5: Payments (best-effort) ──────────────────────────────────
    await checkCancel();
    setStage(section, 5);
    let payFailed = false;
    try {
      const payRows = await syncPayments(client, section);
      overallRows += payRows;
      console.log(`[sync] ${section}: payments synced — ${payRows} rows`);
    } catch (payErr: any) {
      if (_cancelRequested[section]) throw payErr;
      payFailed = true;
      console.warn(`[sync] ${section}: payments failed (non-fatal):`, payErr?.message ?? payErr);
    }

    // Fill period_no / sub_no หลัง payments sync สำเร็จ
    if (!payFailed) {
      try {
        const fillCount = await fillPeriodNosForSection(section, (current, total) => {
          const logId = _overallLogId[section];
          if (!logId) return;
          const paymentsIdx = SYNC_STAGES.indexOf("payments");
          const commissionsIdx = SYNC_STAGES.indexOf("commissions");
          const stageStart = Math.round(5 + (paymentsIdx / SYNC_STAGES.length) * 90);
          const stageEnd = Math.round(5 + (commissionsIdx / SYNC_STAGES.length) * 90);
          const subFraction = total > 0 ? current / total : 0;
          const progress = Math.min(
            stageEnd - 1,
            Math.round(stageStart + subFraction * (stageEnd - stageStart)),
          );
          updateSyncLogStage({
            id: logId,
            section,
            currentStage: `fill_period_nos (${current}/${total})`,
            progress,
          }).catch(() => {});
        });
        console.log(`[sync] ${section}: filled period_no/sub_no for ${fillCount} payment rows`);
      } catch (fillErr: any) {
        console.warn(`[sync] ${section}: fillPeriodNos failed (non-fatal):`, fillErr?.message ?? fillErr);
      }

      // Rebuild income_monthly_summary หลัง payments sync สำเร็จ
      try {
        const summaryRows = await rebuildIncomeMonthlySummary(section);
        console.log(`[sync] ${section}: income_monthly_summary rebuilt — ${summaryRows} rows`);
      } catch (summaryErr: any) {
        console.warn(`[sync] ${section}: rebuildIncomeMonthlySummary failed (non-fatal):`, summaryErr?.message ?? summaryErr);
      }
    }

    // ── Stage 6: Commissions ──────────────────────────────────────────────
    await checkCancel();
    setStage(section, 6);
    try {
      const commRows = await syncCommissions(client, section);
      overallRows += commRows;
      console.log(`[sync] ${section}: commissions upserted ${commRows} rows`);
    } catch (commErr: any) {
      console.warn(`[sync] ${section}: commissions failed (non-fatal):`, commErr?.message ?? commErr);
    }

    // ── Stage 7: Bad-debt computation ─────────────────────────────────────
    await checkCancel();
    setStage(section, 7);
    try {
      await computeAndStoreBadDebt(section);
      console.log(`[sync] ${section}: bad-debt computed`);
    } catch (bdErr: any) {
      console.warn(`[sync] ${section}: bad-debt computation failed (non-fatal):`, bdErr?.message ?? bdErr);
    }

    // ── Stage MDM Online: ดึง MDM device list และ bulk update last_online_days ────────────────
    await checkCancel();
    setStage(section, SYNC_STAGES.indexOf("mdm_online"));
    try {
      const mdmCount = await syncMdmOnlineDays(section, (current, total) => {
        setSubProgress(section, "mdm_online", current, total);
      });
      console.log(`[sync] ${section}: MDM online days updated — ${mdmCount} contracts`);
    } catch (mdmErr: any) {
      console.warn(`[sync] ${section}: MDM online sync failed (non-fatal):`, mdmErr?.message ?? mdmErr);
    }

    // ── Stage Populate: Populate debt cache ──────────────────────────────────────
    await checkCancel();
    setStage(section, SYNC_STAGES.indexOf("populate"));
    try {
      const cacheResult = await populateDebtCache(section, (phase, current, total) => {
        if (phase === "collected" && total > 0) {
          setSubProgress(section, "populate", current, total);
        }
      });
      console.log(`[sync] ${section}: cache populated — target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);
    } catch (cacheErr: any) {
      console.warn(`[sync] ${section}: cache populate failed (non-fatal):`, cacheErr?.message ?? cacheErr);
    }

    // ── Populate income_type ใน payment_transactions ────────────────────────
    try {
      const incomeTypeRows = await populateIncomeType(section);
      console.log(`[sync] ${section}: income_type populated — ${incomeTypeRows} rows updated`);
    } catch (incomeTypeErr: any) {
      console.warn(`[sync] ${section}: populateIncomeType failed (non-fatal):`, incomeTypeErr?.message ?? incomeTypeErr);
    }

    // ── Populate monthly_summary_cache ──────────────────────────────────────
    setStage(section, SYNC_STAGES.indexOf("monthly_cache"));
    try {
      const msCacheRows = await populateMonthlySummaryCache(section, (current, total) => {
        setSubProgress(section, "monthly_cache", current, total);
      });
      console.log(`[sync] ${section}: monthly_summary_cache populated — ${msCacheRows} rows`);
    } catch (msCacheErr: any) {
      console.warn(`[sync] ${section}: populateMonthlySummaryCache failed (non-fatal):`, msCacheErr?.message ?? msCacheErr);
    }
    // ── Populate monthly_summary_due_month_cache ─────────────────────────────
    try {
      const dmCacheRows = await populateDueMonthCache(section, (current, total) => {
        setSubProgress(section, "monthly_cache", current, total);
      });
      console.log(`[sync] ${section}: monthly_summary_due_month_cache populated — ${dmCacheRows} rows`);
    } catch (dmCacheErr: any) {
      console.warn(`[sync] ${section}: populateDueMonthCache failed (non-fatal):`, dmCacheErr?.message ?? dmCacheErr);
    }

    // ── Populate monthly_collection_snapshot ─────────────────────────────────
    // วันที่ 1: ใช้ end_of_month cutoffMode เพื่อให้ target_amount นับงวดทั้งเดือน
    // วันอื่น: ใช้ today cutoffMode (นับแค่งวดถึงวันนี้)
    try {
      const bangkokDateForSnapshot = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const dayOfMonthForSnapshot = parseInt(bangkokDateForSnapshot.slice(8, 10), 10);
      const snapshotCutoffMode = dayOfMonthForSnapshot === 1 ? "end_of_month" : "today";
      const snapshotRows = await populateMonthlyCollectionSnapshot(section, (current, total) => {
        setSubProgress(section, "monthly_cache", current, total);
      }, snapshotCutoffMode);
      console.log(`[sync] ${section}: monthly_collection_snapshot populated — ${snapshotRows} months (cutoffMode=${snapshotCutoffMode})`);
    } catch (snapshotErr: any) {
      console.warn(`[sync] ${section}: populateMonthlyCollectionSnapshot failed (non-fatal):`, snapshotErr?.message ?? snapshotErr);
    }

    // ── Auto Snapshot: dropdown "ตั้งเป้ารายเดือน > ตั้งหนี้" ──
    // วันที่ 1 ของเดือนใหม่: สร้าง roll ใหม่ของเดือนนั้น (populate ครั้งเดียว แล้ว freeze)
    // วันที่ 2-31: ไม่ populate — ใช้ roll ที่สร้างวันที่ 1
    try {
      const bangkokDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      // en-CA format: "YYYY-MM-DD"
      const dayOfMonth = parseInt(bangkokDate.slice(8, 10), 10);
      const currentMonth = bangkokDate.slice(0, 7); // "YYYY-MM"
      // filterState: เมื่อเปิด Snapshot จะ auto-restore toggle ตั้งหนี้ = ON, เฉพาะเงินต้น = ON
      const autoSnapshotFilterState = JSON.stringify({
        search: "",
        statusFilter: [],
        approveDateFilter: [],
        dueDateFilter: [],
        productTypeFilter: [],
        dueDateExact: "",
        debtSetMode: true,        // toggle ตั้งหนี้ = ON
        debtSetCutoffMode: "end_of_month", // cutoff = ณ เดือนปัจจุบัน (นับทั้งเดือน)
        principalOnly: true,      // toggle เฉพาะเงินต้น = ON
      });
      if (dayOfMonth === 1) {
        // วันที่ 1 เดือนใหม่: สร้าง roll ใหม่ของเดือนนี้ (ถ้ายังไม่มี)
        const mtdsExists = await hasTargetDetailSnapshot(section, currentMonth);
        if (mtdsExists) {
          console.log(`[sync] ${section}: ${currentMonth} roll already exists — skipped day-1 populate (retry same day)`);
        } else {
          const detailRows = await populateMonthlyTargetDetailSnapshot(
            section,
            currentMonth,
            "end_of_month",
            true,
            true,
            autoSnapshotFilterState,
            undefined,
            false, // สร้าง roll ใหม่ของเดือนนี้ — ห้าม skip
          );
          console.log(`[sync] ${section}: created new monthly roll — ${detailRows} rows for ${currentMonth} (dropdown ตั้งหนี้)`);
        }
      } else {
        // วันที่ 2-31: roll ของเดือนนี้ freeze แล้ว — ไม่ populate ทับ
        console.log(`[sync] ${section}: ${currentMonth} roll frozen — skipped populate (day ${dayOfMonth})`);
      }

      // Repair: เดือนปัจจุบันยังไม่มี roll (sync วันที่ 1 error / deploy ช้า) → สร้างให้
      if (!(await hasTargetDetailSnapshot(section, currentMonth))) {
        console.warn(`[sync] ${section}: ${currentMonth} roll MISSING — repair populate`);
        const repaired = await populateMonthlyTargetDetailSnapshot(
          section,
          currentMonth,
          "end_of_month",
          true,
          true,
          autoSnapshotFilterState,
          undefined,
          false,
        );
        console.log(`[sync] ${section}: repair created ${repaired} rows for ${currentMonth}`);
      }
    } catch (detailErr: any) {
      console.warn(`[sync] ${section}: populateMonthlyTargetDetailSnapshot failed (non-fatal):`, detailErr?.message ?? detailErr);
    }

    // ── Backfill frozen breakdown: คำนวณ target_by_range + daily_breakdown ──
    // รันหลัง populateTargetDetailSnapshot เพื่อให้ข้อมูล monthly_target_detail_snapshot พร้อมแล้ว
    try {
      const bangkokDateForBreakdown = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const currentMonthForBreakdown = bangkokDateForBreakdown.slice(0, 7);
      let backfillRows = await backfillFrozenBreakdown(section, currentMonthForBreakdown);
      // อัปเดตยอดเก็บหนี้รายวันของเดือนก่อนหน้าด้วย (เช่น มิ.ย. 30 หลัง sync วันที่ 1 ก.ค.)
      const prevMonth = previousCalendarMonth(currentMonthForBreakdown);
      if (prevMonth) {
        backfillRows += await backfillFrozenBreakdown(section, prevMonth);
      }
      console.log(`[sync] ${section}: backfillFrozenBreakdown — updated ${backfillRows} month(s)`);
    } catch (backfillErr: any) {
      console.warn(`[sync] ${section}: backfillFrozenBreakdown failed (non-fatal):`, backfillErr?.message ?? backfillErr);
    }

    // ── Finish sync log ───────────────────────────────────────────────────
        const partialFail = instFailed || payFailed;
    // Set progress to 100% before finishing so UI shows completion
    const logId = _overallLogId[section];
    if (logId) {
      await updateSyncLogStage({ id: logId, section, currentStage: "finishing", progress: 100 }).catch(() => {});
    }
    if (_locks[section]) {
      _locks[section] = { ..._locks[section]!, progress: 100, currentStage: "finishing" };
    }
    await finishSyncLog({
      id: overall.id,
      section,
      status: partialFail ? "error" : "success",
      rowCount: overallRows,
      errorMessage: partialFail
        ? `Partial: installments=${instFailed ? "failed" : "ok"}, payments=${payFailed ? "failed" : "ok"}`
        : undefined,
    });

    clearInterval(selfPingInterval);
    return { ok: true, rowCount: overallRows };

  } catch (err: any) {
    clearInterval(selfPingInterval);
    // Try to populate cache from existing DB data even on failure
    try {
      const cacheResult = await populateDebtCache(section, (phase, current, total) => {
        if (phase === "collected" && total > 0) {
          setSubProgress(section, "populate", current, total);
        }
      });
      console.log(`[sync] ${section}: post-failure cache populated — target=${cacheResult.targetRows}, collected=${cacheResult.collectedRows}`);
    } catch (cacheErr: any) {
      console.error(`[sync] ${section}: post-failure cache populate failed:`, cacheErr?.message ?? cacheErr);
    }
    await finishSyncLog({
      id: overall.id,
      section,
      status: "error",
      rowCount: overallRows,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Per-entity sync functions                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Stage 1: Partners — ดึงทั้งหมดเก็บใน memory map สำหรับ enrich contracts
 * ไม่ upsert ลง DB เพราะใช้แค่ชั่วคราวระหว่าง sync
 */
async function syncPartners(
  client: PartnerClient,
  section: SectionKey,
): Promise<Map<string, PartnerListItem>> {
  const log = await insertSyncLog({ section, entity: "partners", triggeredBy: "on-demand" });
  try {
    const byId = new Map<string, PartnerListItem>();
    await client.forEachPage<PartnerListItem>(
      "partner",
      (d) => d?.partners,
      { action: "all" },
      (items) => {
        for (const it of items) byId.set(String(it.partner_id), it);
      },
      200,
    );
    await finishSyncLog({ id: log.id, status: "success", rowCount: byId.size });
    return byId;
  } catch (err: any) {
    await finishSyncLog({ id: log.id, status: "error", errorMessage: err?.message ?? String(err) });
    throw err;
  }
}

/**
 * Stage 2: Customers — upsert ลง cached_customers
 * Resume จาก page ที่ค้างไว้ถ้ามี (Cloud Run kill recovery)
 */
async function syncCustomers(
  client: PartnerClient,
  section: SectionKey,
): Promise<Map<string, CustomerListItem>> {
  const resumeFromPage = await getLastCustomersResumePage(section);
  const startPage = resumeFromPage > 0 ? resumeFromPage : 1;
  if (startPage > 1) console.log(`[sync] ${section}: resuming customers from page ${startPage}`);

  const log = await insertSyncLog({ section, entity: "customers", triggeredBy: "on-demand" });
  const logId = _overallLogId[section];

  try {
    const byId = new Map<string, CustomerListItem>();
    let totalUpserted = 0;

    await client.forEachPage<CustomerListItem>(
      "customer",
      (d) => d?.customers,
      { action: "all" },
      async (items, page, totalPages) => {
        // Upsert ลง DB ทันที (survives Cloud Run kills)
        const dbRows = items.map((it) => ({
          section,
          customerId: String(it.customer_id),
          customerCode: it.customer_code ?? null,
          fullName: it.full_name ?? null,
          nationality: it.nationality ?? null,
          idDocumentNo: it.id_document_no ?? null,
          gender: it.gender ?? null,
          ageYears: it.age_years != null ? Number(it.age_years) : null,
          occupationTitle: it.occupation_title ?? null,
          monthlyIncome: it.monthly_income != null ? String(it.monthly_income) : null,
          workplaceName: it.workplace_name ?? null,
          mobilePhone: it.mobile_phone ?? null,
          idcardDistrict: it.idcard_district ?? null,
          idcardProvince: it.idcard_province ?? null,
          currentDistrict: it.current_district ?? null,
          currentProvince: it.current_province ?? null,
          workDistrict: it.work_district ?? null,
          workProvince: it.work_province ?? null,
        }));
        await upsertCachedCustomers(dbRows, section);
        totalUpserted += dbRows.length;
        for (const it of items) byId.set(String(it.customer_id), it);

        // Update progress + resume page
        if (logId && totalPages > 0) {
          const progress = Math.round(20 + (page / totalPages) * 20);
          const currentStage = `customers (${page}/${totalPages})`;
          const lock = _locks[section];
          if (lock) _locks[section] = { ...lock, progress, currentStage };
          updateSyncLogStage({ id: logId, section, currentStage, progress, resumePage: page + 1 }).catch(() => {});
        }
      },
      500,
      30_000, // 30s per-request timeout
      startPage,
      false, // skipOnError=false: ถ้า page fail ให้ throw ทันที
    );

    await finishSyncLog({ id: log.id, status: "success", rowCount: totalUpserted });
    return byId;
  } catch (err: any) {
    await finishSyncLog({ id: log.id, status: "error", errorMessage: err?.message ?? String(err) });
    throw err;
  }
}

/**
 * Stage 3: Contracts — upsert ลง contracts table
 * ใช้ list endpoint เท่านั้น (ไม่ enrichment IMEI/detail ซึ่งช้ามาก)
 * Resume จาก page ที่ค้างไว้ถ้ามี
 */
async function syncContracts(
  client: PartnerClient,
  section: SectionKey,
  partnersById: Map<string, PartnerListItem>,
  customersById: Map<string, CustomerListItem>,
  startPage = 1,
): Promise<number> {
  const log = await insertSyncLog({ section, entity: "contracts", triggeredBy: "on-demand" });
  if (startPage > 1) {
    console.log(`[sync] ${section}: resuming contracts from page ${startPage}`);
    updateSyncLogStage({ id: log.id, section, currentStage: "contracts", progress: 0, resumePage: startPage }).catch(() => {});
  }

  let rowCount = 0;
  try {
    const buffer: any[] = [];
    let totalContractRows = 0;

    await client.forEachPage<any>(
      "contract",
      (d) => d?.contracts,
      { action: "all" },
      async (items, page, totalPages) => {
        if (totalContractRows === 0 && totalPages > 0) totalContractRows = totalPages * 200;

        for (const it of items) {
          const row: any = mapContractListItem(section, it);
          // Enrich partner fields
          const partner = partnersById.get(String(it.partner_id));
          if (partner) {
            const combined = partner.partner_code && partner.partner_name
              ? `${partner.partner_code} : ${partner.partner_name}`
              : partner.partner_code ?? null;
            row.partnerCode = combined && combined.length > 255 ? combined.slice(0, 255) : combined;
            row.partnerName = partner.partner_name ?? null;
            row.partnerProvince = partner.partner_province ?? null;
            row.partnerStatus = partner.partner_status === "active" ? "ใช้งาน" : partner.partner_status ?? null;
          }
          // Enrich customer fields
          const customer = customersById.get(String(it.customer_id));
          if (customer) Object.assign(row, mapCustomerProfile(customer));
          buffer.push(row);
        }

        if (buffer.length >= 500) rowCount += await upsertContracts(buffer.splice(0, buffer.length), section);

        setSubProgress(section, "contracts", page * 200, totalContractRows);
        updateSyncLogStage({
          id: log.id,
          section,
          currentStage: "contracts",
          progress: Math.round((page / totalPages) * 100),
          resumePage: page + 1,
        }).catch(() => {});
      },
      200,
      30_000, // 30s per-request timeout (same as customers — FF API can be slow)
      startPage,
    );

    if (buffer.length) rowCount += await upsertContracts(buffer, section);

    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({ id: log.id, status: "error", rowCount, errorMessage: err?.message ?? String(err) });
    throw err;
  }
}

/**
 * Stage MDM Online: ดึง MDM device list ทั้งหมดครั้งเดียว แล้ว bulk update last_online_days ใน contracts
 * ใช้ serial_no ใน contracts เป็น key match กับ deviceId ใน MDM API
 * เงื่อนไขการแสดงผลเหมือนกับเมนูกลุ่มเฝ้าระวัง
 */
export async function syncMdmOnlineDays(
  section: SectionKey,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const { getDb } = await import("../db");
  const { contracts } = await import("../../drizzle/schema");
  const { eq, and, isNotNull } = await import("drizzle-orm");

  const db = await getDb(section);
  if (!db) return 0;

  // ดึง serial_no ทั้งหมดที่ไม่เป็น null
  const rows = await db
    .select({ externalId: contracts.externalId, serialNo: contracts.serialNo })
    .from(contracts)
    .where(and(eq(contracts.section, section), isNotNull(contracts.serialNo)));

  const validRows = rows.filter((r: { externalId: string; serialNo: string | null }) => r.serialNo);
  const total = validRows.length;
  console.log(`[syncMdmOnlineDays] ${section}: ${total} contracts with serial_no (out of ${rows.length} total)`);

  if (total === 0) return 0;

  onProgress?.(0, total);

  // Bulk update ทุก row ให้เป็น null เพื่อรอให้ frontend มาดึง MDM ทีหลัง
  // (แก้ปัญหา Cloudflare block Render IP)
  let updated = 0;
  const BATCH = 100;
  for (let i = 0; i < validRows.length; i += BATCH) {
    const batch = validRows.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (r: { externalId: string; serialNo: string | null }) => {
        await db
          .update(contracts)
          .set({
            lastOnlineDays: null,
            lastOnlineAt: null,
            deviceLock: null,
          })
          .where(and(eq(contracts.section, section), eq(contracts.externalId, r.externalId)));
        updated++;
      })
    );
    onProgress?.(Math.min(i + BATCH, total), total);
  }

  console.log(`[syncMdmOnlineDays] ${section}: cleared MDM data for ${updated}/${total} contracts (waiting for frontend sync)`);
  return updated;
}

/**
 * Stage 3b: Enrich IMEI / Serial No — ดึง detail endpoint ทุกสัญญา แบบ parallel 20 req
 * เพื่อให้ imei และ serialNo ใน contracts table ถูกต้องและ up-to-date ทุกรอบ sync
 *
 * Fix: เพิ่ม CONCURRENCY จาก 5 → 20 เพื่อให้เสร็จเร็วขึ้น
 * Fix: เพิ่ม keepalive query ทุก 500 รายการ เพื่อป้องกัน Render Postgres ตัด idle connection
 */
async function enrichContractDeviceIds(
  client: PartnerClient,
  section: SectionKey,
): Promise<void> {
  const { getDb } = await import("../db");
  const { contracts } = await import("../../drizzle/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const db = await getDb(section);
  if (!db) return;

  // ดึง externalId ทุกสัญญาใน section
  const rows = await db
    .select({ externalId: contracts.externalId })
    .from(contracts)
    .where(eq(contracts.section, section));

  const contractIds = rows.map((r: { externalId: string }) => r.externalId);
  const total = contractIds.length;
  console.log(`[enrichDeviceIds] ${section}: enriching ${total} contracts...`);

  const CONCURRENCY = 20; // เพิ่มจาก 5 เป็น 20 เพื่อให้เสร็จเร็วขึ้น
  let idx = 0;
  let done = 0;
  let enriched = 0;
  let errors = 0;
  const startTime = Date.now();
  let lastKeepalive = 0; // track จำนวน done ล่าสุดที่ keepalive

  const worker = async () => {
    while (idx < contractIds.length) {
      const myIdx = idx++;
      const contractId = contractIds[myIdx];
      try {
        const data: any = await client.get("contract", {
          action: "detail",
          id: contractId,
        });
        const detail = mapContractDetailOverrides(section, data);
        const product = data?.contract?.product ?? {};
        const imei = detail.imei ?? product.imei ?? null;
        const serialNo = detail.serialNo ?? product.serial_no ?? null;
        await db
          .update(contracts)
          .set({
            imei,
            serialNo,
            addrHouseNo: detail.addrHouseNo ?? null,
            addrMoo: detail.addrMoo ?? null,
            addrVillage: detail.addrVillage ?? null,
            addrSoi: detail.addrSoi ?? null,
            addrStreet: detail.addrStreet ?? null,
            addrSubdistrict: detail.addrSubdistrict ?? null,
            addrDistrict: detail.addrDistrict ?? null,
            addrProvince: detail.addrProvince ?? null,
            addrPostalCode: detail.addrPostalCode ?? null,
            syncedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(contracts.section, section),
              eq(contracts.externalId, contractId)
            )
          );
        enriched++;
      } catch {
        errors++;
      }
      done++;
      if (done % 200 === 0 || done === total) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[enrichDeviceIds] ${section}: ${done}/${total} done (enriched=${enriched}, errors=${errors}, elapsed=${elapsed}s)`);
        setSubProgress(section, "imei_enrich", done, total);
      }
      // Keepalive: ping DB ทุก 500 รายการ เพื่อป้องกัน Render Postgres ตัด idle connection
      if (done - lastKeepalive >= 500) {
        lastKeepalive = done;
        try {
          await db.execute(sql`SELECT 1`);
          console.log(`[enrichDeviceIds] ${section}: keepalive ping at ${done}/${total}`);
        } catch (pingErr: any) {
          console.warn(`[enrichDeviceIds] ${section}: keepalive failed: ${pingErr?.message ?? pingErr}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const totalSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`[enrichDeviceIds] ${section}: finished enriched=${enriched}, errors=${errors}, total=${totalSec}s`);
}

/**
 * Stage 4: Installments — upsert ลง installments table
 */
async function syncInstallments(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const log = await insertSyncLog({ section, entity: "installments", triggeredBy: "on-demand" });
  let rowCount = 0;
  try {
    const buffer: any[] = [];
    let totalInstRows = 0;

    try {
      // Use forEachPageParallel for installments to speed up sync
      await client.forEachPageParallel<any>(
        "contract",
        (d) => d?.installments,
        { action: "installments" },
        async (items, page, totalPages) => {
          if (totalInstRows === 0 && totalPages > 0) totalInstRows = totalPages * 500;
          for (const it of items) buffer.push(mapInstallment(section, it));
          if (buffer.length >= 1000) rowCount += await upsertInstallments(buffer.splice(0, buffer.length), section);
          setSubProgress(section, "installments", page * 500, totalInstRows);
        },
        500, // limit per page
        30_000, // timeoutMs
        1, // startPage
        5, // batchSize (parallel requests)
        200, // delayMs between batches
      );
    } catch (err) {
      if (err instanceof PartnerApiError && err.status === 404) {
        console.warn(`[sync] ${section}: installments endpoint not available (404)`);
      } else {
        throw err;
      }
    }

    if (buffer.length) rowCount += await upsertInstallments(buffer, section);
    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({ id: log.id, status: "error", rowCount, errorMessage: err?.message ?? String(err) });
    throw err;
  }
}

/**
 * Stage 5: Payments — upsert ลง payment_transactions table
 *
 * หมายเหตุ: ไม่มี cleanupTodayPayments และไม่มี delete detection
 * เพราะ upsert idempotent อยู่แล้ว — sync ซ้ำได้ไม่เสียหาย
 */
async function syncPayments(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const log = await insertSyncLog({ section, entity: "payments", triggeredBy: "on-demand" });
  let rowCount = 0;
  try {
    const buffer: any[] = [];

    // Use forEachPageParallel for payments to speed up sync
    await client.forEachPageParallel<any>(
      "payment",
      (d) => d?.transactions,
      { action: "transactions" },
      async (items, page, totalPages) => {
        for (const it of items) buffer.push(mapPayment(section, it));
        if (buffer.length >= 1000) rowCount += await upsertPayments(buffer.splice(0, buffer.length), section);
        setSubProgress(section, "payments", page * 1000, totalPages * 1000);
      },
      1000, // limit per page
      30_000, // timeoutMs
      1, // startPage
      5, // batchSize (parallel requests)
      200, // delayMs between batches
    );

    if (buffer.length) rowCount += await upsertPayments(buffer, section);
    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({ id: log.id, status: "error", rowCount, errorMessage: err?.message ?? String(err) });
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Stage 6: Commissions                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Stage 6: Commissions — ดึงจาก API แล้ว upsert ลง commissions table
 */
async function syncCommissions(
  client: PartnerClient,
  section: SectionKey,
): Promise<number> {
  const log = await insertSyncLog({ section, entity: "commissions", triggeredBy: "on-demand" });
  let rowCount = 0;
  try {
    const buffer: any[] = [];
    try {
      await client.forEachPage<any>(
        "commission",
        (d) => d?.commissions,
        { action: "all" },
        async (items, page, totalPages) => {
          for (const it of items) buffer.push(mapCommission(section, it));
          if (buffer.length >= 500) rowCount += await upsertCommissions(buffer.splice(0, buffer.length), section);
          setSubProgress(section, "commissions", page * 200, Math.max(totalPages * 200, page * 200));
        },
        200,
        60_000,
      );
    } catch (err) {
      if (err instanceof PartnerApiError && err.status === 404) {
        console.warn(`[sync] ${section}: commissions endpoint not available (404)`);
      } else {
        throw err;
      }
    }
    if (buffer.length) rowCount += await upsertCommissions(buffer, section);
    await finishSyncLog({ id: log.id, status: "success", rowCount });
    return rowCount;
  } catch (err: any) {
    await finishSyncLog({ id: log.id, status: "error", rowCount, errorMessage: err?.message ?? String(err) });
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Stage 7: Bad-debt computation                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * คำนวณ bad_debt_amount, bad_debt_date, suspended_from_period
 * แล้ว UPDATE ลง contracts table
 *
 * Business rules:
 *  - contract.status = "หนี้เสีย" → bad-debt confirmed
 *  - contract.status = "ระงับสัญญา" → device returned, no bad-debt amount
 */
async function computeAndStoreBadDebt(section: SectionKey): Promise<void> {
  const { getDb } = await import("../db");
  const { contracts, paymentTransactions, installments } = await import("../../drizzle/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const db = await getDb(section);
  if (!db) return;

  // ดึง contracts ที่เป็น bad-debt หรือ suspended
    const targetContracts: Array<{ externalId: string; status: string | null; installmentAmount: string | null }> = await db
    .select({
      externalId: contracts.externalId,
      status: contracts.status,
      installmentAmount: contracts.installmentAmount,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.section, section),
        sql`${contracts.status} IN ('หนี้เสีย', 'ระงับสัญญา')`,
      ),
    );

  if (targetContracts.length === 0) return;

  const BATCH_SIZE = 100;

  async function flushBatch(batch: Array<{ externalId: string; status: string | null; installmentAmount: string | null }>) {
    if (batch.length === 0) return;

    // ดึง payments สำหรับ contracts ใน batch นี้
    const extIds = batch.map((c) => c.externalId);
    const payments: Array<{ contractExternalId: string | null; paidAt: string | null; amount: string | null; status: string | null }> = await db!
      .select({
        contractExternalId: paymentTransactions.contractExternalId,
        paidAt: paymentTransactions.paidAt,
        amount: paymentTransactions.amount,
        status: paymentTransactions.status,
      })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.section, section),
          sql`${paymentTransactions.contractExternalId} = ANY(${sql.raw(`ARRAY[${extIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`,
        ),
      );

    // ดึง installments สำหรับ suspended_from_period
    const instRows: Array<{ contractExternalId: string; period: number | null; status: string | null }> = await db!
      .select({
        contractExternalId: installments.contractExternalId,
        period: installments.period,
        status: installments.status,
      })
      .from(installments)
      .where(
        and(
          eq(installments.section, section),
          sql`${installments.contractExternalId} = ANY(${sql.raw(`ARRAY[${extIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`,
        ),
      );

    // Group by contract
    const payMap = new Map<string, Array<{ contractExternalId: string | null; paidAt: string | null; amount: string | null; status: string | null }>>();
    for (const p of payments) {
      const key = p.contractExternalId ?? "";
      if (!payMap.has(key)) payMap.set(key, []);
      payMap.get(key)!.push(p);
    }
    const instMap = new Map<string, Array<{ contractExternalId: string; period: number | null; status: string | null }>>();
    for (const i of instRows) {
      const key = i.contractExternalId;
      if (!instMap.has(key)) instMap.set(key, []);
      instMap.get(key)!.push(i);
    }

    // คำนวณและ UPDATE ทีละ contract
    for (const contract of batch) {
      const cPays = payMap.get(contract.externalId) ?? [];
      const cInsts = instMap.get(contract.externalId) ?? [];

      // Bad-debt payments = payments ที่ status = 'หนี้เสีย' หรือ contract status = 'หนี้เสีย'
      const isBadDebt = contract.status === "หนี้เสีย";
      const badDebtPayments = isBadDebt ? cPays : [];
      const badDebtAmount = badDebtPayments.reduce((sum: number, p: { amount: string | null }) => sum + parseFloat(p.amount ?? "0"), 0);
      // คำนวณ bad-debt date = วันที่ชำระล่าสุดในกลุ่ม bad-debt payments
      const badDebtDate = isBadDebt && badDebtPayments.length > 0
        ? badDebtPayments
            .map((p: any) => p.paidAt ?? "")
            .filter(Boolean)
            .sort()
            .reverse()[0] ?? null
        : null;
      // Suspended from period = งวดแรกที่มี status suspend/cancel
      const SUSPEND_CODES = ["ระงับ", "ยกเลิก", "suspend", "cancel", "cancelled", "suspended"];
      const suspendedInst = cInsts
        .filter((i: { period: number | null; status: string | null }) => i.status && SUSPEND_CODES.some((code: string) => i.status!.toLowerCase().includes(code.toLowerCase())))
        .sort((a: { period: number | null }, b: { period: number | null }) => (a.period ?? 0) - (b.period ?? 0))[0];
      const suspendedFromPeriod = suspendedInst?.period ?? null;

      await db!
        .update(contracts)
        .set({
          badDebtAmount: isBadDebt ? String(badDebtAmount.toFixed(2)) : null,
          badDebtDate: badDebtDate ?? null,
          suspendedFromPeriod: suspendedFromPeriod,
        })
        .where(
          and(
            eq(contracts.section, section),
            eq(contracts.externalId, contract.externalId),
          ),
        );
    }
  }

  // Process in batches
  for (let i = 0; i < targetContracts.length; i += BATCH_SIZE) {
    await flushBatch(targetContracts.slice(i, i + BATCH_SIZE));
  }

  console.log(`[computeAndStoreBadDebt] ${section}: updated ${targetContracts.length} bad-debt contracts`);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Re-exports for backward compatibility                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

// computeAndStoreBadDebt is defined above and exported here for run-bad-debt.ts
export { computeAndStoreBadDebt };

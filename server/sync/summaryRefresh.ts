/**
 * Rebuild monthly summary caches after debt_target_cache / debt_collected_cache are ready.
 */
import { populateIncomeType, rebuildIncomeMonthlySummary } from "../accountingDb";
import { populateMonthlySummaryCache, populateDueMonthCache } from "../monthlySummaryDb";
import { populateMonthlyCollectionSnapshot } from "../monthlyCollectionSnapshotDb";
import { ensureSectionSchemaReady } from "../db";
import type { SectionKey } from "../../shared/const";
import { isSyncRunning } from "./runner";
import { finishSyncLog, insertSyncLog, updateSyncLogStage } from "./syncLog";

const _locks: Record<SectionKey, boolean> = { Boonphone: false, Fastfone365: false };

export function isSummaryRefreshRunning(section: SectionKey): boolean {
  return _locks[section];
}

async function runSummaryRefreshSteps(
  section: SectionKey,
  logId?: number,
  progressBase = 0,
  progressSpan = 100,
): Promise<{ incomeTypeRows: number; summaryRows: number; msCacheRows: number; snapshotRows: number }> {
  const beat = (stage: string, fraction: number) => {
    if (!logId) return;
    const progress = progressBase + Math.round(fraction * progressSpan);
    updateSyncLogStage({ id: logId, section, currentStage: stage, progress }).catch(() => {});
  };

  beat("income_type", 0.05);
  const incomeTypeRows = await populateIncomeType(section);
  console.log(`[summaryRefresh] ${section}: income_type — ${incomeTypeRows} rows`);

  beat("income_monthly_summary", 0.15);
  const summaryRows = await rebuildIncomeMonthlySummary(section);
  console.log(`[summaryRefresh] ${section}: income_monthly_summary — ${summaryRows} rows`);

  beat("monthly_summary_cache", 0.25);
  const msCacheRows = await populateMonthlySummaryCache(section, (current, total) => {
    const fraction = 0.25 + (total > 0 ? (current / total) * 0.5 : 0);
    beat(`monthly_summary_cache (${current}/${total})`, fraction);
  });
  console.log(`[summaryRefresh] ${section}: monthly_summary_cache — ${msCacheRows} rows`);

  const dmCacheRows = await populateDueMonthCache(section);
  console.log(`[summaryRefresh] ${section}: monthly_summary_due_month_cache — ${dmCacheRows} rows`);

  const bangkokDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dayOfMonth = parseInt(bangkokDate.slice(8, 10), 10);
  const snapshotCutoffMode = dayOfMonth === 1 ? "end_of_month" : "today";

  beat("monthly_collection_snapshot", 0.8);
  const snapshotRows = await populateMonthlyCollectionSnapshot(
    section,
    (current, total) => {
      const fraction = 0.8 + (total > 0 ? (current / total) * 0.19 : 0);
      beat(`monthly_collection_snapshot (${current}/${total})`, fraction);
    },
    snapshotCutoffMode,
  );
  console.log(
    `[summaryRefresh] ${section}: monthly_collection_snapshot — ${snapshotRows} months (cutoff=${snapshotCutoffMode})`,
  );

  return { incomeTypeRows, summaryRows, msCacheRows: msCacheRows + dmCacheRows, snapshotRows };
}

export async function runSummaryRefreshPipeline(
  section: SectionKey,
): Promise<{ ok: boolean; message?: string }> {
  if (_locks[section]) {
    return { ok: false, message: `[${section}] summary refresh already running` };
  }
  if (isSyncRunning(section)) {
    return { ok: false, message: `[${section}] full sync is still running` };
  }

  _locks[section] = true;
  let logId = 0;

  try {
    await ensureSectionSchemaReady(section);
    const log = await insertSyncLog({
      section,
      entity: "summary_refresh",
      triggeredBy: "manual",
    });
    logId = log.id;

    console.log(`[summaryRefresh] ${section}: starting`);
    const result = await runSummaryRefreshSteps(section, logId);

    await finishSyncLog({
      id: logId,
      section,
      status: "success",
      rowCount: result.incomeTypeRows + result.summaryRows + result.msCacheRows + result.snapshotRows,
    });

    return {
      ok: true,
      message: `income_type=${result.incomeTypeRows}, monthly_cache=${result.msCacheRows}, snapshot=${result.snapshotRows}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[summaryRefresh] ${section}: failed:`, msg);
    if (logId) {
      await finishSyncLog({ id: logId, section, status: "error", errorMessage: msg }).catch(() => {});
    }
    return { ok: false, message: msg };
  } finally {
    _locks[section] = false;
  }
}

/** Called from postProcess after debt cache populate — shares the same sync log. */
export async function runSummaryRefreshAfterPostProcess(
  section: SectionKey,
  logId: number,
): Promise<void> {
  try {
    await runSummaryRefreshSteps(section, logId, 70, 30);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[summaryRefresh] ${section}: post-process summary step failed (non-fatal):`, msg);
  }
}

/**
 * Post-sync pipeline — fillPeriodNos + populate debt cache without re-downloading API data.
 *
 * Use when full sync fetched installments/payments but died during fillPeriodNos
 * (e.g. zombie detection on entity=all). Uses entity=post_process sync log so UI
 * polling for entity=all does not auto-clear this job.
 */
import { rebuildIncomeMonthlySummary } from "../accountingDb";
import { ensureSectionSchemaReady } from "../db";
import type { SectionKey } from "../../shared/const";
import { fillPeriodNosForSection } from "./fillPeriodNos";
import { populateDebtCache } from "./populateCache";
import { isSyncRunning } from "./runner";
import { finishSyncLog, insertSyncLog, updateSyncLogStage } from "./syncLog";

const _locks: Record<SectionKey, boolean> = { Boonphone: false, Fastfone365: false };

export function isPostProcessRunning(section: SectionKey): boolean {
  return _locks[section];
}

export async function runPostSyncPipeline(
  section: SectionKey,
): Promise<{ ok: boolean; message?: string }> {
  if (_locks[section]) {
    return { ok: false, message: `[${section}] post-process already running` };
  }
  if (isSyncRunning(section)) {
    return { ok: false, message: `[${section}] full sync is still running — wait or cancel first` };
  }

  _locks[section] = true;
  let logId = 0;

  try {
    await ensureSectionSchemaReady(section);
    const log = await insertSyncLog({
      section,
      entity: "post_process",
      triggeredBy: "manual",
    });
    logId = log.id;

    console.log(`[postProcess] ${section}: starting fillPeriodNos + populate cache`);

    const fillCount = await fillPeriodNosForSection(section, (current, total) => {
      const progress = total > 0 ? Math.round((current / total) * 60) : 0;
      updateSyncLogStage({
        id: logId,
        section,
        currentStage: `fill_period_nos (${current}/${total})`,
        progress,
      }).catch(() => {});
    });
    console.log(`[postProcess] ${section}: fillPeriodNos done — ${fillCount} rows`);

    await updateSyncLogStage({
      id: logId,
      section,
      currentStage: "populate_cache",
      progress: 65,
    }).catch(() => {});

    const cache = await populateDebtCache(section, (phase, current, total) => {
      if (phase === "collected" && total > 0) {
        const progress = 65 + Math.round((current / total) * 30);
        updateSyncLogStage({
          id: logId,
          section,
          currentStage: `populate (${current}/${total})`,
          progress,
        }).catch(() => {});
      }
    });
    console.log(
      `[postProcess] ${section}: cache populated — target=${cache.targetRows}, collected=${cache.collectedRows}`,
    );

    try {
      const summaryRows = await rebuildIncomeMonthlySummary(section);
      console.log(`[postProcess] ${section}: income_monthly_summary — ${summaryRows} rows`);
    } catch (summaryErr: unknown) {
      const msg = summaryErr instanceof Error ? summaryErr.message : String(summaryErr);
      console.warn(`[postProcess] ${section}: income_monthly_summary failed (non-fatal):`, msg);
    }

    await finishSyncLog({
      id: logId,
      section,
      status: "success",
      rowCount: fillCount + cache.targetRows + cache.collectedRows,
    });

    return {
      ok: true,
      message: `fill=${fillCount}, target=${cache.targetRows}, collected=${cache.collectedRows}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[postProcess] ${section}: failed:`, msg);
    if (logId) {
      await finishSyncLog({ id: logId, section, status: "error", errorMessage: msg }).catch(() => {});
    }
    return { ok: false, message: msg };
  } finally {
    _locks[section] = false;
  }
}

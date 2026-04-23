/**
 * Simple in-process scheduler — runs once a day at 06:00 every day.
 * The process checks once a minute; when hour matches 06 and we haven't
 * already synced today, it kicks off a run for each configured section.
 */

import type { SectionKey } from "../../shared/const";
import { SECTIONS } from "../../shared/const";
import { runSectionSync, isSyncRunning } from "./runner";
import { getLastSyncedAt, getLastErrorAt } from "./syncLog";
import { buildClientFromEnv } from "../api/partnerClient";

/** Returns true if both base URL + credentials are present for the section. */
function isSectionConfigured(section: SectionKey): boolean {
  const client = buildClientFromEnv(section);
  return Boolean(client && client.isConfigured());
}

const SYNC_HOUR = 6; // 06:00 daily

let _timer: NodeJS.Timeout | null = null;
let _lastTick: Record<string, string> = {}; // `${section}-${YYYY-MM-DD}`

function currentDaySlot(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSyncTime(d = new Date()): boolean {
  return d.getHours() === SYNC_HOUR;
}

/** One tick — called once a minute. */
async function tick() {
  const now = new Date();
  if (!isSyncTime(now)) return;
  if (now.getMinutes() !== 0) return; // only at :00
  const slot = currentDaySlot(now);

  for (const section of SECTIONS as readonly SectionKey[]) {
    if (!isSectionConfigured(section)) continue; // skip unconfigured sections
    const tag = `${section}::${slot}`;
    if (_lastTick[section] === slot) continue;
    if (isSyncRunning(section)) continue;
    _lastTick[section] = slot;
    console.log(`[scheduler] ${tag} triggering daily cron sync`);
    runSectionSync(section, "cron").catch((err) =>
      console.error(`[scheduler] ${tag} failed:`, err),
    );
  }
}

/**
 * Start the scheduler. Also checks whether the most recent hour slot has been
 * run — if the server restarted during business hours and missed a sync, we
 * schedule one right away.
 */
export async function startScheduler() {
  if (_timer) return;
  console.log("[scheduler] started (daily at 06:00)");
  _timer = setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick error:", err));
  }, 60_000);

  // Missed-sync recovery: if today's sync hasn't run yet (last sync older than
  // 23h) and we're past 06:00, kick one immediately on startup.
  const now = new Date();
  const pastSyncHour = now.getHours() >= SYNC_HOUR;
  if (pastSyncHour) {
    for (const section of SECTIONS as readonly SectionKey[]) {
      if (!isSectionConfigured(section)) {
        console.log(`[scheduler] ${section} skipped (no credentials configured)`);
        continue;
      }
      // Cool-off: if the previous attempt errored within the last 30 min, skip.
      const lastErr = await getLastErrorAt({ section });
      if (lastErr && now.getTime() - lastErr.getTime() < 30 * 60 * 1000) {
        console.log(
          `[scheduler] ${section} skipped (recent error at ${lastErr.toISOString()})`,
        );
        continue;
      }
      const last = await getLastSyncedAt({ section });
      const oneDayMs = 23 * 60 * 60 * 1000; // 23h threshold
      if (!last || now.getTime() - last.getTime() > oneDayMs) {
        if (!isSyncRunning(section)) {
          console.log(`[scheduler] missed-sync catch-up for ${section}`);
          runSectionSync(section, "startup").catch(() => {});
        }
      }
    }
  }
}

export function stopScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Simple in-process scheduler — runs once a day at 04:00 Asia/Bangkok time.
 * The process checks once a minute; when hour matches 04 (Bangkok time) and we
 * haven't already synced today, it kicks off a run for each configured section.
 *
 * NOTE: Changed from 09:00 → 04:00 per business requirement (2026-05-11).
 * Sync is idempotent (upsert-only) — no data is deleted after sync.
 *
 * Missed-sync recovery: if the server restarts after 04:00 and the daily sync
 * hasn't run yet (last sync > 23h ago), it will kick off immediately on startup.
 *
 * IMPORTANT: Server may run in UTC or other timezones. All time comparisons
 * MUST use Asia/Bangkok (UTC+7) to match business requirements.
 */

import type { SectionKey } from "../../shared/const";
import { SECTIONS } from "../../shared/const";
import { runSectionSync, isSyncRunning } from "./runner";
import { getLastSyncedAt, getLastErrorAt, clearAllStuckSyncLogs } from "./syncLog";
import { buildClientFromEnv } from "../api/partnerClient";

/** Returns true if both base URL + credentials are present for the section. */
function isSectionConfigured(section: SectionKey): boolean {
  const client = buildClientFromEnv(section);
  return Boolean(client && client.isConfigured());
}

const SYNC_HOUR = 4; // 04:00 daily (Asia/Bangkok)
const BANGKOK_TZ = "Asia/Bangkok";

let _timer: NodeJS.Timeout | null = null;
let _lastTick: Record<string, string> = {}; // `${section}-${YYYY-MM-DD}` in Bangkok time

/**
 * Get current date/time parts in Asia/Bangkok timezone.
 * Uses Intl.DateTimeFormat which is available in Node.js without any packages.
 */
function getBangkokTimeParts(d = new Date()): { hour: number; minute: number; daySlot: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const daySlot = `${get("year")}-${get("month")}-${get("day")}`;
  return { hour, minute, daySlot };
}

function isSyncTime(d = new Date()): boolean {
  const { hour } = getBangkokTimeParts(d);
  return hour === SYNC_HOUR;
}

function currentDaySlot(d = new Date()): string {
  return getBangkokTimeParts(d).daySlot;
}

/** One tick — called once a minute. */
async function tick() {
  const now = new Date();
  const { hour, minute } = getBangkokTimeParts(now);
  if (hour !== SYNC_HOUR) return;
  if (minute !== 0) return; // only at :00
  const slot = currentDaySlot(now);

  for (const section of SECTIONS as readonly SectionKey[]) {
    if (!isSectionConfigured(section)) continue; // skip unconfigured sections
    const tag = `${section}::${slot}`;
    if (_lastTick[section] === slot) continue;
    if (isSyncRunning(section)) continue;
    _lastTick[section] = slot;
    console.log(`[scheduler] ${tag} triggering daily cron sync at 04:00 (Bangkok time: ${hour}:${String(minute).padStart(2,"0")})`);
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
  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[scheduler] DISABLED via DISABLE_SCHEDULER=true — skipping cron setup");
    return;
  }
  const now = new Date();
  const { hour: bangkokHour, daySlot } = getBangkokTimeParts(now);
    console.log(`[scheduler] started (daily at 04:00 Asia/Bangkok) — current Bangkok time: ${bangkokHour}:xx, slot: ${daySlot}`);

  // On startup: clear any orphaned in_progress rows left by a previous
  // Cloud Run instance that was killed mid-sync.
  await clearAllStuckSyncLogs();
  _timer = setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick error:", err));
  }, 60_000);

  // Missed-sync recovery: if today's sync hasn't run yet (last sync older than
  // 23h) and we're past 09:00 Bangkok time, kick one immediately on startup.
  const pastSyncHour = bangkokHour >= SYNC_HOUR;
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

/**
 * Simple in-process scheduler — runs every hour on the hour between 08:00
 * and 19:00 (inclusive), Monday through Saturday. We keep it small: the
 * process checks once a minute; when hour/day matches and we haven't already
 * synced this hour, it kicks off a run for each configured section.
 */

import type { SectionKey } from "../../shared/const";
import { SECTIONS } from "../../shared/const";
import { runSectionSync, isSyncRunning } from "./runner";
import { getLastSyncedAt } from "./syncLog";

const START_HOUR = 8;
const END_HOUR = 19; // inclusive: 08,09,...,19

let _timer: NodeJS.Timeout | null = null;
let _lastTick: Record<string, string> = {}; // `${section}-${YYYY-MM-DD-HH}`

function currentSlot(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day}-${h}`;
}

function isWithinBusinessHours(d = new Date()): boolean {
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  if (dow === 0) return false; // Sunday off
  const hr = d.getHours();
  return hr >= START_HOUR && hr <= END_HOUR;
}

/** One tick — called once a minute. */
async function tick() {
  const now = new Date();
  if (!isWithinBusinessHours(now)) return;
  if (now.getMinutes() !== 0) return; // only at :00
  const slot = currentSlot(now);

  for (const section of SECTIONS as readonly SectionKey[]) {
    const tag = `${section}::${slot}`;
    if (_lastTick[section] === slot) continue;
    if (isSyncRunning(section)) continue;
    _lastTick[section] = slot;
    console.log(`[scheduler] ${tag} triggering cron sync`);
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
  console.log("[scheduler] started (Mon-Sat 08:00-19:00 hourly)");
  _timer = setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick error:", err));
  }, 60_000);

  // Missed-sync recovery: if we are inside business hours and the last
  // successful sync for a section is older than 1h, kick one immediately.
  const now = new Date();
  if (isWithinBusinessHours(now)) {
    for (const section of SECTIONS as readonly SectionKey[]) {
      const last = await getLastSyncedAt({ section });
      if (!last || now.getTime() - last.getTime() > 60 * 60 * 1000) {
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

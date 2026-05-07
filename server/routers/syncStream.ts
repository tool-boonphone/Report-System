/**
 * SSE (Server-Sent Events) endpoint for sync progress.
 *
 * Problem: Cloud Run kills processes that have no active HTTP connection.
 *   - fire-and-forget: process killed immediately after request closes
 *   - await sync: Cloud Run 60s request timeout → 503 Service Unavailable
 *
 * Solution: Keep HTTP connection alive with SSE heartbeat every 5s while
 * sync runs. Cloud Run sees an active connection and keeps the process alive.
 *
 * Endpoint: GET /api/sync-stream/:section
 * Auth: requires canSync permission on sync_api
 * Response: text/event-stream
 *   data: {"type":"progress","progress":20,"currentStage":"customers"}
 *   data: {"type":"heartbeat"}
 *   data: {"type":"done","ok":true,"rowCount":12345}
 *   data: {"type":"error","message":"..."}
 */

import type { Request, Response } from "express";
import { APP_SESSION_COOKIE } from "../../shared/const";
import { getUserFromSession, checkPermission } from "../authDb";
import { runSectionSync, isSyncRunning, getSyncStatus } from "../sync/runner";
import { getDbSyncStatus } from "../sync/syncLog";
import type { SectionKey } from "../../shared/const";
import { SECTIONS } from "../../shared/const";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") ?? "");
  }
  return out;
}

function sendEvent(res: Response, data: object) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Flush immediately so proxy doesn't buffer
    if (typeof (res as any).flush === "function") (res as any).flush();
  } catch {
    // Client disconnected — ignore
  }
}

export async function handleSyncStream(req: Request, res: Response) {
  const section = req.params.section as SectionKey;

  // Validate section
  if (!SECTIONS.includes(section as any)) {
    return res.status(400).json({ error: "Invalid section" });
  }

  // Auth check
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[APP_SESSION_COOKIE];
  if (!sessionId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const user = await getUserFromSession(sessionId).catch(() => null);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const allowed = checkPermission(user, "sync_api", "sync");
  if (!allowed) {
    return res.status(403).json({ error: "ไม่มีสิทธิ์ใช้งาน Re-Sync" });
  }

  // Check if already running
  if (isSyncRunning(section)) {
    return res.status(409).json({ error: `Sync for ${section} is already running` });
  }

  // Set SSE headers — keep connection alive
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  // Send initial event
  sendEvent(res, { type: "started", section });

  let done = false;
  let lastProgress = -1;

  // Heartbeat + progress polling every 3s to keep connection alive
  const heartbeatInterval = setInterval(async () => {
    if (done) {
      clearInterval(heartbeatInterval);
      return;
    }
    try {
      // Read latest progress from in-memory (same instance) or DB
      const mem = getSyncStatus(section);
      const progress = mem?.progress ?? lastProgress;
      const currentStage = mem?.currentStage ?? "";

      if (progress !== lastProgress || currentStage) {
        lastProgress = progress;
        sendEvent(res, { type: "progress", progress, currentStage });
      } else {
        // Send heartbeat to keep connection alive
        sendEvent(res, { type: "heartbeat", elapsed: mem ? Date.now() - mem.startedAt : 0 });
      }
    } catch {
      sendEvent(res, { type: "heartbeat" });
    }
  }, 3000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  // Run sync — await here keeps the SSE connection (and Cloud Run process) alive
  try {
    const result = await runSectionSync(section, "manual");
    done = true;
    clearInterval(heartbeatInterval);
    sendEvent(res, { type: "done", ok: result.ok, rowCount: result.rowCount });
  } catch (err: any) {
    done = true;
    clearInterval(heartbeatInterval);
    sendEvent(res, { type: "error", message: err?.message ?? String(err) });
  } finally {
    res.end();
  }
}

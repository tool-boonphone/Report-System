/**
 * Streaming HTTP endpoints for debt report data.
 *
 * Problem: tRPC over HTTP/1.1 buffers the entire response before sending,
 * causing reverse-proxy 503/502 timeouts for large payloads (~51MB for FF365).
 *
 * Solution: Use plain Express routes with Transfer-Encoding: chunked.
 * The server writes the first byte immediately (keeps proxy alive), then
 * streams the JSON payload in chunks as it computes.
 *
 * Phase 43: True streaming — ส่ง rows ทีละ batch ระหว่างคำนวณ (ไม่รอ compute ทั้งหมด)
 * ทำให้ Cloudflare เห็น data ไหลมาตลอดและไม่ตัด connection ที่ 100s
 *
 * Endpoints:
 *   GET /api/debt/stream/target?section=Fastfone365
 *   GET /api/debt/stream/collected?section=Fastfone365
 *
 * Auth: reads report_session cookie, checks debt_report:view permission.
 * Response: application/json — shape: { rows: [...], hasPrincipalBreakdown?: boolean }
 */
import type { Request, Response } from "express";
import { APP_SESSION_COOKIE } from "../../shared/const";
import { getUserFromSession, checkPermission } from "../authDb";
import {
  getCachedTarget,
  setCachedTarget,
  getCachedCollected,
  setCachedCollected,
  waitForPrewarmTarget,
  waitForPrewarmCollected,
} from "../debtCache";
import {
  listDebtTarget,
  listDebtCollected,
  listDebtTargetStream,
  listDebtCollectedStream,
} from "../debtDb";
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

async function resolveUser(req: Request) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[APP_SESSION_COOKIE];
  if (!sid) return null;
  try {
    return await getUserFromSession(sid);
  } catch {
    return null;
  }
}

/**
 * Set streaming headers and write the opening JSON bracket immediately.
 * Returns immediately — caller must write rows then close with `]...}`.
 */
function startStreamResponse(res: Response): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Accel-Buffering", "no"); // ปิด nginx/Cloudflare buffering
  res.setHeader("Cache-Control", "no-cache");
  // Write opening bracket immediately — proxy sees byte 1 and won't timeout
  res.write('{"rows":[');
}

/**
 * Stream JSON response in chunks to keep the proxy connection alive.
 * Assumes `{"rows":[` has already been written by startStreamResponse().
 */
async function streamJsonRows(
  res: Response,
  rows: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  meta: Record<string, unknown> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const CHUNK_SIZE = 50; // rows per write
    let i = 0;
    let first = true;

    function writeChunk() {
      try {
        const end = Math.min(i + CHUNK_SIZE, rows.length);
        while (i < end) {
          const prefix = first ? "" : ",";
          first = false;
          res.write(prefix + JSON.stringify(rows[i]));
          i++;
        }

        if (i < rows.length) {
          // Schedule next chunk via setImmediate to yield to event loop
          setImmediate(writeChunk);
        } else {
          // Done — append metadata fields and close
          const metaStr = Object.entries(meta)
            .map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`)
            .join("");
          res.write("]" + metaStr + "}");
          res.end();
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    }

    writeChunk();
  });
}

/**
 * True streaming: iterate async generator and write rows as they arrive.
 * Phase 43: ส่ง rows ทีละ batch ระหว่างคำนวณ — Cloudflare เห็น data ไหลมาตลอด
 */
async function streamFromGenerator(
  res: Response,
  gen: AsyncGenerator<any[], void, unknown>,
  meta: Record<string, unknown> = {},
): Promise<void> {
  let first = true;
  for await (const batch of gen) {
    for (const row of batch) {
      const prefix = first ? "" : ",";
      first = false;
      res.write(prefix + JSON.stringify(row));
    }
    // Flush after each batch so Cloudflare sees data flowing
    // (Express will flush automatically on next tick, but explicit helps)
  }
  const metaStr = Object.entries(meta)
    .map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join("");
  res.write("]" + metaStr + "}");
  res.end();
}

/**
 * True streaming for collected: generator yields { rows, meta } objects
 */
async function streamFromCollectedGenerator(
  res: Response,
  gen: AsyncGenerator<{ rows: any[]; meta?: Record<string, unknown> }, void, unknown>,
): Promise<void> {
  let first = true;
  let lastMeta: Record<string, unknown> = {};
  for await (const chunk of gen) {
    for (const row of chunk.rows) {
      const prefix = first ? "" : ",";
      first = false;
      res.write(prefix + JSON.stringify(row));
    }
    if (chunk.meta) lastMeta = { ...lastMeta, ...chunk.meta };
  }
  const metaStr = Object.entries(lastMeta)
    .map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join("");
  res.write("]" + metaStr + "}");
  res.end();
}

/** GET /api/debt/stream/target?section=... */
export async function handleDebtStreamTarget(
  req: Request,
  res: Response,
): Promise<void> {
  // Auth check
  const appUser = await resolveUser(req);
  if (!appUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!checkPermission(appUser, "debt_report", "view")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Validate section
  const section = req.query.section as string;
  if (!SECTIONS.includes(section as SectionKey)) {
    res.status(400).json({ error: "Invalid section" });
    return;
  }

  try {
    // If prewarm is in progress, wait for it — avoids double-streaming and OOM
    await waitForPrewarmTarget(section);

    // Cache hit — stream immediately from cached array
    const cached = getCachedTarget(section);
    if (cached) {
      console.log(`[debtStream] HIT target for ${section}`);
      startStreamResponse(res);
      await streamJsonRows(res, cached.rows);
      return;
    }

    // Cache miss (prewarm failed or not started) — TRUE STREAMING
    console.log(`[debtStream] MISS target for ${section}, true-streaming...`);
    startStreamResponse(res);

    // Collect all rows while streaming (for cache fill)
    const allRows: any[] = [];
    const gen = listDebtTargetStream({ section: section as SectionKey, batchSize: 100 });
    let first = true;
    for await (const batch of gen) {
      for (const row of batch) {
        const prefix = first ? "" : ",";
        first = false;
        res.write(prefix + JSON.stringify(row));
        allRows.push(row);
      }
    }
    res.write("]}");
    res.end();

    // Cache the result for subsequent requests
    setCachedTarget(section, { rows: allRows });
    console.log(`[debtStream] target for ${section} cached (${allRows.length} rows)`);
  } catch (err) {
    console.error("[debtStream] target error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.end();
    }
  }
}

/** GET /api/debt/stream/collected?section=... */
export async function handleDebtStreamCollected(
  req: Request,
  res: Response,
): Promise<void> {
  // Auth check
  const appUser = await resolveUser(req);
  if (!appUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!checkPermission(appUser, "debt_report", "view")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Validate section
  const section = req.query.section as string;
  if (!SECTIONS.includes(section as SectionKey)) {
    res.status(400).json({ error: "Invalid section" });
    return;
  }

  try {
    // If prewarm is in progress, wait for it — avoids keep-alive whitespace corrupting JSON
    await waitForPrewarmCollected(section);

    // Cache hit — stream immediately from cached array
    const cached = getCachedCollected(section);
    if (cached) {
      console.log(`[debtStream] HIT collected for ${section}`);
      startStreamResponse(res);
      await streamJsonRows(res, cached.rows, {
        hasPrincipalBreakdown: cached.hasPrincipalBreakdown,
      });
      return;
    }

    // Cache miss (prewarm failed or not started) — TRUE STREAMING (no keep-alive needed)
    console.log(`[debtStream] MISS collected for ${section}, true-streaming...`);
    startStreamResponse(res);

    // Collect all rows while streaming (for cache fill)
    const allRows: any[] = [];
    let hasPrincipalBreakdown = true;
    const gen = listDebtCollectedStream({ section: section as SectionKey, batchSize: 100 });
    let first = true;
    for await (const chunk of gen) {
      for (const row of chunk.rows) {
        const prefix = first ? "" : ",";
        first = false;
        res.write(prefix + JSON.stringify(row));
        allRows.push(row);
      }
      if (chunk.meta?.hasPrincipalBreakdown != null) {
        hasPrincipalBreakdown = chunk.meta.hasPrincipalBreakdown as boolean;
      }
    }
    res.write(`],\"hasPrincipalBreakdown\":${hasPrincipalBreakdown}}`);
    res.end();

    // Cache the result for subsequent requests
    setCachedCollected(section, { rows: allRows, hasPrincipalBreakdown });
    console.log(`[debtStream] collected for ${section} cached (${allRows.length} rows)`);
  } catch (err) {
    console.error("[debtStream] collected error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.end();
    }
  }
}

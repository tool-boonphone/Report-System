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
 * Phase 113 Fix: ลบ waitForPrewarm ออก — ไม่รอ prewarm (75-90s) แต่ดึงจาก DB cache
 * ทันที (~1-2s) เพื่อป้องกัน Cloudflare 503 เมื่อ server restart
 * Priority: in-memory cache → DB cache → full stream (fallback)
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
  // waitForPrewarm removed: Phase 113 Fix — ไม่รอ prewarm เพื่อป้องกัน Cloudflare 503
} from "../debtCache";
import {
  listDebtTargetStream,
  listDebtCollectedStream,
} from "../debtDb";
import {
  streamTargetFromCache,
  streamCollectedFromCache,
} from "../sync/queryCacheDb";
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
    // Phase 113 Fix: ไม่รอ prewarm — ตรวจ in-memory cache ก่อน
    // ถ้าไม่มีให้ดึงจาก DB cache ทันที (ไม่รอ prewarm 75-90s)

    // 1. In-memory cache hit — เร็วที่สุด (~ms)
    const cached = getCachedTarget(section);
    if (cached) {
      console.log(`[debtStream] HIT target for ${section}`);
      startStreamResponse(res);
      await streamJsonRows(res, cached.rows);
      return;
    }

    // 2. DB cache — fast path (~1-2s) ใช้เมื่อ in-memory ว่าง (เช่น หลัง server restart)
    console.log(`[debtStream] MISS target for ${section}, streaming from DB cache...`);
    startStreamResponse(res);

    const allRows: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let usedDbCache = false;
    const dbCacheGen = streamTargetFromCache({ section: section as SectionKey, batchSize: 200 });
    let first = true;
    for await (const batch of dbCacheGen) {
      if (batch.length > 0) usedDbCache = true;
      for (const row of batch) {
        const prefix = first ? "" : ",";
        first = false;
        res.write(prefix + JSON.stringify(row));
        allRows.push(row);
      }
    }

    // 3. Fallback: DB cache ว่าง → full stream (ใช้เฉพาะกรณี DB cache ยังไม่ได้ populate)
    if (!usedDbCache) {
      console.log(`[debtStream] DB cache empty for ${section}, falling back to full stream...`);
      const gen = listDebtTargetStream({ section: section as SectionKey, batchSize: 100 });
      for await (const batch of gen) {
        for (const row of batch) {
          const prefix = first ? "" : ",";
          first = false;
          res.write(prefix + JSON.stringify(row));
          allRows.push(row);
        }
      }
    }

    res.write("]}");
    res.end();

    // Populate in-memory cache for subsequent requests (background, non-blocking)
    setCachedTarget(section, { rows: allRows });
    console.log(`[debtStream] target for ${section} cached (${allRows.length} rows, dbCache=${usedDbCache})`);
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
    // Phase 113 Fix: ไม่รอ prewarm — ตรวจ in-memory cache ก่อน
    // ถ้าไม่มีให้ดึงจาก DB cache ทันที (ไม่รอ prewarm 75-90s)

    // 1. In-memory cache hit — เร็วที่สุด (~ms)
    const cached = getCachedCollected(section);
    if (cached) {
      console.log(`[debtStream] HIT collected for ${section}`);
      startStreamResponse(res);
      await streamJsonRows(res, cached.rows, {
        hasPrincipalBreakdown: cached.hasPrincipalBreakdown,
      });
      return;
    }

    // 2. DB cache — fast path (~1-2s) ใช้เมื่อ in-memory ว่าง (เช่น หลัง server restart)
    console.log(`[debtStream] MISS collected for ${section}, streaming from DB cache...`);
    startStreamResponse(res);

    const allRows: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let hasPrincipalBreakdown = true;
    let usedDbCache = false;
    const dbCacheGen = streamCollectedFromCache({ section: section as SectionKey, batchSize: 200 });
    let first = true;
    for await (const chunk of dbCacheGen) {
      if (chunk.rows.length > 0) usedDbCache = true;
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

    // 3. Fallback: DB cache ว่าง → full stream (ใช้เฉพาะกรณี DB cache ยังไม่ได้ populate)
    if (!usedDbCache) {
      console.log(`[debtStream] DB cache empty for ${section}, falling back to full stream...`);
      const gen = listDebtCollectedStream({ section: section as SectionKey, batchSize: 100 });
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
    }

    res.write(`],\"hasPrincipalBreakdown\":${hasPrincipalBreakdown}}`);
    res.end();

    // Populate in-memory cache for subsequent requests (background, non-blocking)
    setCachedCollected(section, { rows: allRows, hasPrincipalBreakdown });
    console.log(`[debtStream] collected for ${section} cached (${allRows.length} rows, dbCache=${usedDbCache})`);
  } catch (err) {
    console.error("[debtStream] collected error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.end();
    }
  }
}

/** POST /api/debt/cache/invalidate — Phase 88: force-clear server-side debt cache */
export async function handleDebtCacheInvalidate(
  req: Request,
  res: Response,
): Promise<void> {
  // Auth check — require Super Admin group (isSuperAdmin)
  const appUser = await resolveUser(req);
  if (!appUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Only Super Admin group can invalidate cache
  if (!appUser.group.isSuperAdmin) {
    res.status(403).json({ error: "Forbidden — Super Admin only" });
    return;
  }

  const { invalidateAllDebtCache } = await import("../debtCache");
  invalidateAllDebtCache();

  console.log(`[debtStream] Cache invalidated by user: ${appUser.username ?? appUser.id}`);
  res.json({ ok: true, message: "Cache invalidated. Next request will recompute from DB." });
}

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
} from "../debtCache";
import { listDebtTarget, listDebtCollected } from "../debtDb";
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
 * Send periodic keep-alive whitespace pings while waiting for computation.
 * Returns a cleanup function that stops the ping interval.
 *
 * Phase 42: ป้องกัน reverse proxy ตัด connection ระหว่าง cache-miss computation
 * (FF365 ใช้เวลา 30-60s) — ส่ง comment JSON `\n` ทุก 8 วินาที
 * NOTE: ใช้เฉพาะก่อน res.write() ครั้งแรก เพราะหลังจากนั้น chunked stream จะ keep-alive เองแล้ว
 */
function startKeepAlivePing(res: Response): () => void {
  // ส่ง HTTP header ก่อน (ทำให้ proxy รู้ว่า connection ยังมีชีวิต)
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Accel-Buffering", "no"); // ปิด nginx buffering

  // เขียน opening bracket ทันที — proxy จะเห็น byte แรกและไม่ตัด connection
  res.write('{"rows":[');

  // ส่ง ping comment ทุก 8 วินาที (ก่อน proxy timeout ที่ ~10s)
  // NOTE: เราเขียน '{}' เป็น placeholder row ไม่ได้ เพราะ client parse JSON
  // แต่เราสามารถ flush empty write เพื่อ keep TCP alive ได้
  const interval = setInterval(() => {
    if (!res.writableEnded) {
      // flush ทำให้ proxy รู้ว่า connection ยังมีชีวิต
      res.flushHeaders?.();
    } else {
      clearInterval(interval);
    }
  }, 8_000);

  return () => clearInterval(interval);
}

/**
 * Stream JSON response in chunks to keep the proxy connection alive.
 * Writes the opening `{"rows":[` immediately, then each row as a chunk,
 * then closes with metadata fields and `}`.
 * This way the first byte arrives within milliseconds even if computation takes 10+ seconds.
 */
async function streamJsonRows(
  res: Response,
  rows: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  meta: Record<string, unknown> = {},
  /** ถ้า true = startKeepAlivePing เขียน opening bracket ไว้แล้ว ไม่ต้องเขียนซ้ำ */
  hasOpeningBracket = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!hasOpeningBracket) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Accel-Buffering", "no"); // ปิด nginx buffering
      // Write opening immediately — keeps proxy alive
      res.write('{"rows":[');
    }

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
    // Cache hit — stream immediately
    const cached = getCachedTarget(section);
    if (cached) {
      console.log(`[debtStream] HIT target for ${section}`);
      await streamJsonRows(res, cached.rows);
      return;
    }

    // Cache miss — เริ่ม keep-alive ping ก่อน compute
    // (FF365 ใช้เวลา 30-60s — ต้องส่ง byte แรกก่อนเพื่อไม่ให้ proxy timeout)
    console.log(`[debtStream] MISS target for ${section}, computing...`);
    const stopPing = startKeepAlivePing(res);
    let result;
    try {
      result = await listDebtTarget({ section: section as SectionKey });
    } finally {
      stopPing();
    }
    setCachedTarget(section, result);
    // hasOpeningBracket=true — startKeepAlivePing เขียน '{"rows":[' ไว้แล้ว
    await streamJsonRows(res, result.rows, {}, true);
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
    // Cache hit — stream immediately
    const cached = getCachedCollected(section);
    if (cached) {
      console.log(`[debtStream] HIT collected for ${section}`);
      await streamJsonRows(res, cached.rows, {
        hasPrincipalBreakdown: cached.hasPrincipalBreakdown,
      });
      return;
    }

    // Cache miss — เริ่ม keep-alive ping ก่อน compute
    console.log(`[debtStream] MISS collected for ${section}, computing...`);
    const stopPing = startKeepAlivePing(res);
    let result;
    try {
      result = await listDebtCollected({ section: section as SectionKey });
    } finally {
      stopPing();
    }
    setCachedCollected(section, result);
    // hasOpeningBracket=true — startKeepAlivePing เขียน '{"rows":[' ไว้แล้ว
    await streamJsonRows(res, result.rows, {
      hasPrincipalBreakdown: result.hasPrincipalBreakdown,
    }, true);
  } catch (err) {
    console.error("[debtStream] collected error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.end();
    }
  }
}

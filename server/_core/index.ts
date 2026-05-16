import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import compression from "compression";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { seedSuperAdmin } from "../authDb";
import { handleContractsExport, handleDebtExport, handleBadDebtExport } from "../routers/exportExcel";
import { handleDebtStreamTarget, handleDebtStreamCollected, handleDebtCacheInvalidate } from "../routers/debtStream";
import { handleSyncStream } from "../routers/syncStream";
import { startScheduler } from "../sync/scheduler";
import { prewarmDebtCache } from "../debtPrewarm";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Phase 33: Enable gzip compression — reduces ~51MB JSON to ~5-8MB, fixes 503 timeout
  app.use(compression({ level: 6, threshold: 1024 }));
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // Excel export (streams large files so it's outside of tRPC)
  app.get("/api/export/contracts", handleContractsExport);
  app.get("/api/export/debt", handleDebtExport);
  app.get("/api/export/bad-debt", handleBadDebtExport);
  // Phase 33: Streaming debt data endpoints — bypass tRPC buffering to avoid proxy 503 timeout
  app.get("/api/debt/stream/target", handleDebtStreamTarget);
  app.get("/api/debt/stream/collected", handleDebtStreamCollected);
  // Phase 88: Cache invalidation endpoint — admin can force-clear server cache
  app.post("/api/debt/cache/invalidate", handleDebtCacheInvalidate);
  // SSE sync stream — keeps Cloud Run connection alive during long sync
  app.get("/api/sync-stream/:section", handleSyncStream);
  // Keep-alive ping — frontend polls this every 10s during sync to prevent Cloud Run idle scale-down
  app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));
  // Debug endpoint — test SQL query directly
  app.get("/api/debug/sql", async (req, res) => {
    try {
      const { getDb } = await import('../db');
      const { sql } = await import('drizzle-orm');
      const db = await getDb('Boonphone');
      if (!db) return res.status(500).json({ error: 'No DB' });
      const result = await db.execute(sql.raw(`SELECT LEFT(approve_date::text, 4) AS yr, COUNT(*) FROM contracts WHERE section = 'Boonphone' AND approve_date IS NOT NULL AND approve_date != '' GROUP BY 1 ORDER BY 1 DESC LIMIT 5`));
      const rows = (result as any).rows ?? result;
      return res.json({ ok: true, rows });
    } catch (err: any) {
      return res.status(500).json({ error: String(err?.message ?? err), cause: String(err?.cause?.message ?? '') });
    }
  });
  // Internal backfill endpoint — no auth, only for local/admin use
  app.post("/api/internal/backfill-cache", async (req, res) => {
    const { section } = req.body as { section?: string };
    if (!section || !['Boonphone', 'Fastfone365'].includes(section)) {
      return res.status(400).json({ error: 'Invalid section. Use Boonphone or Fastfone365' });
    }
    try {
      const { populateDebtCache } = await import('../sync/populateCache');
      const result = await populateDebtCache(section as any);
      return res.json({ ok: true, section, ...result });
    } catch (err: any) {
      console.error('[backfill]', err);
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Phase 42: ป้องกัน reverse proxy ตัด connection ก่อนเวลา
  // Cloud Run / nginx default keepAlive = 5s → ทำให้ FF365 (30s+ compute) timeout
  // ต้องตั้งก่อน server.listen เสมอ
  server.keepAliveTimeout = 120_000; // 120s — มากกว่า proxy timeout (~60s)
  server.headersTimeout = 125_000;   // ต้องมากกว่า keepAliveTimeout เสมอ
  server.requestTimeout = 300_000;   // 5 นาที — ป้องกัน request ค้างนาน

  server.listen(port, async () => {
    console.log(`Server running on http://localhost:${port}/`);
    try {
      await seedSuperAdmin();
    } catch (err) {
      console.error("[startup] seedSuperAdmin failed:", err);
    }
    try {
      await startScheduler();
    } catch (err) {
      console.error("[startup] startScheduler failed:", err);
    }
    // Self-ping every 10 minutes to prevent Render.com free tier from sleeping
    const selfPingUrl = `http://localhost:${port}/api/ping`;
    setInterval(() => {
      fetch(selfPingUrl).catch(() => { /* ignore errors */ });
    }, 10 * 60 * 1000);
    console.log("[keep-alive] Self-ping every 10 min started →", selfPingUrl);
    // Pre-warm debt cache in background (non-blocking, does not crash server on failure)
    prewarmDebtCache().catch((err) =>
      console.warn("[startup] prewarmDebtCache failed:", err)
    );
  });
}

startServer().catch(console.error);

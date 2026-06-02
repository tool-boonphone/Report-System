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
import { runStartupMigrations } from "../db";
import { handleContractsExport, handleDebtTargetExport, handleDebtCollectedExport, handleBadDebtExport, handleMonthlySummaryExport, handleYearlySummaryExport, handleBadDebtSummaryExport, handleIncomeExport, handleExpenseExport, handleMonthlyTargetDetailExport, handleMonthlyCollectedDetailExport, handleTargetSnapshotDetailExport } from "../routers/exportExcel";

import { handleSyncStream } from "../routers/syncStream";
import { startScheduler } from "../sync/scheduler";

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

  app.get("/api/export/debt-target", handleDebtTargetExport);
  app.get("/api/export/debt-collected", handleDebtCollectedExport);
  app.get("/api/export/bad-debt", handleBadDebtExport);
  app.get("/api/export/monthly-summary", handleMonthlySummaryExport);
  app.get("/api/export/yearly-summary", handleYearlySummaryExport);
  app.get("/api/export/bad-debt-summary", handleBadDebtSummaryExport);
  app.get("/api/export/income", handleIncomeExport);
  app.get("/api/export/expense", handleExpenseExport);
  // Monthly collection snapshot lightbox exports
  app.get("/api/export/monthly-target-detail", handleMonthlyTargetDetailExport);
  app.get("/api/export/monthly-collected-detail", handleMonthlyCollectedDetailExport);
  // Target Snapshot Lightbox export (freeze ณ วันที่ 1)
  app.get("/api/export/target-snapshot-detail", handleTargetSnapshotDetailExport);
  // Phase 33: Streaming debt data endpoints — bypass tRPC buffering to avoid proxy 503 timeout

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
  // Internal endpoint: Repopulate Monthly Summary cache (both monthly_summary_cache + monthly_summary_due_month_cache)
  // POST /api/internal/repopulate-monthly-summary
  // Body: { section: 'Boonphone' | 'Fastfone365', async?: boolean }
  // - async=true  → fire-and-forget, returns immediately with { started: true }
  // - async=false → awaits both caches, returns { ok: true, msRows, dmRows }
  app.post("/api/internal/repopulate-monthly-summary", async (req, res) => {
    const { section, async: isAsync = true } = req.body as { section?: string; async?: boolean };
    if (!section || !["Boonphone", "Fastfone365"].includes(section)) {
      return res.status(400).json({ error: "Invalid section. Use Boonphone or Fastfone365" });
    }
    try {
      const { populateMonthlySummaryCache, populateDueMonthCache } = await import("../monthlySummaryDb");
      const sec = section as import("../../shared/const").SectionKey;
      if (isAsync) {
        // Fire and forget — return immediately
        Promise.all([
          populateMonthlySummaryCache(sec),
          populateDueMonthCache(sec),
        ]).then(([msRows, dmRows]) => {
          console.log(`[repopulate-monthly-summary] ${sec} done — msRows=${msRows} dmRows=${dmRows}`);
        }).catch((err: unknown) => {
          console.error(`[repopulate-monthly-summary] ${sec} failed:`, (err as Error)?.message ?? err);
        });
        return res.json({ ok: true, section: sec, started: true, startedAt: new Date().toISOString() });
      } else {
        // Synchronous — await both caches
        const [msRows, dmRows] = await Promise.all([
          populateMonthlySummaryCache(sec),
          populateDueMonthCache(sec),
        ]);
        return res.json({
          ok: true,
          section: sec,
          msRows,
          dmRows,
          completedAt: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error("[repopulate-monthly-summary]", err);
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
  // Internal endpoint: Clear Monthly Summary cache (TRUNCATE both tables for a section)
  // POST /api/internal/clear-monthly-summary-cache
  // Body: { section: 'Boonphone' | 'Fastfone365' }
  app.post("/api/internal/clear-monthly-summary-cache", async (req, res) => {
    const { section } = req.body as { section?: string };
    if (!section || !["Boonphone", "Fastfone365"].includes(section)) {
      return res.status(400).json({ error: "Invalid section. Use Boonphone or Fastfone365" });
    }
    try {
      const { getDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const sec = section as import("../../shared/const").SectionKey;
      const db = await getDb(sec);
      if (!db) return res.status(500).json({ error: "DB not found" });
      await db.execute(sql.raw(`DELETE FROM monthly_summary_cache WHERE section = '${sec}'`));
      await db.execute(sql.raw(`DELETE FROM monthly_summary_due_month_cache WHERE section = '${sec}'`));
      console.log(`[clear-monthly-summary-cache] ${sec} — both tables cleared`);
      return res.json({ ok: true, section: sec, clearedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error("[clear-monthly-summary-cache]", err);
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
  // Internal endpoint: Auto-populate monthly_target_detail_snapshot (ตั้งหนี้เดือนนี้)
  // POST /api/internal/auto-snapshot
  // Body: { section: 'Boonphone' | 'Fastfone365', snapshotMonth?: 'YYYY-MM', async?: boolean }
  // - ใช้ snapshotMode='end_of_month' เสมอ (เหมือน Auto Snapshot วันที่ 1)
  // - async=true (default) → fire-and-forget, returns immediately
  app.post("/api/internal/auto-snapshot", async (req, res) => {
    const { section, snapshotMonth, async: isAsync = true } = req.body as {
      section?: string;
      snapshotMonth?: string;
      async?: boolean;
    };
    if (!section || !["Boonphone", "Fastfone365"].includes(section)) {
      return res.status(400).json({ error: "Invalid section. Use Boonphone or Fastfone365" });
    }
    try {
      const { populateTargetDetailSnapshot } = await import("../monthlyTargetDetailSnapshotDb");
      const sec = section as import("../../shared/const").SectionKey;
      // คำนวณ snapshotMonth ถ้าไม่ระบุ (ใช้เดือนปัจจุบัน Asia/Bangkok)
      const bangkokDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const month = snapshotMonth ?? bangkokDate.slice(0, 7); // YYYY-MM
      console.log(`[auto-snapshot] ${sec} ${month} (end_of_month) — triggered via API`);
      if (isAsync) {
        // Fire and forget — return immediately
        populateTargetDetailSnapshot(sec, month, "end_of_month", false, true)
          .then((rows) => console.log(`[auto-snapshot] ${sec} ${month} done — ${rows} rows inserted`))
          .catch((err: unknown) => console.error(`[auto-snapshot] ${sec} ${month} failed:`, (err as Error)?.message ?? err));
        return res.json({ ok: true, section: sec, snapshotMonth: month, snapshotMode: "end_of_month", started: true, startedAt: new Date().toISOString() });
      } else {
        // Synchronous — await and return result
        const rows = await populateTargetDetailSnapshot(sec, month, "end_of_month", false, true);
        return res.json({ ok: true, section: sec, snapshotMonth: month, snapshotMode: "end_of_month", rowsInserted: rows, completedAt: new Date().toISOString() });
      }
    } catch (err: any) {
      console.error("[auto-snapshot]", err);
      return res.status(500).json({ error: String(err?.message ?? err) });
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
      await runStartupMigrations();
    } catch (err) {
      console.error("[startup] runStartupMigrations failed:", err);
    }
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

  });
}

startServer().catch(console.error);

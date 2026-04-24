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
import { handleDebtStreamTarget, handleDebtStreamCollected } from "../routers/debtStream";
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
    // Pre-warm debt cache in background (non-blocking, does not crash server on failure)
    prewarmDebtCache().catch((err) =>
      console.warn("[startup] prewarmDebtCache failed:", err)
    );
  });
}

startServer().catch(console.error);

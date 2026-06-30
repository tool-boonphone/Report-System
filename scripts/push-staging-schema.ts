import { spawnSync } from "node:child_process";
import {
  loadStagingEnv,
  getSectionDatabases,
  maskDatabaseUrl,
} from "./stagingEnv";

const envFile = process.argv[2] ?? ".env.staging";
loadStagingEnv(envFile);

const databases = getSectionDatabases();

for (const { section, url } of databases) {
  console.log(
    `[staging] Pushing schema for ${section}: ${maskDatabaseUrl(url)}`
  );
  const result = spawnSync(
    "pnpm",
    ["exec", "drizzle-kit", "push", "--config", "drizzle.config.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: url,
      },
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("[staging] Schema push completed.");

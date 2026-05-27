import { buildClientFromEnv } from "./server/api/partnerClient";
import { runStartupMigrations } from "./server/db";

async function main() {
  await runStartupMigrations();
  console.log("Migrations done");
}

main().catch(console.error);

/**
 * scripts/test-populate.ts — ทดสอบ populateDebtCache เพื่อดู error จริง
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });

import { populateDebtCache } from "../server/sync/populateCache";
import { invalidateDebtCache } from "../server/debtCache";

async function main() {
  const SECTION = "Boonphone" as const;
  console.log("=== Test populateDebtCache ===");
  console.log(`DATABASE_URL: ${process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ":***@")}`);

  try {
    invalidateDebtCache(SECTION);
    const result = await populateDebtCache(SECTION);
    console.log(`SUCCESS: ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.error(`ERROR: ${err?.message}`);
    const cause = err?.cause;
    if (cause) {
      console.error(`CAUSE: ${cause?.message ?? cause}`);
      console.error(`CAUSE stack: ${cause?.stack?.split("\n").slice(0, 5).join("\n")}`);
    }
    console.error(`STACK: ${err?.stack?.split("\n").slice(0, 10).join("\n")}`);
  }
}

main().catch(console.error);

import { buildClientFromEnv } from "./server/api/partnerClient";
import { getDb } from "./server/db";
import { contracts } from "./drizzle/schema";
import { eq, and } from "drizzle-orm";

async function main() {
  const section = "Boonphone";
  const client = buildClientFromEnv(section);
  if (!client) throw new Error("No client");

  const db = await getDb(section);
  if (!db) throw new Error("No DB");

  // Get 1 contract
  const rows = await db.select({ externalId: contracts.externalId }).from(contracts).where(eq(contracts.section, section)).limit(1);
  if (rows.length === 0) return console.log("No contracts");
  const contractId = rows[0].externalId;

  console.log("Testing contract:", contractId);
  
  const data: any = await client.get("contract", { action: "detail", id: contractId });
  const product = data?.contract?.product ?? {};
  const imei = product.imei ?? null;
  const serialNo = product.serial_no ?? null;
  
  console.log("Result:", { imei, serialNo });
}

main().catch(console.error);

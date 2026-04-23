/**
 * Fetch fresh installments for contract_external_id=1239 from Boonphone API
 * Run with: npx tsx scripts/fetch-contract-1239.ts
 */
import { buildClientFromEnv } from "../server/api/partnerClient";

async function main() {
  const client = buildClientFromEnv("Boonphone");
  if (!client || !client.isConfigured()) {
    console.log("Boonphone client not configured");
    process.exit(1);
  }

  console.log("Fetching installments for contract_id=1239 from Boonphone API...\n");

  // Try the installments endpoint with id param
  try {
    const data = await client.get<any>("contract", { action: "installments", id: 1239 });
    console.log("=== API Response (action=installments, id=1239) ===");
    const installments = data?.installments ?? data;
    if (Array.isArray(installments)) {
      for (const inst of installments) {
        console.log(`  installment_no=${inst.installment_no} due_date=${inst.due_date} status=${inst.installment_status_code}`);
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (e: any) {
    console.log("Error with installments:", e.message);
  }

  // Also try fetching the contract detail
  try {
    const data = await client.get<any>("contract", { action: "detail", id: 1239 });
    console.log("\n=== API Response (action=detail, id=1239) ===");
    console.log(JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.log("Error with detail:", e.message);
  }
}

main().catch(console.error);

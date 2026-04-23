/**
 * Fetch fresh installments for contract_external_id=1239 from Boonphone API
 * to verify the current state of the data at the source.
 */
import { buildClientFromEnv } from "../server/api/partnerClient.js";

const client = buildClientFromEnv("Boonphone");
if (!client || !client.isConfigured()) {
  console.log("Boonphone client not configured");
  process.exit(1);
}

console.log("Fetching installments for contract_id=1239 from Boonphone API...\n");

// Try the installments endpoint with id param
try {
  const data = await client.get("contract", { action: "installments", id: 1239 });
  console.log("=== API Response (action=installments, id=1239) ===");
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.log("Error with id param:", e.message);
}

// Also try fetching the contract detail
try {
  const data = await client.get("contract", { action: "detail", id: 1239 });
  console.log("\n=== API Response (action=detail, id=1239) ===");
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.log("Error with detail:", e.message);
}

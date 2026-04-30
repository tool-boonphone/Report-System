/**
 * ดึง contract?action=detail&id=1064 (CT0226-RBR002-1015-01)
 * Usage: npx tsx scripts/checkBpContract1064.ts
 */
import { buildClientFromEnv } from "../server/api/partnerClient";

async function main() {
  const client = buildClientFromEnv("Boonphone");
  if (!client) { console.log("No client"); process.exit(1); }

  await client.login();
  console.log("Login OK");

  const detail = await client.get<any>("contract", { action: "detail", id: 1064 });
  const c = detail?.contract;
  if (!c) { console.log("No contract data"); process.exit(1); }

  // installments
  console.log("\n=== Installments ===");
  if (c.installments?.length) {
    console.log("Keys of first installment:", Object.keys(c.installments[0]));
    for (const inst of c.installments) {
      console.log(JSON.stringify(inst));
    }
  }

  // payments
  console.log("\n=== Payments ===");
  if (c.payments?.length) {
    console.log("Keys of first payment:", Object.keys(c.payments[0]));
    for (const p of c.payments) {
      console.log(JSON.stringify(p));
    }
  } else {
    console.log("No payments in detail");
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

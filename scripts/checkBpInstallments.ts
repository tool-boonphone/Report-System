/**
 * ตรวจสอบว่า Boonphone contract?action=installments ส่ง updated_by มาไหม
 * Usage: npx tsx scripts/checkBpInstallments.ts
 */
import { buildClientFromEnv } from "../server/api/partnerClient";

async function main() {
  const client = buildClientFromEnv("Boonphone");
  if (!client) { console.log("No client"); process.exit(1); }

  await client.login();
  console.log("Login OK");

  let sample: any = null;
  let stopped = false;
  try {
    await client.forEachPage<any>(
      "contract",
      (d: any) => d?.installments,
      { action: "installments" },
      async (items: any[]) => {
        if (!stopped && items.length > 0) {
          sample = items[0];
          stopped = true;
          throw new Error("__STOP__");
        }
      },
      10,
    );
  } catch (e: any) {
    if (e?.message !== "__STOP__") throw e;
  }

  if (sample) {
    console.log("\nBulk installments endpoint keys:", Object.keys(sample));
    console.log("updated_by:", sample.updated_by);
    console.log("updated_at:", sample.updated_at);
    console.log("Sample:", JSON.stringify(sample, null, 2));
  } else {
    console.log("No installment rows found");
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * One-shot script: ตรวจสอบว่า Boonphone payment API ส่ง updated_by มาไหม
 * Usage: npx tsx scripts/checkBpPayment.ts
 */
import { buildClientFromEnv } from "../server/api/partnerClient";

async function main() {
  const client = buildClientFromEnv("Boonphone");
  if (!client) {
    console.log("No Boonphone client — check env vars");
    process.exit(1);
  }

  await client.login();
  console.log("Login OK");

  let sample: any = null;
  let stopped = false;
  try {
    await client.forEachPage<any>(
      "payment",
      (d: any) => d?.transactions,
      { action: "transactions" },
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
    console.log("Payment keys:", Object.keys(sample));
    console.log("updated_by field:", sample.updated_by);
    console.log("updated_at field:", sample.updated_at);
    console.log("Full sample:", JSON.stringify(sample, null, 2));
  } else {
    console.log("No payment rows found");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

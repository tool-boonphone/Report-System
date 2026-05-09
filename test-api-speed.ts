import "dotenv/config";
import { PartnerClient } from "./server/api/partnerClient";

const client = new PartnerClient({
  baseUrl: process.env.FASTFONE_API_URL!,
  username: process.env.FASTFONE_API_USERNAME!,
  password: process.env.FASTFONE_API_PASSWORD!,
});

// ทดสอบ 5 requests แบบ sequential
const testIds = ["1000", "2000", "3000", "4000", "5000"];
const start = Date.now();
for (const id of testIds) {
  const t0 = Date.now();
  try {
    const data: any = await client.get("contract", { action: "detail", id });
    const imei = data?.contract?.product?.imei ?? "null";
    console.log(`  id=${id} imei=${imei} time=${Date.now()-t0}ms`);
  } catch(e: any) {
    console.log(`  id=${id} ERROR: ${e.message} time=${Date.now()-t0}ms`);
  }
}
console.log(`Total: ${Date.now()-start}ms for 5 requests`);
console.log(`Avg: ${Math.round((Date.now()-start)/5)}ms per request`);
console.log(`\nEstimate for 1067 missing IMEI @ CONCURRENCY=5:`);
const avgMs = (Date.now()-start)/5;
const estimateSec = Math.round((1067 / 5) * avgMs / 1000);
console.log(`  ~${Math.round(estimateSec/60)} minutes`);

/**
 * testCacheStream.ts — Test streamTargetFromCache and streamCollectedFromCache
 * Usage: npx tsx scripts/testCacheStream.ts
 */
import { streamTargetFromCache, streamCollectedFromCache } from "../server/sync/queryCacheDb";

async function main() {
  const sections = ["Boonphone", "Fastfone365"] as const;

  for (const section of sections) {
    console.log(`\n=== Testing streamTargetFromCache for ${section} ===`);
    const start = Date.now();
    let totalRows = 0;
    let firstRow: any = null;
    for await (const batch of streamTargetFromCache({ section, batchSize: 200 })) {
      totalRows += batch.length;
      if (!firstRow && batch.length > 0) firstRow = batch[0];
    }
    const elapsed = Date.now() - start;
    console.log(`  Total contracts: ${totalRows}, elapsed: ${elapsed}ms`);
    if (firstRow) {
      console.log(`  Sample row keys: ${Object.keys(firstRow).join(", ")}`);
      console.log(`  Sample: contractNo=${firstRow.contractNo}, debtStatus=${firstRow.debtStatus}, daysOverdue=${firstRow.daysOverdue}, phone=${firstRow.phone}`);
      console.log(`  Installments count: ${firstRow.installments?.length ?? 0}`);
      if (firstRow.installments?.length > 0) {
        const inst = firstRow.installments[0];
        console.log(`  First installment keys: ${Object.keys(inst).join(", ")}`);
      }
    }
  }

  for (const section of sections) {
    console.log(`\n=== Testing streamCollectedFromCache for ${section} ===`);
    const start = Date.now();
    let totalRows = 0;
    let firstRow: any = null;
    for await (const chunk of streamCollectedFromCache({ section, batchSize: 200 })) {
      totalRows += chunk.rows.length;
      if (!firstRow && chunk.rows.length > 0) firstRow = chunk.rows[0];
    }
    const elapsed = Date.now() - start;
    console.log(`  Total contracts: ${totalRows}, elapsed: ${elapsed}ms`);
    if (firstRow) {
      console.log(`  Sample row keys: ${Object.keys(firstRow).join(", ")}`);
      console.log(`  Payments count: ${firstRow.payments?.length ?? 0}`);
      if (firstRow.payments?.length > 0) {
        const pay = firstRow.payments[0];
        console.log(`  First payment keys: ${Object.keys(pay).join(", ")}`);
      }
    }
  }

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

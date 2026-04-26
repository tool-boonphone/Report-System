/**
 * test-baddebt2.ts - ตรวจสอบ bad debt payment records
 */
import "dotenv/config";
import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  const drizzle = await getDb();

  // ทดสอบ execute return type
  const testResult = await drizzle.execute(sql`SELECT 1 AS test`);
  console.log("execute return type:", typeof testResult);
  console.log("execute keys:", Object.keys(testResult as any));
  // mysql2 drizzle returns [rows, fields] array
  const rows0 = Array.isArray(testResult) ? testResult[0] : (testResult as any).rows ?? testResult;
  console.log("rows sample:", JSON.stringify(rows0).slice(0, 100));

  // หาสัญญา Boonphone ที่มี bad_debt_amount > 0
  const result = await drizzle.execute(sql`
    SELECT DISTINCT
      c.external_id,
      c.contract_no,
      c.status,
      c.installment_count,
      c.installment_amount
    FROM contracts c
    JOIN payment_transactions p ON p.contract_external_id = c.external_id AND p.section = c.section
    WHERE c.section = 'Boonphone'
      AND JSON_EXTRACT(p.raw_json, '$.bad_debt_amount') > 0
    LIMIT 10
  `);

  const contracts = Array.isArray(result) ? result[0] as any[] : (result as any).rows ?? result as any[];
  console.log(`\nFound ${contracts.length} Boonphone contracts with bad_debt_amount > 0`);

  for (const c of contracts.slice(0, 5)) {
    console.log(`\n--- Contract: ${c.contract_no} (external_id: ${c.external_id}) ---`);
    console.log(`  Status: ${c.status}, Total periods: ${c.installment_count}, Installment: ${c.installment_amount}`);

    const pResult = await drizzle.execute(sql`
      SELECT
        JSON_EXTRACT(p.raw_json, '$.receipt_no') AS receipt_no,
        JSON_EXTRACT(p.raw_json, '$.paid_at') AS paid_at,
        JSON_EXTRACT(p.raw_json, '$.principal_paid') AS principal_paid,
        JSON_EXTRACT(p.raw_json, '$.interest_paid') AS interest_paid,
        JSON_EXTRACT(p.raw_json, '$.fee_paid') AS fee_paid,
        JSON_EXTRACT(p.raw_json, '$.bad_debt_amount') AS bad_debt_amount,
        JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS close_installment_amount,
        JSON_EXTRACT(p.raw_json, '$.overpaid_amount') AS overpaid_amount
      FROM payment_transactions p
      WHERE p.contract_external_id = ${c.external_id}
        AND p.section = 'Boonphone'
      ORDER BY JSON_EXTRACT(p.raw_json, '$.paid_at') ASC
    `);

    const payments = Array.isArray(pResult) ? pResult[0] as any[] : (pResult as any).rows ?? pResult as any[];
    console.log(`  Payments (${payments.length} records):`);
    for (const p of payments) {
      const badDebt = Number(p.bad_debt_amount ?? 0);
      const closeAmt = Number(p.close_installment_amount ?? 0);
      const overpaid = Number(p.overpaid_amount ?? 0);
      const marker = badDebt > 0 ? " ← BAD DEBT ★" : closeAmt > 0 ? " ← CLOSE" : overpaid > 0 ? " ← OVERPAID" : "";
      console.log(
        `    receipt=${p.receipt_no}, paid_at=${p.paid_at}, ` +
        `principal=${p.principal_paid}, interest=${p.interest_paid}, fee=${p.fee_paid}, ` +
        `bad_debt=${p.bad_debt_amount}, close=${p.close_installment_amount}, overpaid=${p.overpaid_amount}${marker}`
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

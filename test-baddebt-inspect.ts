/**
 * test-baddebt-inspect.ts
 * ตรวจสอบว่าสัญญาที่เป็นหนี้เสีย มี payment record ที่ bad_debt_amount > 0 ที่งวดไหน
 * และ receipt_no pattern เป็นอย่างไร
 */
import "dotenv/config";
import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== Inspecting Bad Debt Payment Records ===\n");

  const drizzle = await getDb();

  // 1. หาสัญญาที่เป็นหนี้เสีย (มี bad_debt_amount > 0 ใน payments) - Boonphone
  const badDebtContracts = await drizzle.execute(sql`
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

  console.log(`Found ${badDebtContracts.rows.length} Boonphone contracts with bad_debt_amount > 0\n`);

  for (const contract of badDebtContracts.rows.slice(0, 5)) {
    const c = contract as any;
    console.log(`\n--- Contract: ${c.contract_no} (external_id: ${c.external_id}) ---`);
    console.log(`  Status: ${c.status}, Total periods: ${c.installment_count}, Installment: ${c.installment_amount}`);

    // ดู payment records ทั้งหมดของสัญญานี้
    const payments = await drizzle.execute(sql`
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

    console.log(`  Payments (${payments.rows.length} records):`);
    for (const p of payments.rows as any[]) {
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

  // 2. ตรวจสอบ Fastfone365 ด้วย
  console.log("\n\n=== Fastfone365 Bad Debt Contracts ===\n");
  const ffBadDebt = await drizzle.execute(sql`
    SELECT DISTINCT
      c.external_id,
      c.contract_no,
      c.status,
      c.installment_count,
      c.installment_amount
    FROM contracts c
    JOIN payment_transactions p ON p.contract_external_id = c.external_id AND p.section = c.section
    WHERE c.section = 'Fastfone365'
      AND JSON_EXTRACT(p.raw_json, '$.bad_debt_amount') > 0
    LIMIT 5
  `);

  console.log(`Found ${ffBadDebt.rows.length} Fastfone365 contracts with bad_debt_amount > 0`);

  for (const contract of ffBadDebt.rows.slice(0, 3)) {
    const c = contract as any;
    console.log(`\n--- Contract: ${c.contract_no} (external_id: ${c.external_id}) ---`);
    console.log(`  Status: ${c.status}, Total periods: ${c.installment_count}`);

    const payments = await drizzle.execute(sql`
      SELECT
        JSON_EXTRACT(p.raw_json, '$.receipt_no') AS receipt_no,
        JSON_EXTRACT(p.raw_json, '$.paid_at') AS paid_at,
        JSON_EXTRACT(p.raw_json, '$.bad_debt_amount') AS bad_debt_amount,
        JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS close_installment_amount
      FROM payment_transactions p
      WHERE p.contract_external_id = ${c.external_id}
        AND p.section = 'Fastfone365'
      ORDER BY JSON_EXTRACT(p.raw_json, '$.paid_at') ASC
    `);

    for (const p of payments.rows as any[]) {
      const badDebt = Number(p.bad_debt_amount ?? 0);
      const marker = badDebt > 0 ? " ← BAD DEBT ★" : "";
      console.log(`    receipt=${p.receipt_no}, paid_at=${p.paid_at}, bad_debt=${p.bad_debt_amount}${marker}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

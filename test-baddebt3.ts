/**
 * test-baddebt3.ts - ตรวจสอบ bad debt payment data structure
 */
import "dotenv/config";
import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  const drizzle = await getDb();

  // 1. ดูสัญญาหนี้เสียตัวอย่าง
  const r1 = await drizzle.execute(sql`
    SELECT external_id, contract_no, status, section FROM contracts 
    WHERE status = 'หนี้เสีย' LIMIT 5
  `);
  const contracts = (r1 as any)[0] as any[];
  console.log("Bad debt contracts:", contracts.map((c) => `${c.section}:${c.external_id} ${c.contract_no}`));

  // 2. ดู payment_transactions ของสัญญาหนี้เสียแรก
  if (contracts.length > 0) {
    const fc = contracts[0];
    const r2 = await drizzle.execute(sql`
      SELECT COUNT(*) AS cnt FROM payment_transactions 
      WHERE contract_external_id = ${fc.external_id} AND section = ${fc.section}
    `);
    console.log(`\nPayments for ${fc.external_id} (${fc.section}):`, (r2 as any)[0][0].cnt);

    // ดู sample payment
    const r3 = await drizzle.execute(sql`
      SELECT 
        JSON_EXTRACT(raw_json, '$.receipt_no') AS receipt_no,
        JSON_EXTRACT(raw_json, '$.payment_date') AS payment_date,
        JSON_EXTRACT(raw_json, '$.principal_paid') AS principal_paid,
        JSON_EXTRACT(raw_json, '$.interest_paid') AS interest_paid,
        JSON_EXTRACT(raw_json, '$.fee_paid') AS fee_paid,
        JSON_EXTRACT(raw_json, '$.bad_debt_amount') AS bad_debt_amount,
        JSON_EXTRACT(raw_json, '$.close_installment_amount') AS close_installment_amount,
        JSON_EXTRACT(raw_json, '$.total_paid_amount') AS total_paid_amount
      FROM payment_transactions
      WHERE contract_external_id = ${fc.external_id} AND section = ${fc.section}
      ORDER BY JSON_EXTRACT(raw_json, '$.payment_date') ASC
    `);
    const payments = (r3 as any)[0] as any[];
    console.log(`Payments detail (${payments.length} rows):`);
    for (const p of payments) {
      const bd = Number(p.bad_debt_amount ?? 0);
      const cl = Number(p.close_installment_amount ?? 0);
      const marker = bd > 0 ? " ← BAD DEBT ★" : cl > 0 ? " ← CLOSE" : "";
      console.log(`  receipt=${p.receipt_no}, date=${p.payment_date}, principal=${p.principal_paid}, interest=${p.interest_paid}, bad_debt=${p.bad_debt_amount}, close=${p.close_installment_amount}${marker}`);
    }
  }

  // 3. ดู contract_external_id ที่มีใน payment_transactions
  const r4 = await drizzle.execute(sql`
    SELECT DISTINCT contract_external_id, section 
    FROM payment_transactions 
    WHERE section = 'Boonphone' 
    ORDER BY contract_external_id DESC
    LIMIT 10
  `);
  console.log("\nSample contract_external_ids in payment_transactions:", (r4 as any)[0].map((r: any) => r.contract_external_id));

  // 4. ตรวจสอบ bad_debt_amount ที่มีค่า > 0
  const r5 = await drizzle.execute(sql`
    SELECT 
      section,
      contract_no,
      JSON_EXTRACT(raw_json, '$.receipt_no') AS receipt_no,
      JSON_EXTRACT(raw_json, '$.bad_debt_amount') AS bad_debt_amount,
      JSON_EXTRACT(raw_json, '$.close_installment_amount') AS close_installment_amount
    FROM payment_transactions
    WHERE JSON_EXTRACT(raw_json, '$.bad_debt_amount') > 0
    LIMIT 10
  `);
  console.log("\nPayments with bad_debt_amount > 0:", (r5 as any)[0].length);
  for (const p of (r5 as any)[0] as any[]) {
    console.log(`  ${p.section}:${p.contract_no} receipt=${p.receipt_no} bad_debt=${p.bad_debt_amount}`);
  }

  // 5. ตรวจสอบ close_installment_amount ที่มีค่า > 0 สำหรับสัญญาหนี้เสีย
  const r6 = await drizzle.execute(sql`
    SELECT 
      p.section,
      p.contract_no,
      c.status,
      JSON_EXTRACT(p.raw_json, '$.receipt_no') AS receipt_no,
      JSON_EXTRACT(p.raw_json, '$.bad_debt_amount') AS bad_debt_amount,
      JSON_EXTRACT(p.raw_json, '$.close_installment_amount') AS close_installment_amount,
      JSON_EXTRACT(p.raw_json, '$.payment_date') AS payment_date
    FROM payment_transactions p
    JOIN contracts c ON c.external_id = p.contract_external_id AND c.section = p.section
    WHERE c.status = 'หนี้เสีย'
      AND JSON_EXTRACT(p.raw_json, '$.close_installment_amount') > 0
    LIMIT 10
  `);
  console.log("\nBad debt contracts with close_installment_amount > 0:", (r6 as any)[0].length);
  for (const p of (r6 as any)[0] as any[]) {
    console.log(`  ${p.section}:${p.contract_no} receipt=${p.receipt_no} close=${p.close_installment_amount} bad_debt=${p.bad_debt_amount}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

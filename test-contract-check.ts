import "dotenv/config";
import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  const drizzle = await getDb();

  const r1 = await drizzle.execute(sql`
    SELECT external_id, contract_no, status, section, installment_count, installment_amount
    FROM contracts 
    WHERE contract_no = 'CT0126-AYA001-20952-01'
    LIMIT 1
  `);
  const contracts = (r1 as any)[0] as any[];
  if (contracts.length === 0) {
    console.log("ไม่พบสัญญา CT0126-AYA001-20952-01");
    process.exit(0);
  }
  const c = contracts[0];
  console.log(`Contract: ${c.contract_no}`);
  console.log(`  section: ${c.section}, external_id: ${c.external_id}`);
  console.log(`  status: ${c.status}, installment_count: ${c.installment_count}, installment_amount: ${c.installment_amount}`);

  const r3 = await drizzle.execute(sql`
    SELECT 
      JSON_EXTRACT(raw_json, '$.receipt_no') AS receipt_no,
      JSON_EXTRACT(raw_json, '$.payment_date') AS payment_date,
      JSON_EXTRACT(raw_json, '$.principal_paid') AS principal_paid,
      JSON_EXTRACT(raw_json, '$.interest_paid') AS interest_paid,
      JSON_EXTRACT(raw_json, '$.fee_paid') AS fee_paid,
      JSON_EXTRACT(raw_json, '$.bad_debt_amount') AS bad_debt_amount,
      JSON_EXTRACT(raw_json, '$.close_installment_amount') AS close_installment_amount,
      JSON_EXTRACT(raw_json, '$.overpaid_amount') AS overpaid_amount,
      JSON_EXTRACT(raw_json, '$.total_paid_amount') AS total_paid_amount
    FROM payment_transactions
    WHERE contract_external_id = ${c.external_id} AND section = ${c.section}
    ORDER BY JSON_EXTRACT(raw_json, '$.payment_date') ASC
  `);
  const payments = (r3 as any)[0] as any[];
  console.log(`\nPayments (${payments.length} records):`);
  for (const p of payments) {
    const cl = Number(p.close_installment_amount ?? 0);
    const marker = cl > 0 ? " ← ขายเครื่อง ★" : "";
    console.log(
      `  receipt=${p.receipt_no}, date=${p.payment_date}, ` +
      `principal=${p.principal_paid}, interest=${p.interest_paid}, ` +
      `close=${p.close_installment_amount}, total=${p.total_paid_amount}${marker}`
    );
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

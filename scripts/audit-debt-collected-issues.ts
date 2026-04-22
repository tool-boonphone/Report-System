/**
 * Audit three contracts reported by user (2026-04-23) for the
 * "ยอดเก็บหนี้" (listDebtCollected) view:
 *
 *   - มณีรัตน์ ช่วยบำรุง   : 1,000 baht partial payment wrongly labeled "ปิดค่างวด"
 *   - สุวิทย์ เทศเขียว      : close-out booked across all periods except period 11
 *   - เอกลักษณ์ ดวงกำ     : close-out booked only on period 12
 *
 * Goal: dump each contract's payment rows (receipt_no, amount, paid_at,
 * plus discount / penalty fields pulled from raw_json) so we can see
 * what discriminates "partial payment" vs "close-contract receipt" and
 * why close-out is booked on different installments.
 */
import mysql from "mysql2/promise";
import "dotenv/config";

const db = await mysql.createConnection(process.env.DATABASE_URL!);

const names = ["มณีรัตน์ ช่วยบำรุง", "สุวิทย์ เทศเขียว", "เอกลักษณ์ ดวงกำ"];

for (const name of names) {
  const [contracts] = await db.query<any[]>(
    `SELECT external_id, contract_no, customer_name, status, installment_count,
            installment_amount
       FROM contracts
      WHERE customer_name LIKE ?
      LIMIT 3`,
    [`%${name}%`],
  );
  console.log(`\n================ ${name} ================`);
  if (contracts.length === 0) {
    console.log("(no contract found)");
    continue;
  }
  for (const c of contracts) {
    console.log("\n--- contract:", c);

    // Payments
    const [pays] = await db.query<any[]>(
      `SELECT
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no'))        AS receipt_no,
         paid_at,
         amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.overpaid_amount'))   AS overpaid_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.discount_amount'))   AS discount_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.penalty_amount'))    AS penalty_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.unlock_fee_amount')) AS unlock_fee_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.principal_amount'))  AS principal_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.interest_amount'))   AS interest_amount,
         JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fee_amount'))        AS fee_amount
       FROM payment_transactions
      WHERE contract_external_id = ?
      ORDER BY paid_at, receipt_no`,
      [c.external_id],
    );
    console.log(`payments (${pays.length}):`);
    for (const p of pays) console.log("  ", p);

    // Installments summary
    const [insts] = await db.query<any[]>(
      `SELECT period, due_date,
              JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.installment_status_code')) AS status,
              JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.total_paid_amount'))       AS paid,
              amount
         FROM installments
        WHERE contract_external_id = ?
        ORDER BY period`,
      [c.external_id],
    );
    console.log(`installments (${insts.length}):`);
    for (const i of insts) console.log("  ", i);
  }
}

await db.end();

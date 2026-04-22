/**
 * Audit TXRTC receipt distribution across contracts to decide how
 * assignPayPeriods should route close-contract payments to periods.
 *
 * Contracts of interest (reported by user 2026-04-23):
 *   - เอกลักษณ์ ดวงกำ    (งวด 2-11 ว่าง, close บันทึกเฉพาะงวด 12)
 *   - สุวิทย์ เทศเขียว   (ทุกงวดยกเว้นงวด 11 มีบันทึก)
 *   - มณีรัตน์ ช่วยบำรุง (reference for partial payment)
 *
 * Usage: pnpm tsx scripts/audit-txrtc-distribution.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  contracts,
  installments,
  paymentTransactions,
} from "../drizzle/schema";

const targets = [
  "เอกลักษณ์ ดวงกำ",
  "สุวิทย์ เทศเขียว",
  "มณีรัตน์ ช่วยบำรุง",
];

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("No DB");
    return;
  }

  for (const name of targets) {
    console.log("\n" + "=".repeat(80));
    console.log("CONTRACT for customer:", name);

    // Find matching contract(s) by customer full name via raw_json.
    const q = await db.execute(sql`
      SELECT external_id, section,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.customer_name'))   AS cust,
             JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.contract_status')) AS status
        FROM ${contracts}
       WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.customer_name')) LIKE ${`%${name}%`}
       ORDER BY external_id
    `);
    const rows: any[] = (q as any)[0] ?? q;
    if (!rows.length) {
      console.log("   (no contract found)");
      continue;
    }
    for (const c of rows) {
      console.log(
        `\n  → external_id=${c.external_id}  section=${c.section}  periods=${c.periods}  status=${c.status}`,
      );

      // Dump scheduled installments.
      const iq = await db.execute(sql`
        SELECT period, due_date,
               CAST(amount AS DECIMAL(18,2)) AS amount
          FROM ${installments}
         WHERE contract_external_id = ${c.external_id}
         ORDER BY period
      `);
      const iRows: any[] = (iq as any)[0] ?? iq;
      console.log(`    Installments (${iRows.length}):`);
      for (const i of iRows) {
        console.log(
          `      #${String(i.period).padStart(2)} due=${i.due_date} amt=${i.amount}`,
        );
      }

      // Dump payments ordered by paid_at.
      const pq = await db.execute(sql`
        SELECT paid_at,
               CAST(amount AS DECIMAL(18,2)) AS amt,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS rcpt,
               CAST(JSON_EXTRACT(raw_json, '$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
               CAST(JSON_EXTRACT(raw_json, '$.principal_paid') AS DECIMAL(18,2)) AS prin,
               CAST(JSON_EXTRACT(raw_json, '$.interest_paid') AS DECIMAL(18,2)) AS intr,
               CAST(JSON_EXTRACT(raw_json, '$.fee_paid') AS DECIMAL(18,2)) AS fee,
               CAST(JSON_EXTRACT(raw_json, '$.discount_amount') AS DECIMAL(18,2)) AS disc,
               CAST(JSON_EXTRACT(raw_json, '$.overpaid_amount') AS DECIMAL(18,2)) AS over,
               CAST(JSON_EXTRACT(raw_json, '$.payment_id') AS UNSIGNED) AS pid
          FROM ${paymentTransactions}
         WHERE contract_external_id = ${c.external_id}
         ORDER BY paid_at, pid
      `);
      const pRows: any[] = (pq as any)[0] ?? pq;
      console.log(`    Payments (${pRows.length}):`);
      for (const p of pRows) {
        const rcpt = String(p.rcpt ?? "");
        const tag = rcpt.startsWith("TXRTC") ? "⛔CLOSE" : rcpt.startsWith("TXRT") ? "  pay  " : "  ???  ";
        console.log(
          `      ${tag} ${p.paid_at}  rcpt=${rcpt}  amt=${p.amt}  P+I+F=${Number(p.prin ?? 0) + Number(p.intr ?? 0) + Number(p.fee ?? 0)}  close=${p.close_amt}  disc=${p.disc}  over=${p.over}  pid=${p.pid}`,
        );
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

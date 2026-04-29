/**
 * หาสัญญา "สิ้นสุดสัญญา" Fastfone365
 * ที่งวดสุดท้ายมียอดชำระเกินจากค่างวดจริง
 * โดยใช้เฉพาะ INST_BASE rows (amount > 0) ต่องวด
 */
import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // ก่อนอื่น ดูว่า external_id format ของ INST_BASE vs TXRT ต่างกันอย่างไร
  const sampleRows = await db.execute(sql`
    SELECT 
      i.external_id,
      i.contract_no,
      i.period,
      CAST(i.amount AS DECIMAL(18,2)) AS amount,
      CAST(i.paid_amount AS DECIMAL(18,2)) AS paid_amount,
      JSON_EXTRACT(i.raw_json, '$.paid') AS raw_paid,
      JSON_EXTRACT(i.raw_json, '$.total_paid_amount') AS raw_total_paid,
      JSON_EXTRACT(i.raw_json, '$.balance') AS raw_balance
    FROM installments i
    WHERE i.section = 'Fastfone365'
      AND i.contract_no = 'CT0125-SNI003-7429-01'
    ORDER BY i.period, CAST(i.amount AS DECIMAL(18,2)) DESC
  `);
  const sampleData = (sampleRows as any)[0] ?? sampleRows;
  console.log("=== ตัวอย่าง installments rows ของ CT0125-SNI003-7429-01 ===");
  for (const r of sampleData) {
    console.log(`  ext=${r.external_id} period=${r.period} amount=${r.amount} paid=${r.paid_amount} raw_paid=${r.raw_paid} raw_total_paid=${r.raw_total_paid} raw_balance=${r.raw_balance}`);
  }

  // INST_BASE = rows ที่มี raw_json.paid มีค่า (ไม่ใช่ null)
  // TXRT = rows ที่มี raw_json.total_paid_amount มีค่า
  // เลือกเฉพาะ INST_BASE: JSON_EXTRACT(raw_json, '$.paid') IS NOT NULL
  // หรือ amount > 0 AND external_id ไม่ใช่ตัวเลขล้วน (TXRT ext เป็นตัวเลขล้วน เช่น 72665)
  
  console.log("\n=== หาสัญญา สิ้นสุดสัญญา Fastfone365 ที่งวดสุดท้ายชำระเกิน (INST_BASE only) ===\n");

  // Strategy: เลือก INST_BASE = rows ที่ JSON_EXTRACT(raw_json, '$.paid') IS NOT NULL
  // (INST_BASE มี paid field, TXRT มี total_paid_amount field)
  const rows = await db.execute(sql`
    WITH inst_base AS (
      -- เลือกเฉพาะ INST_BASE rows (มี raw_json.paid)
      SELECT 
        i.contract_external_id,
        i.contract_no,
        i.period,
        i.due_date,
        CAST(i.amount AS DECIMAL(18,2)) AS amount,
        CAST(i.paid_amount AS DECIMAL(18,2)) AS paid_amount
      FROM installments i
      WHERE i.section = 'Fastfone365'
        AND JSON_EXTRACT(i.raw_json, '$.paid') IS NOT NULL
    ),
    last_period AS (
      -- งวดสุดท้ายของแต่ละสัญญา
      SELECT contract_external_id, MAX(period) AS max_period
      FROM inst_base
      GROUP BY contract_external_id
    ),
    closed_contracts AS (
      SELECT external_id, customer_name, phone
      FROM contracts
      WHERE section = 'Fastfone365'
        AND status = 'สิ้นสุดสัญญา'
    )
    SELECT 
      ib.contract_no,
      cc.customer_name,
      cc.phone,
      ib.period AS last_period,
      ib.due_date,
      ib.amount,
      ib.paid_amount,
      ib.paid_amount - ib.amount AS overpaid
    FROM inst_base ib
    JOIN last_period lp 
      ON lp.contract_external_id = ib.contract_external_id 
      AND lp.max_period = ib.period
    JOIN closed_contracts cc 
      ON cc.external_id = ib.contract_external_id
    WHERE ib.paid_amount > ib.amount + 0.5
    ORDER BY (ib.paid_amount - ib.amount) DESC
    LIMIT 100
  `);
  const data = (rows as any)[0] ?? rows;

  if (data.length === 0) {
    console.log("ไม่พบสัญญาที่งวดสุดท้ายมียอดชำระเกิน (INST_BASE only)\n");

    // ดูภาพรวม
    const summaryRows = await db.execute(sql`
      WITH inst_base AS (
        SELECT 
          i.contract_external_id,
          i.period,
          CAST(i.amount AS DECIMAL(18,2)) AS amount,
          CAST(i.paid_amount AS DECIMAL(18,2)) AS paid_amount
        FROM installments i
        WHERE i.section = 'Fastfone365'
          AND JSON_EXTRACT(i.raw_json, '$.paid') IS NOT NULL
      ),
      last_period AS (
        SELECT contract_external_id, MAX(period) AS max_period
        FROM inst_base
        GROUP BY contract_external_id
      ),
      closed_contracts AS (
        SELECT external_id FROM contracts
        WHERE section = 'Fastfone365' AND status = 'สิ้นสุดสัญญา'
      )
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN ib.paid_amount > ib.amount + 0.5 THEN 1 ELSE 0 END) AS overpaid_count,
        SUM(CASE WHEN ib.paid_amount < ib.amount - 0.5 THEN 1 ELSE 0 END) AS underpaid_count,
        SUM(CASE WHEN ABS(ib.paid_amount - ib.amount) <= 0.5 THEN 1 ELSE 0 END) AS exact_count,
        SUM(ib.paid_amount - ib.amount) AS net_diff
      FROM inst_base ib
      JOIN last_period lp ON lp.contract_external_id = ib.contract_external_id AND lp.max_period = ib.period
      JOIN closed_contracts cc ON cc.external_id = ib.contract_external_id
    `);
    const sumData = (summaryRows as any)[0] ?? summaryRows;
    if (sumData.length > 0) {
      const s = sumData[0];
      console.log(`สรุปงวดสุดท้ายของสัญญา สิ้นสุดสัญญา Fastfone365:`);
      console.log(`  ทั้งหมด: ${s.total} สัญญา`);
      console.log(`  ชำระเกิน (paid > amount): ${s.overpaid_count} สัญญา`);
      console.log(`  ชำระขาด (paid < amount): ${s.underpaid_count} สัญญา`);
      console.log(`  ชำระพอดี: ${s.exact_count} สัญญา`);
      console.log(`  ผลต่างสุทธิ: ${Number(s.net_diff).toLocaleString("th-TH", {minimumFractionDigits:2})} บาท`);
    }
    process.exit(0);
  }

  let totalOverpaid = 0;
  console.log(`พบ ${data.length} สัญญาที่งวดสุดท้ายชำระเกิน:\n`);
  for (const r of data) {
    const ov = Number(r.overpaid);
    totalOverpaid += ov;
    console.log(`สัญญา: ${r.contract_no}  ลูกค้า: ${r.customer_name ?? "-"}  โทร: ${r.phone ?? "-"}`);
    console.log(`  งวดสุดท้าย: ${r.last_period}  due: ${r.due_date}`);
    console.log(`  ค่างวด: ${Number(r.amount).toFixed(2)}  ชำระ: ${Number(r.paid_amount).toFixed(2)}  เกิน: ${ov.toFixed(2)} บาท\n`);
  }
  console.log(`${"=".repeat(60)}`);
  console.log(`รวมยอดชำระเกินงวดสุดท้าย: ${totalOverpaid.toLocaleString("th-TH", {minimumFractionDigits:2})} บาท`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

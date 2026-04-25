import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) { console.log('no db'); return; }

  // หาสัญญาสิ้นสุดสัญญาที่มี TXRTC receipt (FF365)
  const res = await db.execute(sql`
    SELECT c.contract_no, c.external_id, c.installment_count,
           COUNT(pt.id) AS txrtc_count
    FROM contracts c
    JOIN payment_transactions pt ON pt.contract_external_id = c.external_id AND pt.section = c.section
    WHERE c.section = 'Fastfone365'
      AND c.status = 'สิ้นสุดสัญญา'
      AND JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) LIKE 'TXRTC%'
    GROUP BY c.contract_no, c.external_id, c.installment_count
    LIMIT 5
  `);
  const rows = (res as any)[0] ?? res;
  console.log('FF365 สิ้นสุดสัญญา + TXRTC:');
  console.log(JSON.stringify(rows, null, 2));

  // หาสัญญาสิ้นสุดสัญญาที่มี TXRTC receipt (Boonphone)
  const res2 = await db.execute(sql`
    SELECT c.contract_no, c.external_id, c.installment_count,
           COUNT(pt.id) AS txrtc_count
    FROM contracts c
    JOIN payment_transactions pt ON pt.contract_external_id = c.external_id AND pt.section = c.section
    WHERE c.section = 'Boonphone'
      AND c.status = 'สิ้นสุดสัญญา'
      AND JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) LIKE 'TXRTC%'
    GROUP BY c.contract_no, c.external_id, c.installment_count
    LIMIT 5
  `);
  const rows2 = (res2 as any)[0] ?? res2;
  console.log('\nBoonphone สิ้นสุดสัญญา + TXRTC:');
  console.log(JSON.stringify(rows2, null, 2));
}

main().catch(console.error);

/**
 * test-p62.mjs — ทดสอบ 3-pattern isClosed logic (Phase 62)
 * รัน: node test-p62.mjs
 */
import { createConnection } from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

const conn = await createConnection(process.env.DATABASE_URL);

// ดึง contracts ที่มี TXRTC จาก Boonphone
const [payRows] = await conn.execute(`
  SELECT 
    pt.contract_external_id,
    JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) AS receipt_no
  FROM payment_transactions pt
  WHERE pt.section = 'Boonphone'
    AND JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) IS NOT NULL
  ORDER BY pt.contract_external_id
`);

// จัดกลุ่มตาม contract
const byContract = new Map();
for (const r of payRows) {
  const key = r.contract_external_id;
  if (!byContract.has(key)) byContract.set(key, { txrtc: 0, normalPeriods: new Set() });
  const receipt = r.receipt_no ?? "";
  if (receipt.startsWith("TXRTC")) {
    byContract.get(key).txrtc++;
  } else {
    const m = /-(\d+)$/.exec(receipt);
    if (m) byContract.get(key).normalPeriods.add(Number(m[1]));
  }
}

// ดึง installment_count ต่อ contract
const contractIds = Array.from(byContract.keys());
const [cRows] = await conn.execute(`
  SELECT external_id, installment_count, contract_no
  FROM contracts
  WHERE section = 'Boonphone'
    AND external_id IN (${contractIds.map(() => "?").join(",")})
`, contractIds);

const installCountByKey = new Map();
const contractNoByKey = new Map();
for (const r of cRows) {
  installCountByKey.set(String(r.external_id), Number(r.installment_count ?? 0));
  contractNoByKey.set(String(r.external_id), r.contract_no);
}

// จัดกลุ่มตาม pattern
const p1 = [], p2 = [], p3 = [];
for (const [key, data] of byContract) {
  if (data.txrtc === 0) continue;
  const maxNormal = data.normalPeriods.size > 0 ? Math.max(...data.normalPeriods) : 0;
  const totalPeriods = installCountByKey.get(key) ?? 0;
  const contractNo = contractNoByKey.get(key) ?? key;
  
  if (totalPeriods > 0 && maxNormal >= totalPeriods) {
    p3.push({ contractNo, maxNormal, totalPeriods, txrtc: data.txrtc });
  } else if (maxNormal === 0) {
    p1.push({ contractNo, maxNormal, totalPeriods, txrtc: data.txrtc });
  } else {
    p2.push({ contractNo, maxNormal, totalPeriods, txrtc: data.txrtc });
  }
}

console.log(`\n=== Pattern 1 (maxNormal=0, งวด 1 ปกติ, งวด 2+ ปิดค่างวด) ===`);
console.log(`จำนวน: ${p1.length} สัญญา`);
p1.slice(0, 3).forEach(r => console.log(`  ${r.contractNo}: maxNormal=${r.maxNormal}, total=${r.totalPeriods}, TXRTC=${r.txrtc}`));

console.log(`\n=== Pattern 2 (1 < maxNormal < total, งวด N+1+ ปิดค่างวด) ===`);
console.log(`จำนวน: ${p2.length} สัญญา`);
p2.slice(0, 3).forEach(r => console.log(`  ${r.contractNo}: maxNormal=${r.maxNormal}, total=${r.totalPeriods}, TXRTC=${r.txrtc}`));

console.log(`\n=== Pattern 3 (maxNormal >= total, ยอดปกติทั้งหมด) ===`);
console.log(`จำนวน: ${p3.length} สัญญา`);
p3.slice(0, 3).forEach(r => console.log(`  ${r.contractNo}: maxNormal=${r.maxNormal}, total=${r.totalPeriods}, TXRTC=${r.txrtc}`));

// ทดสอบ CT0925-PKN001-15462-01 โดยเฉพาะ
const [testRows] = await conn.execute(`
  SELECT 
    i.period, i.amount, i.paid_amount, i.due_date
  FROM installments i
  WHERE i.section = 'Boonphone'
    AND i.contract_external_id = (
      SELECT external_id FROM contracts WHERE contract_no = 'CT0925-PKN001-15462-01' AND section = 'Boonphone' LIMIT 1
    )
  ORDER BY i.period
`);

const [testPayRows] = await conn.execute(`
  SELECT JSON_UNQUOTE(JSON_EXTRACT(pt.raw_json, '$.receipt_no')) AS receipt_no
  FROM payment_transactions pt
  WHERE pt.section = 'Boonphone'
    AND pt.contract_external_id = (
      SELECT external_id FROM contracts WHERE contract_no = 'CT0925-PKN001-15462-01' AND section = 'Boonphone' LIMIT 1
    )
`);

const [testContract] = await conn.execute(`
  SELECT installment_count FROM contracts WHERE contract_no = 'CT0925-PKN001-15462-01' AND section = 'Boonphone' LIMIT 1
`);

const receipts = testPayRows.map(r => r.receipt_no).filter(Boolean);
const normalPeriods = new Set();
let txrtcCount = 0;
for (const r of receipts) {
  if (r.startsWith("TXRTC")) txrtcCount++;
  else { const m = /-(\d+)$/.exec(r); if (m) normalPeriods.add(Number(m[1])); }
}
const maxNormal = normalPeriods.size > 0 ? Math.max(...normalPeriods) : 0;
const totalPeriods = Number(testContract[0]?.installment_count ?? 0);

console.log(`\n=== CT0925-PKN001-15462-01 ===`);
console.log(`Receipts: ${receipts.join(", ")}`);
console.log(`maxNormal=${maxNormal}, totalPeriods=${totalPeriods}, TXRTC=${txrtcCount}`);
const pattern = totalPeriods > 0 && maxNormal >= totalPeriods ? 3 : maxNormal === 0 ? 1 : 2;
console.log(`Pattern: ${pattern}`);
console.log(`\nงวด | amount | paid | isClosed`);
for (const r of testRows) {
  const periodNo = Number(r.period);
  let isClosed = false;
  if (pattern === 1 || pattern === 2) {
    isClosed = periodNo > 1 && periodNo > maxNormal;
  }
  // pattern 3: isClosed = false ทั้งหมด
  console.log(`  ${periodNo} | ${Number(r.amount).toFixed(2)} | ${Number(r.paid_amount).toFixed(2)} | ${isClosed ? "ปิดค่างวด ✅" : "ยอดปกติ"}`);
}

await conn.end();

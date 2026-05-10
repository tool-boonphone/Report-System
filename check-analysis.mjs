import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ตรวจสอบ payment_external_id ใน cache ว่าตรงกับ external_id ใน payment_transactions หรือไม่
const [sample] = await conn.query(`
  SELECT dcc.payment_external_id, dcc.section, dcc.total_amount, dcc.payment_tx_amount
  FROM debt_collected_cache dcc
  WHERE dcc.section = 'Fastfone365'
  LIMIT 5
`);
console.log("=== ตัวอย่าง payment_external_id ใน cache ===");
for (const r of sample) {
  console.log(`  payment_external_id='${r.payment_external_id}', total=${Number(r.total_amount).toFixed(2)}, payment_tx=${Number(r.payment_tx_amount).toFixed(2)}`);
}

// ตรวจสอบ external_id ใน payment_transactions
const [ptSample] = await conn.query(`
  SELECT external_id, section, amount FROM payment_transactions WHERE section = 'Fastfone365' LIMIT 5
`);
console.log("\n=== ตัวอย่าง external_id ใน payment_transactions ===");
for (const r of ptSample) {
  console.log(`  external_id='${r.external_id}', amount=${Number(r.amount).toFixed(2)}`);
}

// ตรวจสอบว่า JOIN ด้วย payment_external_id = external_id ได้กี่ rows
const [joinTest] = await conn.query(`
  SELECT COUNT(*) as cnt FROM debt_collected_cache dcc
  JOIN payment_transactions pt ON pt.external_id = dcc.payment_external_id AND pt.section = dcc.section
  WHERE dcc.section = 'Fastfone365'
`);
console.log(`\n=== JOIN ด้วย payment_external_id = external_id ===`);
console.log(`  count: ${joinTest[0].cnt}`);

// ตรวจสอบ payment_external_id format ใน cache
const [formats] = await conn.query(`
  SELECT payment_external_id FROM debt_collected_cache WHERE section = 'Fastfone365' LIMIT 10
`);
console.log("\n=== payment_external_id format ===");
for (const r of formats) console.log(`  '${r.payment_external_id}'`);

// ตรวจสอบ external_id format ใน payment_transactions
const [ptFormats] = await conn.query(`
  SELECT external_id FROM payment_transactions WHERE section = 'Fastfone365' LIMIT 10
`);
console.log("\n=== external_id format ใน payment_transactions ===");
for (const r of ptFormats) console.log(`  '${r.external_id}'`);

await conn.end();

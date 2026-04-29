import mysql from "mysql2/promise";

const db = await mysql.createConnection(process.env.DATABASE_URL);

// ดู payments ของ CT1124-SKA002-3314-01 (ext_id=3426)
const [rows] = await db.execute(
  `SELECT pt.paid_at, pt.total_paid_amount, pt.principal_paid, pt.interest_paid,
          pt.fee_paid, pt.penalty_paid, pt.external_id
   FROM payment_transactions pt
   JOIN contracts c ON c.id = pt.contract_id
   WHERE c.external_id = '3426'
   ORDER BY pt.paid_at, pt.total_paid_amount`
);

console.log("=== Payments for CT1124-SKA002-3314-01 (ext_id=3426) ===");
for (const r of rows) {
  console.log(`  paid_at=${r.paid_at} total=${r.total_paid_amount} principal=${r.principal_paid} interest=${r.interest_paid} ext_id=${r.external_id}`);
}

// ดู bad_debt_amount และ bad_debt_date จาก contracts
const [cRows] = await db.execute(
  `SELECT external_id, contract_no, status, bad_debt_amount, bad_debt_date 
   FROM contracts WHERE external_id = '3426'`
);
console.log("\n=== Contract info ===");
for (const r of cRows) {
  console.log(`  ext_id=${r.external_id} contract_no=${r.contract_no} status=${r.status} bad_debt_amount=${r.bad_debt_amount} bad_debt_date=${r.bad_debt_date}`);
}

// จำลอง Phase 107 logic
const realPayments = rows.filter(r => /^\d+$/.test(String(r.external_id)));
console.log(`\n=== Real payments (numeric ext_id): ${realPayments.length} rows ===`);
for (const r of realPayments) {
  console.log(`  paid_at=${r.paid_at} total=${r.total_paid_amount}`);
}

// sort by paid_at desc
const sorted = [...realPayments].sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));
const latestDate = sorted.length > 0 ? String(sorted[0].paid_at).substring(0, 10) : null;
const latestDatePayments = sorted.filter(r => String(r.paid_at).substring(0, 10) === latestDate);
const latestDateTotal = latestDatePayments.reduce((s, r) => s + Number(r.total_paid_amount), 0);

console.log(`\n=== Phase 106/107 Result ===`);
console.log(`  latestDate = ${latestDate}`);
console.log(`  latestDatePayments count = ${latestDatePayments.length}`);
console.log(`  latestDateTotal (bad_debt_amount) = ${latestDateTotal}`);

// normalPayments = payments NOT on latestDate (Phase 107)
const normalPayments = realPayments.filter(r => String(r.paid_at).substring(0, 10) !== latestDate);
console.log(`\n=== Normal payments (after Phase 107 filter) ===`);
for (const r of normalPayments) {
  console.log(`  paid_at=${r.paid_at} total=${r.total_paid_amount}`);
}
console.log(`  → ${normalPayments.length} normal payment rows (should be 1: 2024-12-24)`);
console.log(`  → 1 bad-debt row: period=5, bad_debt_amount=${latestDateTotal}`);
console.log(`  → TOTAL rows in table: ${normalPayments.length + 1}`);

await db.end();

import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดู distinct section ใน debt_collected_cache
const [cacheS] = await conn.query("SELECT DISTINCT section, COUNT(*) as cnt FROM debt_collected_cache GROUP BY section");
console.log("=== debt_collected_cache sections ===");
for (const r of cacheS) console.log(`  section='${r.section}': ${r.cnt} rows`);

// ดู distinct section ใน payment_transactions
const [ptS] = await conn.query("SELECT DISTINCT section, COUNT(*) as cnt FROM payment_transactions GROUP BY section");
console.log("\n=== payment_transactions sections ===");
for (const r of ptS) console.log(`  section='${r.section}': ${r.cnt} rows`);

// ยอดรวม breakdown ทุก section ใน cache
const [cacheT] = await conn.query(`
  SELECT section, 
    SUM(principal + interest + fee + penalty + unlock_fee + overpaid + bad_debt) as breakdown_sum,
    SUM(total_amount) as total_amount_sum,
    SUM(payment_tx_amount) as payment_tx_sum,
    COUNT(*) as cnt
  FROM debt_collected_cache GROUP BY section
`);
console.log("\n=== cache totals ===");
for (const r of cacheT) console.log(`  section='${r.section}': breakdown=${Number(r.breakdown_sum).toFixed(2)}, total_amount=${Number(r.total_amount_sum).toFixed(2)}, payment_tx=${Number(r.payment_tx_sum).toFixed(2)}, cnt=${r.cnt}`);

// ยอดรวม payment_transactions ทุก section
const [ptT] = await conn.query("SELECT section, SUM(amount) as total, COUNT(*) as cnt FROM payment_transactions GROUP BY section");
console.log("\n=== payment_transactions totals ===");
for (const r of ptT) console.log(`  section='${r.section}': total=${Number(r.total).toFixed(2)}, cnt=${r.cnt}`);

await conn.end();

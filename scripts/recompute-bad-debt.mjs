/**
 * Re-run computeAndStoreBadDebt for both sections
 * to update contracts.bad_debt_amount using Phase 106/107 rule.
 */
import { createConnection } from "mysql2/promise";
import { readFileSync } from "fs";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL not set");

// Parse DATABASE_URL: mysql://user:pass@host:port/db
const url = new URL(DB_URL);
const conn = await createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: url.username,
  password: url.password,
  database: url.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: false },
});

const sections = ["Boonphone", "Fastfone365"];

for (const section of sections) {
  console.log(`\n=== Processing ${section} ===`);

  // 1) Fetch bad-debt contracts (status = "หนี้เสีย")
  const [contracts] = await conn.execute(
    `SELECT external_id, status FROM contracts WHERE section = ? AND status = 'หนี้เสีย'`,
    [section]
  );
  console.log(`Found ${contracts.length} bad-debt contracts`);
  if (contracts.length === 0) continue;

  const extIds = contracts.map((c) => c.external_id);

  // 2) Fetch real payments for these contracts
  const placeholders = extIds.map(() => "?").join(",");
  const [payments] = await conn.execute(
    `SELECT contract_external_id,
            external_id AS payment_external_id,
            paid_at,
            CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.total_paid_amount')) AS DECIMAL(18,2)) AS total_paid_amount
     FROM payment_transactions
     WHERE section = ?
       AND contract_external_id IN (${placeholders})
     ORDER BY contract_external_id, paid_at`,
    [section, ...extIds]
  );

  // Group payments by contract
  const payMap = new Map();
  for (const p of payments) {
    const extId = String(p.contract_external_id ?? "");
    if (!payMap.has(extId)) payMap.set(extId, []);
    payMap.get(extId).push({
      payment_external_id: String(p.payment_external_id ?? ""),
      paid_at: p.paid_at ?? null,
      total_paid_amount: Number(p.total_paid_amount ?? 0),
    });
  }

  // 3) Compute and update
  let updated = 0;
  let skipped = 0;
  const results = [];

  for (const c of contracts) {
    const extId = c.external_id;
    const allPayments = payMap.get(String(extId)) ?? [];

    // Filter real payments (not synthetic "pay-*")
    const realPayments = allPayments.filter(
      (p) => !p.payment_external_id.startsWith("pay-") && p.total_paid_amount > 0
    );

    if (realPayments.length === 0) {
      skipped++;
      continue;
    }

    // Sort by paid_at DESC
    const sorted = [...realPayments].sort((a, b) =>
      (b.paid_at ?? "").localeCompare(a.paid_at ?? "")
    );

    // latestDate = วันที่ล่าสุด
    const latestDate = sorted[0].paid_at
      ? String(sorted[0].paid_at).substring(0, 10)
      : null;

    // Rule 3: sum ของทุก real payment ที่วันที่ตรงกับ latestDate
    const latestDatePayments = latestDate
      ? realPayments.filter((p) =>
          p.paid_at ? String(p.paid_at).substring(0, 10) === latestDate : false
        )
      : [sorted[0]];

    const totalBadDebt = latestDatePayments.reduce((sum, p) => sum + p.total_paid_amount, 0);
    const badDebtDate = latestDate;

    results.push({ extId, totalBadDebt, badDebtDate });

    // Update DB
    await conn.execute(
      `UPDATE contracts SET bad_debt_amount = ?, bad_debt_date = ? WHERE section = ? AND external_id = ?`,
      [totalBadDebt, badDebtDate, section, extId]
    );
    updated++;

    if (updated % 50 === 0) console.log(`  Updated ${updated}/${contracts.length}...`);
  }

  console.log(`Done: ${updated} updated, ${skipped} skipped (no real payments)`);

  // Show sample results
  console.log("\nSample results:");
  for (const r of results.slice(0, 10)) {
    console.log(`  ${r.extId}: bad_debt_amount=${r.totalBadDebt}, date=${r.badDebtDate}`);
  }

  // Check specific contracts
  const targetIds = ["3030", "3426", "3314"];
  for (const tid of targetIds) {
    const found = results.find((r) => String(r.extId) === tid);
    if (found) {
      console.log(`\n[TARGET] ext_id=${tid}: bad_debt_amount=${found.totalBadDebt}, date=${found.badDebtDate}`);
    }
  }
}

await conn.end();
console.log("\n✅ Done!");

/**
 * Audit: check whether follow-up / tracking history is captured anywhere
 * in DB for ธัญธร มหาดไทย (CT0226-UTT002-1265-01).
 *
 * User-provided evidence (2026-04-23):
 *   Boonphone UI "การติดตามค่างวด" tab shows entry #4 on 21 เม.ย. 2569
 *   with action "ต้องการระงับสัญญา". We want to know if the public
 *   API carries this date anywhere.
 */
import mysql from "mysql2/promise";
import "dotenv/config";

const db = await mysql.createConnection(process.env.DATABASE_URL!);

// 1) Find the contract row by customer name (or contract_no)
const [contracts] = await db.query<any[]>(
  `SELECT external_id AS contract_external_id, contract_no, customer_name, status,
          approve_date, raw_json
     FROM contracts
    WHERE customer_name LIKE '%ธัญธร%'
       OR contract_no   LIKE '%1265-01%'
    LIMIT 5`,
);

console.log("=== Matching contracts ===");
for (const c of contracts) {
  console.log({
    contract_external_id: c.contract_external_id,
    contract_no: c.contract_no,
    customer_name: c.customer_name,
    status: c.status,
    approve_date: c.approve_date,
  });
}

if (contracts.length === 0) {
  console.log("No matching contract found, exiting.");
  process.exit(0);
}

// 2) Dump all top-level raw_json keys to see if follow-up fields exist
const target = contracts[0];
const raw =
  typeof target.raw_json === "string" ? JSON.parse(target.raw_json) : target.raw_json;
console.log("\n=== Contract raw_json top-level keys ===");
console.log(Object.keys(raw ?? {}).sort());

// 3) Search for any key that smells like follow-up/tracking
const keys = Object.keys(raw ?? {});
const interesting = keys.filter((k) =>
  /follow|track|trace|note|history|log|suspend|ระงับ/i.test(k),
);
console.log("\n=== Interesting keys in contract ===", interesting);
for (const k of interesting) {
  console.log(`${k}:`, JSON.stringify(raw[k], null, 2).slice(0, 500));
}

// 4) Also dump installments raw_json top-level keys for this contract
const extId = target.contract_external_id;
const [insts] = await db.query<any[]>(
  `SELECT period, due_date, raw_json
     FROM installments
    WHERE contract_external_id = ?
    ORDER BY period`,
  [extId],
);
console.log(`\n=== Installments for ${extId} ===`);
const allKeys = new Set<string>();
for (const it of insts) {
  const r =
    typeof it.raw_json === "string" ? JSON.parse(it.raw_json) : it.raw_json;
  if (r) Object.keys(r).forEach((k) => allKeys.add(k));
}
console.log("Installment raw_json keys (union):", Array.from(allKeys).sort());

const instInteresting = Array.from(allKeys).filter((k) =>
  /follow|track|trace|note|history|log|suspend|ระงับ/i.test(k),
);
console.log("Interesting installment keys:", instInteresting);

// 5) Show any installment rows where status_code = ระงับสัญญา
const suspended = insts.filter((i) => {
  const r = typeof i.raw_json === "string" ? JSON.parse(i.raw_json) : i.raw_json;
  return r?.installment_status_code === "ระงับสัญญา";
});
console.log(
  `\nSuspended periods (${suspended.length}):`,
  suspended.map((s) => ({ period: s.period, due_date: s.due_date })),
);

await db.end();

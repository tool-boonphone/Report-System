import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const CONTRACT_NO = "CT0226-AYA002-0414-01";

async function main() {
  const pool = new Pool({ connectionString: process.env.BOONPHONE_DATABASE_URL });

  const [snap, cache] = await Promise.all([
    pool.query(
      `SELECT period, due_date,
              total_amount::numeric, paid_amount::numeric,
              is_paid, is_closed, is_suspended, is_arrears,
              is_current_period, is_future_period,
              contract_status, debt_range,
              populated_at
       FROM monthly_target_detail_snapshot
       WHERE section = $1 AND contract_no = $2 AND snapshot_month = $3
       ORDER BY period`,
      ["Boonphone", CONTRACT_NO, "2026-06"]
    ),
    pool.query(
      `SELECT period, due_date,
              total_amount::numeric, paid_amount::numeric,
              is_paid, is_closed, is_suspended, is_arrears,
              is_current_period, is_future_period,
              contract_status, debt_range
       FROM debt_target_cache
       WHERE section = $1 AND contract_no = $2
       ORDER BY period`,
      ["Boonphone", CONTRACT_NO]
    ),
  ]);

  console.log("=== SNAPSHOT (monthly_target_detail_snapshot) ===");
  console.log("snapshot row count:", snap.rows.length);
  console.log("cache row count:", cache.rows.length);
  for (const r of snap.rows) {
    console.log(
      `period=${r.period} due=${r.due_date} total=${r.total_amount} paid=${r.paid_amount} ` +
      `is_paid=${r.is_paid} is_closed=${r.is_closed} is_suspended=${r.is_suspended} ` +
      `is_arrears=${r.is_arrears} is_current=${r.is_current_period} is_future=${r.is_future_period} ` +
      `status=${r.contract_status} debt_range=${r.debt_range}`
    );
  }
  if (snap.rows[0]) console.log("populated_at:", snap.rows[0].populated_at);

  console.log("\n=== CACHE (debt_target_cache / Live) ===");
  for (const r of cache.rows) {
    console.log(
      `period=${r.period} due=${r.due_date} total=${r.total_amount} paid=${r.paid_amount} ` +
      `is_paid=${r.is_paid} is_closed=${r.is_closed} is_suspended=${r.is_suspended} ` +
      `is_arrears=${r.is_arrears} is_current=${r.is_current_period} is_future=${r.is_future_period} ` +
      `status=${r.contract_status} debt_range=${r.debt_range}`
    );
  }

  // เปรียบเทียบ period by period
  console.log("\n=== DIFF (snapshot vs cache) ===");
  const snapMap = new Map(snap.rows.map((r: any) => [Number(r.period), r]));
  const cacheMap = new Map(cache.rows.map((r: any) => [Number(r.period), r]));
  const allPeriods = new Set([...snapMap.keys(), ...cacheMap.keys()]);
  let hasDiff = false;
  for (const p of [...allPeriods].sort((a, b) => a - b)) {
    const s = snapMap.get(p);
    const c = cacheMap.get(p);
    if (!s || !c) { console.log(`period=${p}: only in ${s ? "snapshot" : "cache"}`); hasDiff = true; continue; }
    const diffs: string[] = [];
    for (const key of ["total_amount","paid_amount","is_paid","is_closed","is_suspended","is_arrears","is_current_period","is_future_period","contract_status","debt_range"]) {
      if (String(s[key]) !== String(c[key])) {
        diffs.push(`${key}: snap=${s[key]} cache=${c[key]}`);
      }
    }
    if (diffs.length > 0) { console.log(`period=${p}: ${diffs.join(" | ")}`); hasDiff = true; }
  }
  if (!hasDiff) console.log("ไม่มีความแตกต่าง — ข้อมูลตรงกันทุก period");

  await pool.end();
}

main().catch(console.error);

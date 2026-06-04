import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const CONTRACT_NO = "CT0226-AYA001-0073-01";

async function main() {
  const pool = new Pool({ connectionString: process.env.BOONPHONE_DATABASE_URL });

  // ดู breakdown ของแต่ละงวด: principal, interest, fee, penalty
  const cache = await pool.query(`
    SELECT period, due_date,
           principal::numeric, interest::numeric, fee::numeric,
           penalty::numeric, unlock_fee::numeric,
           total_amount::numeric, paid_amount::numeric,
           is_paid, is_arrears, is_current_period,
           contract_status, debt_range,
           installment_amount::numeric
    FROM debt_target_cache
    WHERE section = 'Boonphone' AND contract_no = $1
    ORDER BY period
  `, [CONTRACT_NO]);

  console.log("=== debt_target_cache breakdown ===");
  console.log(`${"period".padEnd(8)} ${"due".padEnd(12)} ${"principal".padEnd(12)} ${"interest".padEnd(10)} ${"fee".padEnd(8)} ${"penalty".padEnd(10)} ${"total".padEnd(10)} ${"paid".padEnd(10)} ${"remaining".padEnd(12)} is_paid  is_arrears  debt_range`);
  for (const r of cache.rows) {
    const total = Number(r.total_amount);
    const paid = Number(r.paid_amount);
    console.log(
      `${String(r.period).padEnd(8)} ${String(r.due_date).slice(0,10).padEnd(12)} ` +
      `${String(r.principal).padEnd(12)} ${String(r.interest).padEnd(10)} ${String(r.fee).padEnd(8)} ` +
      `${String(r.penalty).padEnd(10)} ${String(total).padEnd(10)} ${String(paid).padEnd(10)} ` +
      `${String(total - paid).padEnd(12)} ${String(r.is_paid).padEnd(9)} ${String(r.is_arrears).padEnd(12)} ${r.debt_range}`
    );
  }

  // ดู installment_amount จาก contracts table
  const contract = await pool.query(`
    SELECT contract_no, installment_amount::numeric, installment_count, total_price::numeric
    FROM contracts
    WHERE section = 'Boonphone' AND contract_no = $1
  `, [CONTRACT_NO]);
  console.log("\n=== contracts table ===");
  console.log(contract.rows[0]);

  await pool.end();
}

main().catch(console.error);

import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const CONTRACT_NO = "CT0226-AYA001-0073-01";

async function main() {
  const pool = new Pool({ connectionString: process.env.BOONPHONE_DATABASE_URL });

  // ดูข้อมูลใน debt_target_cache
  const cache = await pool.query(`
    SELECT period, due_date,
           total_amount::numeric, paid_amount::numeric,
           is_paid, is_closed, is_suspended, is_arrears,
           is_current_period, is_future_period,
           contract_status, debt_range
    FROM debt_target_cache
    WHERE section = 'Boonphone' AND contract_no = $1
    ORDER BY period
  `, [CONTRACT_NO]);

  console.log("=== debt_target_cache ===");
  for (const r of cache.rows) {
    console.log(
      `period=${r.period} due=${String(r.due_date).slice(0,10)} ` +
      `total=${r.total_amount} paid=${r.paid_amount} ` +
      `is_paid=${r.is_paid} is_closed=${r.is_closed} ` +
      `is_arrears=${r.is_arrears} is_current=${r.is_current_period} ` +
      `status=${r.contract_status} debt_range=${r.debt_range}`
    );
  }

  // จำลอง rederiveDaysOverdue ด้วย today
  const today = new Date();
  const todayMs = today.getTime();
  let maxDays = 0;
  let maxDuePeriod = -1;
  for (const r of cache.rows) {
    if (r.is_paid || r.is_closed || r.is_suspended) continue;
    const dueDate = String(r.due_date).slice(0, 10);
    const dueMs = Date.parse(`${dueDate}T00:00:00`);
    if (isNaN(dueMs)) continue;
    const total = Number(r.total_amount);
    const paid = Number(r.paid_amount);
    if (total <= 0.001) continue;
    if (paid >= total - 0.5) continue; // fully paid
    if (dueMs > todayMs) continue; // future
    const days = Math.floor((todayMs - dueMs) / 86_400_000);
    if (days > maxDays) {
      maxDays = days;
      maxDuePeriod = r.period;
    }
  }

  console.log(`\n=== rederive result (today=${today.toISOString().slice(0,10)}) ===`);
  console.log(`maxDays=${maxDays} (from period=${maxDuePeriod})`);
  if (maxDays <= 0) console.log("debtStatus: ปกติ");
  else if (maxDays <= 7) console.log("debtStatus: เกิน 1-7");
  else if (maxDays <= 14) console.log("debtStatus: เกิน 8-14");
  else if (maxDays <= 30) console.log("debtStatus: เกิน 15-30");
  else if (maxDays <= 60) console.log("debtStatus: เกิน 31-60");
  else if (maxDays <= 90) console.log("debtStatus: เกิน 61-90");
  else console.log("debtStatus: เกิน >90");

  // ตรวจสอบว่า period ที่ทำให้เกิน 61-90 คืออะไร
  console.log("\n=== งวดที่ยังค้างชำระ (paid < total, ไม่ future) ===");
  for (const r of cache.rows) {
    if (r.is_paid || r.is_closed || r.is_suspended) continue;
    const dueDate = String(r.due_date).slice(0, 10);
    const dueMs = Date.parse(`${dueDate}T00:00:00`);
    if (isNaN(dueMs)) continue;
    const total = Number(r.total_amount);
    const paid = Number(r.paid_amount);
    if (total <= 0.001) continue;
    if (paid >= total - 0.5) continue;
    if (dueMs > todayMs) continue;
    const days = Math.floor((todayMs - dueMs) / 86_400_000);
    console.log(`  period=${r.period} due=${dueDate} total=${total} paid=${paid} remaining=${total-paid} daysOverdue=${days}`);
  }

  await pool.end();
}

main().catch(console.error);

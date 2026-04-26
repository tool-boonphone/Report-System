/**
 * test-p63b.mjs — ทดสอบ assignPayPeriods กับข้อมูลจริงของ CT0925-PKN001-15462-01
 * ผลลัพธ์ที่ต้องการ:
 * - TXRT-1 → period=1
 * - TXRT-2 → period=2 (overpaid=7,802 → ข้ามงวด 3,4)
 * - TXRT-3 → period=5
 * - TXRT-4 → period=6
 * - TXRT-5 → period=7
 * - TXRTC → period=8
 * - carry rows → period=3, period=4
 */

// Simulate assignPayPeriods logic
const payments = [
  { receipt_no: "TXRT0925-PKN001-15462-01-1", paid_at: "2025-09-20", amount: 3901, principal_paid: 1810, interest_paid: 1991, fee_paid: 100, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 1, bad_debt_amount: 0 },
  { receipt_no: "TXRT0925-PKN001-15462-01-2", paid_at: "2025-10-09", amount: 11703, principal_paid: 1810, interest_paid: 1991, fee_paid: 100, overpaid_amount: 7802, close_installment_amount: 3901, payment_id: 2, bad_debt_amount: 0 },
  { receipt_no: "TXRT0925-PKN001-15462-01-3", paid_at: "2025-12-05", amount: 3901, principal_paid: 1810, interest_paid: 1991, fee_paid: 100, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 3, bad_debt_amount: 0 },
  { receipt_no: "TXRT0925-PKN001-15462-01-4", paid_at: "2026-02-28", amount: 3901, principal_paid: 1810, interest_paid: 1991, fee_paid: 100, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 4, bad_debt_amount: 0 },
  { receipt_no: "TXRT0925-PKN001-15462-01-5", paid_at: "2026-04-03", amount: 3901, principal_paid: 1810, interest_paid: 1991, fee_paid: 100, overpaid_amount: 0, close_installment_amount: 3901, payment_id: 5, bad_debt_amount: 0 },
  { receipt_no: "TXRTC0925-PKN001-15462-01", paid_at: "2026-04-20", amount: 3120.80, principal_paid: 1810, interest_paid: 1991, fee_paid: 100, overpaid_amount: 0, close_installment_amount: 3120.80, payment_id: 6, bad_debt_amount: 0 },
];

const installments = [
  { period: 1, amount: 3901 },
  { period: 2, amount: 3901 },
  { period: 3, amount: 3901 },
  { period: 4, amount: 3901 },
  { period: 5, amount: 3901 },
  { period: 6, amount: 3901 },
  { period: 7, amount: 3901 },
  { period: 8, amount: 3901 },
];

// Simulate assignPayPeriods
function assignPayPeriods(payments, installmentList) {
  if (!payments.length) return [];
  const schedule = installmentList
    .filter((i) => i.period != null)
    .map((i) => ({ period: i.period, amount: Number(i.amount) || 0 }))
    .sort((a, b) => a.period - b.period);

  let cursor = 0;
  let coveredCurrent = 0;
  const periodSeen = new Map();
  const out = [];

  const sorted = [...payments].sort((a, b) => {
    const at = a.paid_at ?? "";
    const bt = b.paid_at ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return (a.payment_id ?? 0) - (b.payment_id ?? 0);
  });

  for (const p of sorted) {
    if ((p.bad_debt_amount ?? 0) > 0) {
      const lastPeriod = schedule.length ? schedule[schedule.length - 1].period : 1;
      const splitIdx = periodSeen.get(lastPeriod) ?? 0;
      periodSeen.set(lastPeriod, splitIdx + 1);
      out.push({ ...p, period: lastPeriod, splitIndex: splitIdx, isCloseRow: false, isBadDebtRow: true });
      continue;
    }

    const period = schedule[cursor]?.period ?? null;
    const splitIdx = period != null ? (periodSeen.get(period) ?? 0) : 0;
    if (period != null) periodSeen.set(period, splitIdx + 1);

    const receipt = String(p.receipt_no ?? "");
    const isCloseRow = receipt.startsWith("TXRTC");

    out.push({ ...p, period, splitIndex: splitIdx, isCloseRow, isBadDebtRow: false });

    if (isCloseRow) {
      if (cursor < schedule.length - 1) {
        cursor += 1;
        coveredCurrent = 0;
      }
    } else {
      const pif = Number(p.principal_paid ?? 0) + Number(p.interest_paid ?? 0) + Number(p.fee_paid ?? 0);
      const consumed = pif > 0 ? pif : Number(p.close_installment_amount ?? 0) > 0 ? Number(p.close_installment_amount) : Number(p.total_paid_amount ?? 0);
      coveredCurrent += consumed;
      while (cursor < schedule.length - 1 && schedule[cursor].amount > 0 && coveredCurrent >= schedule[cursor].amount - 0.5) {
        coveredCurrent -= schedule[cursor].amount;
        cursor += 1;
      }
      // Phase 63: advance cursor เพิ่มตาม overpaid amount
      const overpaidAmount = Number(p.overpaid_amount ?? 0);
      if (overpaidAmount > 0.009) {
        let overpaidRem = overpaidAmount;
        while (cursor < schedule.length - 1 && schedule[cursor].amount > 0 && overpaidRem >= schedule[cursor].amount - 0.5) {
          overpaidRem -= schedule[cursor].amount;
          cursor += 1;
          coveredCurrent = 0;
        }
      }
    }
  }
  return out;
}

const result = assignPayPeriods(payments, installments);

console.log("\n=== assignPayPeriods Result ===");
for (const r of result) {
  console.log(`  period=${r.period} | receipt=${r.receipt_no} | paid_at=${r.paid_at} | amount=${r.amount} | overpaid=${r.overpaid_amount} | isClose=${r.isCloseRow}`);
}

// ตรวจสอบ carry rows
const existingPeriods = new Set(result.filter(p => !p.isCloseRow && !p.isBadDebtRow).map(p => p.period));
const maxNormal = Math.max(...Array.from(existingPeriods));
console.log(`\nmaxNormal=${maxNormal}, existingPeriods=${[...existingPeriods].sort((a,b)=>a-b).join(',')}`);

const gaps = [];
for (let pNo = 1; pNo <= maxNormal; pNo++) {
  if (!existingPeriods.has(pNo)) gaps.push(pNo);
}
console.log(`gaps (carry periods)=${gaps.join(',')}`);

console.log("\n=== Expected ===");
console.log("  period=1 → TXRT-1");
console.log("  period=2 → TXRT-2 (overpaid=7,802)");
console.log("  period=3 → (carry) ← ต้องสร้าง");
console.log("  period=4 → (carry) ← ต้องสร้าง");
console.log("  period=5 → TXRT-3");
console.log("  period=6 → TXRT-4");
console.log("  period=7 → TXRT-5");
console.log("  period=8 → TXRTC");

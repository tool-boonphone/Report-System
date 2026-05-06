import { createConnection } from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config({ path: "/home/ubuntu/report-system/.env" });

const db = await createConnection(process.env.DATABASE_URL);

// 1. Get installments for contract 34 (FF)
const [instRows] = await db.execute(
  `SELECT external_id, period, amount, paid_amount, status, due_date FROM installments 
   WHERE section='Fastfone365' AND contract_external_id='34' 
   ORDER BY period, external_id`
);
console.log("=== RAW INSTALLMENTS (contract 34) ===");
for (const r of instRows) {
  console.log(`  period=${r.period} ext_id=${r.external_id} amount=${r.amount} paid=${r.paid_amount} status=${r.status} due=${r.due_date}`);
}

// 2. Get payments for contract 34 (FF)
const [payRows] = await db.execute(
  `SELECT external_id, paid_at, amount, receipt_no, status FROM payment_transactions 
   WHERE section='Fastfone365' AND contract_external_id='34' 
   ORDER BY paid_at, external_id`
);
console.log("\n=== RAW PAYMENTS (contract 34) ===");
for (const r of payRows) {
  console.log(`  ext_id=${r.external_id} paid_at=${r.paid_at} amount=${r.amount} receipt=${r.receipt_no} status=${r.status}`);
}

// 3. Deduplicate installments
function isPaymentRecordRow(extId) {
  if (!extId) return false;
  return /^\d+$/.test(extId);
}

function dedupInstByPeriod(list) {
  const byPeriod = new Map();
  for (const row of list) {
    const p = row.period;
    const rowAmt = Number(row.amount ?? 0);
    const rowDue = row.due_date ? new Date(row.due_date) : null;
    const isPayRec = isPaymentRecordRow(row.external_id);
    const isConfirmed = row.status === 'ยืนยันการชำระ';
    const rowPaid = Number(row.paid_amount ?? 0);
    const existing = byPeriod.get(p);
    if (!existing) {
      byPeriod.set(p, {
        base: row,
        minDueDate: rowDue,
        confirmedPaymentRecord: (isPayRec && isConfirmed) ? row : null,
        anyPayRecSeen: isPayRec,
        maxPayRecPaid: isPayRec ? rowPaid : 0,
      });
    } else {
      if (isPayRec) {
        existing.anyPayRecSeen = true;
        if (rowPaid > existing.maxPayRecPaid) existing.maxPayRecPaid = rowPaid;
        if (isConfirmed && !existing.confirmedPaymentRecord) existing.confirmedPaymentRecord = row;
      }
      const existIsPayRec = isPaymentRecordRow(existing.base.external_id);
      if (!existIsPayRec && isPayRec) {
        // keep existing base (INSTALLMENT_BASE)
      } else if (existIsPayRec && !isPayRec) {
        existing.base = row; // prefer INSTALLMENT_BASE
      } else if (!existIsPayRec && !isPayRec) {
        if (rowAmt > Number(existing.base.amount ?? 0)) existing.base = row;
      }
      if (rowDue && (!existing.minDueDate || rowDue < existing.minDueDate)) existing.minDueDate = rowDue;
    }
  }
  return Array.from(byPeriod.values()).map(({ base, minDueDate, confirmedPaymentRecord, anyPayRecSeen, maxPayRecPaid }) => {
    let paidAmount;
    let instStatus;
    if (confirmedPaymentRecord) {
      paidAmount = Number(confirmedPaymentRecord.paid_amount ?? 0);
      instStatus = 'ยืนยันการชำระ';
    } else if (anyPayRecSeen) {
      paidAmount = maxPayRecPaid;
      instStatus = base.status === 'ยืนยันการชำระ' ? 'ยังไม่ถึงกำหนด' : base.status;
    } else {
      paidAmount = Number(base.paid_amount ?? 0);
      instStatus = base.status;
    }
    return { ...base, due_date: minDueDate ? minDueDate.toISOString().slice(0, 10) : base.due_date, paid_amount: paidAmount, status: instStatus };
  }).sort((a, b) => (a.period ?? 0) - (b.period ?? 0));
}

const deduped = dedupInstByPeriod(instRows);
console.log("\n=== DEDUPED INSTALLMENTS ===");
for (const r of deduped) {
  console.log(`  period=${r.period} ext_id=${r.external_id} amount=${r.amount} paid=${r.paid_amount} status=${r.status} due=${r.due_date}`);
}
console.log(`  Total deduped periods: ${deduped.length}`);

// 4. Simulate Phase 106
const contractNo = "CT0824-NRT001-00021-01";
const contractBadDebtDate = "2025-03-24";
const contractBadDebtAmount = 14000;

// Filter real payments (exclude TXRTC)
const realPaymentsRaw = payRows.filter(p => {
  const receipt = p.receipt_no ?? "";
  if (receipt.startsWith("TXRTC")) return false;
  return true;
});
console.log("\n=== REAL PAYMENTS (after TXRTC filter) ===");
for (const p of realPaymentsRaw) {
  console.log(`  ext_id=${p.external_id} paid_at=${p.paid_at} amount=${p.amount} receipt=${p.receipt_no}`);
}

// normalPaymentsRaw = exclude bad debt date
const normalPaymentsRaw = realPaymentsRaw.filter(p => {
  const paidDate = p.paid_at ? String(p.paid_at).slice(0, 10) : null;
  return !(paidDate && paidDate === contractBadDebtDate);
});
console.log("\n=== NORMAL PAYMENTS (after bad debt date filter) ===");
for (const p of normalPaymentsRaw) {
  console.log(`  ext_id=${p.external_id} paid_at=${p.paid_at} amount=${p.amount} receipt=${p.receipt_no}`);
}

// installments for assignPayPeriods
const baselineAmt = 4195;
const instForAssign = deduped.map(i => ({ period: i.period, amount: Number(i.amount) > 0 ? Number(i.amount) : baselineAmt }));
console.log("\n=== INSTALLMENTS FOR assignPayPeriods ===");
for (const i of instForAssign) {
  console.log(`  period=${i.period} amount=${i.amount}`);
}

await db.end();

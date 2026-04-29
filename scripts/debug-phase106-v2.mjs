/**
 * debug-phase106-v2.mjs
 * จำลอง Phase 106 logic เต็มรูปแบบ สำหรับ 3 contracts ที่ผิด
 * เพื่อหาว่าทำไม bad_debt_amount ยังแสดงผิดในหน้าเว็บ
 */
import mysql from "mysql2/promise";

const TEST_CONTRACTS = [
  { id: "3030", no: "CT1124-BKK003-2988-01", expected: 3000 },
  { id: "36", no: "CT0824-NRT001-00023-01", expected: 7000 },
  { id: "3426", no: "CT1124-SKA002-3314-01", expected: 7400 },
];

function isPaymentRecordRow(row) {
  const amt = Number(row.amount ?? 0);
  const status = row.status_code ?? row.inst_status ?? null;
  // Payment record rows: amount = 0 OR status = ยืนยันการชำระ
  return amt < 0.001 || status === "ยืนยันการชำระ";
}

function dedupInstByPeriod(list) {
  if (list.length === 0) return list;
  const byPeriod = new Map();

  for (const row of list) {
    const p = row.period;
    const rowAmt = Number(row.amount ?? 0);
    const rowDue = row.due_date ? new Date(row.due_date) : null;
    const isPayRec = isPaymentRecordRow(row);
    const isConfirmed = (row.status_code ?? row.inst_status) === "ยืนยันการชำระ";
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
      }
      if (isPayRec && isConfirmed && existing.confirmedPaymentRecord == null) {
        existing.confirmedPaymentRecord = row;
      }
      const existIsPayRec = isPaymentRecordRow(existing.base);
      const existAmt = Number(existing.base.amount ?? 0);
      if (!isPayRec && existIsPayRec) {
        existing.base = row;
      } else if (!isPayRec && !existIsPayRec && rowAmt > existAmt) {
        existing.base = row;
      } else if (isPayRec && existIsPayRec && rowAmt > existAmt) {
        existing.base = row;
      }
      if (rowDue && (existing.minDueDate == null || rowDue < existing.minDueDate)) {
        existing.minDueDate = rowDue;
      }
    }
  }

  const merged = Array.from(byPeriod.values()).map(({ base, minDueDate, confirmedPaymentRecord, anyPayRecSeen, maxPayRecPaid }) => {
    let paidAmount;
    let instStatus;
    if (confirmedPaymentRecord != null) {
      paidAmount = Number(confirmedPaymentRecord.paid_amount ?? 0);
      instStatus = "ยืนยันการชำระ";
    } else if (anyPayRecSeen) {
      paidAmount = maxPayRecPaid;
      instStatus = base.inst_status === "ยืนยันการชำระ" ? "ยังไม่ถึงกำหนด" : base.inst_status;
    } else {
      paidAmount = Number(base.paid_amount ?? 0);
      instStatus = base.inst_status;
    }
    return {
      ...base,
      due_date: minDueDate ? minDueDate.toISOString().slice(0, 10) : base.due_date,
      paid_amount: paidAmount,
      inst_status: instStatus,
    };
  });

  return merged.sort((a, b) => (a.period ?? 0) - (b.period ?? 0));
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  for (const c of TEST_CONTRACTS) {
    console.log("\n" + "=".repeat(60));
    console.log("CONTRACT:", c.no, "| expected bad_debt:", c.expected);

    // ดู installments ใน Fastfone365 section
    const [instRowsRaw] = await conn.execute(
      `SELECT period, due_date, 
              CAST(amount AS DECIMAL(18,2)) AS amount, 
              CAST(paid_amount AS DECIMAL(18,2)) AS paid_amount, 
              status AS inst_status,
              JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.installment_status_code')) AS status_code
       FROM installments 
       WHERE contract_external_id = ? AND section = 'Fastfone365' 
       ORDER BY period, due_date`,
      [c.id]
    );

    const dedupedInst = dedupInstByPeriod(instRowsRaw);
    console.log("Deduped installments (" + dedupedInst.length + "):");
    for (const inst of dedupedInst) {
      const isSuspended =
        inst.inst_status === "ยกเลิกสัญญา" ||
        inst.inst_status === "ระงับสัญญา" ||
        inst.inst_status === "หนี้เสีย";
      console.log(
        "  period=" + inst.period +
        " | due=" + inst.due_date +
        " | amount=" + inst.amount +
        " | paid=" + inst.paid_amount +
        " | status=" + inst.inst_status +
        " | isSuspended=" + isSuspended
      );
    }

    // ดู payments
    const [pRowsRaw] = await conn.execute(
      `SELECT external_id AS payment_external_id,
              paid_at,
              CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
              JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no
       FROM payment_transactions
       WHERE contract_external_id = ? AND section = 'Fastfone365'
       ORDER BY paid_at, payment_external_id`,
      [c.id]
    );

    const realPayments = pRowsRaw.filter((p) => {
      const isNum = p.payment_external_id != null && /^\d+$/.test(String(p.payment_external_id));
      const isTxrt = p.receipt_no != null && /^TXRT.*-\d+$/.test(String(p.receipt_no));
      return isNum || isTxrt;
    });

    console.log("Real payments (" + realPayments.length + "):");
    for (const p of realPayments) {
      console.log("  paid_at=" + p.paid_at + " | amount=" + p.total_paid_amount + " | ext_id=" + p.payment_external_id);
    }

    // Phase 106 simulation
    if (realPayments.length > 0) {
      const sorted = [...realPayments].sort((a, b) => {
        const da = String(a.paid_at ?? "").substring(0, 10);
        const db2 = String(b.paid_at ?? "").substring(0, 10);
        return da < db2 ? 1 : da > db2 ? -1 : 0;
      });
      const latestDate = String(sorted[0].paid_at ?? "").substring(0, 10);
      const latestPays = sorted.filter(
        (p) => String(p.paid_at ?? "").substring(0, 10) === latestDate
      );
      const latestTotal = latestPays.reduce(
        (s, p) => s + Number(p.total_paid_amount ?? 0),
        0
      );

      // Find firstSuspendedPeriod
      const firstSuspendedPeriod = dedupedInst
        .filter((inst) => {
          const s = inst.inst_status;
          return s === "ยกเลิกสัญญา" || s === "ระงับสัญญา" || s === "หนี้เสีย";
        })
        .map((inst) => inst.period ?? 0)
        .filter((p) => p > 0)
        .sort((a, b) => a - b)[0] ?? null;

      // normalPayments = real payments NOT on latestDate
      const normalPayments = sorted.filter(
        (p) => String(p.paid_at ?? "").substring(0, 10) !== latestDate
      );

      let lastNormalPeriod = 0;
      // Simplified: just count normal payments as periods
      for (let i = 0; i < normalPayments.length; i++) {
        lastNormalPeriod = i + 1;
      }

      let badDebtPeriod;
      if (firstSuspendedPeriod != null) {
        badDebtPeriod = firstSuspendedPeriod;
      } else {
        badDebtPeriod = lastNormalPeriod + 1;
      }

      console.log("\nPhase 106 result:");
      console.log("  latestDate: " + latestDate);
      console.log("  latestTotal (bad_debt_amount): " + latestTotal);
      console.log("  firstSuspendedPeriod: " + firstSuspendedPeriod);
      console.log("  normalPayments count: " + normalPayments.length);
      console.log("  badDebtPeriod: " + badDebtPeriod);
      console.log("  expected: " + c.expected);
      console.log("  match: " + (Math.abs(latestTotal - c.expected) < 1 ? "✅" : "❌"));
    } else {
      console.log("  ⚠️ No real payments — Phase 106 will NOT run!");
    }
  }

  await conn.end();
}

main().catch(console.error);

/**
 * debug-phase106-final.mjs
 * ทดสอบ Phase 106 logic กับ DB จริง สำหรับ 3 สัญญาที่ผิด
 * เพื่อยืนยันว่า debtStatus = "หนี้เสีย" จริงหรือไม่
 */
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";

const TEST_CONTRACTS = [
  "CT1124-BKK003-2988-01",  // 1 payment of 3,000 → หนี้เสีย = 3,000
  "CT0824-NRT001-00023-01", // 3 payments (3000/750/7000), latest = 7000 → หนี้เสีย = 7,000
  "CT1124-SKA002-3314-01",  // latest date 2025-04-04 has 4 payments (2436+2436+2436+92=7400) → หนี้เสีย = 7,400
];

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  
  for (const contractId of TEST_CONTRACTS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`CONTRACT: ${contractId}`);
    console.log("=".repeat(60));
    
    // 1. ดู contract status
    const [cRows] = await conn.execute(
      `SELECT external_id, contract_no, status, bad_debt_amount, bad_debt_date 
       FROM contracts WHERE external_id = ?`,
      [contractId]
    );
    const contract = cRows[0];
    if (!contract) {
      console.log("  ❌ Contract not found");
      continue;
    }
    console.log(`  status: "${contract.status}"`);
    console.log(`  bad_debt_amount (DB): ${contract.bad_debt_amount}`);
    console.log(`  bad_debt_date (DB): ${contract.bad_debt_date}`);
    
    // 2. ดู payment_transactions
    const [pRows] = await conn.execute(
      `SELECT external_id AS payment_external_id, 
              paid_at,
              CAST(amount AS DECIMAL(18,2)) AS total_paid_amount,
              JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
              status AS ff_status
       FROM payment_transactions
       WHERE contract_external_id = ?
       ORDER BY paid_at, payment_external_id`,
      [contractId]
    );
    
    console.log(`\n  All payments (${pRows.length} rows):`);
    for (const p of pRows) {
      const payExtId = p.payment_external_id;
      const receiptNo = p.receipt_no;
      const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
      const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(String(receiptNo));
      const isReal = isNumericPayExt || isTxrtReceipt;
      console.log(`    paid_at=${p.paid_at} | amount=${p.total_paid_amount} | ext_id=${payExtId} | receipt=${receiptNo} | isReal=${isReal}`);
    }
    
    // 3. Phase 106 logic simulation
    const realPayments = pRows.filter(p => {
      const payExtId = p.payment_external_id;
      const receiptNo = p.receipt_no;
      const isNumericPayExt = payExtId != null && /^\d+$/.test(String(payExtId));
      const isTxrtReceipt = receiptNo != null && /^TXRT.*-\d+$/.test(String(receiptNo));
      return isNumericPayExt || isTxrtReceipt;
    });
    
    console.log(`\n  Real payments: ${realPayments.length}`);
    
    const isHniiSia = contract.status === "หนี้เสีย";
    console.log(`  contract.status = "หนี้เสีย"? ${isHniiSia}`);
    
    if (isHniiSia && realPayments.length > 0) {
      // Sort descending by paid_at
      const sortedReal = [...realPayments].sort((a, b) => {
        const da = String(a.paid_at ?? "").substring(0, 10);
        const db2 = String(b.paid_at ?? "").substring(0, 10);
        return da < db2 ? 1 : da > db2 ? -1 : 0;
      });
      
      const latestDate = String(sortedReal[0].paid_at ?? "").substring(0, 10);
      const latestDatePayments = sortedReal.filter(
        p => String(p.paid_at ?? "").substring(0, 10) === latestDate
      );
      const latestDateTotal = latestDatePayments.reduce(
        (sum, p) => sum + Number(p.total_paid_amount ?? 0), 0
      );
      
      console.log(`\n  Phase 106 result:`);
      console.log(`    latestDate: ${latestDate}`);
      console.log(`    latestDatePayments: ${latestDatePayments.length} payments`);
      for (const p of latestDatePayments) {
        console.log(`      - paid_at=${p.paid_at} | amount=${p.total_paid_amount}`);
      }
      console.log(`    latestDateTotal (= bad_debt_amount): ${latestDateTotal}`);
      
      const normalPayments = sortedReal.filter(
        p => String(p.paid_at ?? "").substring(0, 10) !== latestDate
      );
      console.log(`    normalPayments (for period assignment): ${normalPayments.length}`);
    } else if (!isHniiSia) {
      console.log(`  ⚠️  contract.status is NOT "หนี้เสีย" — Phase 106 will NOT run!`);
    } else {
      console.log(`  ⚠️  No real payments found — Phase 106 will NOT run!`);
    }
  }
  
  await conn.end();
}

main().catch(console.error);

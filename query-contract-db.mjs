import mysql from 'mysql2/promise';

const CONTRACT_CODE = 'CT0925-PKN001-15462-01';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('=== Installments ===');
const [installments] = await conn.execute(
  `SELECT i.installment_no, i.due_date, i.principal_due, i.interest_due, i.fee_due,
          i.penalty_due, i.unlock_fee_due, i.total_paid_amount, i.total_due_amount,
          i.installment_status_code, i.closed_at, i.suspended_at, i.bad_debt_at
   FROM installments i
   JOIN contracts c ON c.id = i.contract_id
   WHERE c.contract_no = ?
   ORDER BY i.installment_no`,
  [CONTRACT_CODE]
);

installments.forEach(r => {
  console.log(`Period ${r.installment_no}: due=${r.due_date} total_due=${r.total_due_amount} total_paid=${r.total_paid_amount} principal=${r.principal_due} interest=${r.interest_due} fee=${r.fee_due} status=${r.installment_status_code} closed_at=${r.closed_at}`);
});

console.log('\n=== Payment Transactions ===');
const [payments] = await conn.execute(
  `SELECT p.receipt_no, p.payment_date, p.total_paid_amount,
          p.principal_paid, p.interest_paid, p.fee_paid,
          p.penalty_paid, p.overpaid_amount, p.close_installment_amount,
          p.bad_debt_amount, p.payment_status, p.remark
   FROM payment_transactions p
   JOIN contracts c ON c.id = p.contract_id
   WHERE c.contract_no = ?
   ORDER BY p.payment_date, p.receipt_no`,
  [CONTRACT_CODE]
);

payments.forEach(r => {
  console.log(`${r.receipt_no} date=${r.payment_date} total=${r.total_paid_amount} principal=${r.principal_paid} interest=${r.interest_paid} fee=${r.fee_paid} overpaid=${r.overpaid_amount} close=${r.close_installment_amount} status=${r.payment_status} remark=${r.remark}`);
});

await conn.end();

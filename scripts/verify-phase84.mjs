import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool(process.env.DATABASE_URL);

const extId = 'CT1225-AYA013-19847-01';

// Get TXRTC dates
const [txrtcRows] = await pool.query(`
  SELECT paid_at, JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no
  FROM payment_transactions
  WHERE section = 'Fastfone365'
    AND contract_external_id = ?
    AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRTC%'
  ORDER BY paid_at ASC
  LIMIT 5
`, [extId]);

console.log('TXRTC dates:', txrtcRows.map(r => ({ receipt_no: r.receipt_no, paid_at: r.paid_at })));

// Get installment due_date for period 3
const [instRows] = await pool.query(`
  SELECT period, due_date
  FROM installments
  WHERE section = 'Fastfone365'
    AND contract_external_id = ?
    AND period IN (1,2,3,4)
  ORDER BY period
`, [extId]);

console.log('Installment due dates:', instRows.map(r => ({ period: r.period, due_date: r.due_date })));

const txrtcDate = txrtcRows.length > 0 ? new Date(txrtcRows[0].paid_at) : null;
const period3 = instRows.find(r => r.period === 3);
const dueDate3 = period3 ? new Date(period3.due_date) : null;

console.log('\n--- Phase 84 Analysis ---');
console.log('txrtcPaidDate (earliest):', txrtcDate?.toISOString().slice(0,10));
console.log('dueDate(N=3):', dueDate3?.toISOString().slice(0,10));
console.log('txrtcPaidDate < dueDate(N)?', txrtcDate && dueDate3 ? txrtcDate < dueDate3 : 'N/A');
console.log('Expected maxClosedPeriod:', txrtcDate && dueDate3 && txrtcDate < dueDate3 ? 3-1 : 3);
console.log('Expected isClosed from period:', txrtcDate && dueDate3 && txrtcDate < dueDate3 ? 3 : 4, '(inclusive)');

await pool.end();

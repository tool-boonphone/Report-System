import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({uri: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});

// For contracts 1164, 201, 2540, 2546, 995:
// show ALL payments and ALL installments side by side.
const ids = ['1164','201','2540','2546','995'];
for (const id of ids) {
  console.log('===== contract', id, '=====');
  const [ins] = await conn.query(
    `SELECT period, amount, paid_amount FROM installments WHERE section='Boonphone' AND contract_external_id=? ORDER BY period`,
    [id]);
  console.log('installments:', ins.map(i=>({p:Number(i.period), amount:Number(i.amount), paid:Number(i.paid_amount)})));
  const [pt] = await conn.query(
    `SELECT paid_at,
            CAST(JSON_EXTRACT(raw_json,'$.overpaid_amount') AS DECIMAL(18,2)) AS overpaid,
            CAST(JSON_EXTRACT(raw_json,'$.close_installment_amount') AS DECIMAL(18,2)) AS close_amt,
            CAST(JSON_EXTRACT(raw_json,'$.principal_paid') AS DECIMAL(18,2)) AS principal_paid,
            CAST(JSON_EXTRACT(raw_json,'$.interest_paid') AS DECIMAL(18,2)) AS interest_paid,
            CAST(JSON_EXTRACT(raw_json,'$.fee_paid') AS DECIMAL(18,2)) AS fee_paid,
            JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.receipt_no')) AS receipt_no
       FROM payment_transactions WHERE section='Boonphone' AND contract_external_id=? ORDER BY paid_at`,
    [id]);
  console.log('payments:', pt.map(p=>({
    paid_at: p.paid_at,
    receipt: p.receipt_no,
    principal: Number(p.principal_paid||0),
    interest: Number(p.interest_paid||0),
    fee: Number(p.fee_paid||0),
    overpaid: Number(p.overpaid||0),
    close: Number(p.close_amt||0),
  })));
}
await conn.end();

import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL!);

const [rows] = await conn.execute(
  `SELECT id, external_id, contract_no, installment_amount, raw_json
   FROM contracts WHERE section='Boonphone' AND contract_no = 'CT0426-RBR002-4092-01' LIMIT 1`
);
const c: any = (rows as any[])[0];
if (!c) {
  console.log('contract not found');
  process.exit(0);
}
console.log('contract id', c.id, 'ext', c.external_id, 'inst_amount', c.installment_amount);

const [insts] = await conn.execute(
  `SELECT period, due_date, amount, paid_amount, raw_json
   FROM installments
   WHERE section='Boonphone' AND contract_external_id = ?
   ORDER BY period LIMIT 3`,
  [c.external_id]
);
console.log('\n--- installments ---');
for (const i of insts as any[]) {
  console.log('period', i.period, 'amount', i.amount, 'paid', i.paid_amount, 'due', i.due_date);
  const r = typeof i.raw_json === 'string' ? JSON.parse(i.raw_json) : i.raw_json;
  console.log('  raw keys:', Object.keys(r));
  console.log('  raw:', JSON.stringify(r, null, 2));
}
process.exit(0);

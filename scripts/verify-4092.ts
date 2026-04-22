import 'dotenv/config';
import { listDebtTarget } from '../server/debtDb.ts';
const { rows } = await listDebtTarget({ section: 'Boonphone' });
const c: any = rows.find((r: any) => r.contractNo === 'CT0426-RBR002-4092-01');
if (!c) { console.log('not found'); process.exit(1); }
console.log('baseline', c.installmentAmount);
for (const i of c.installments.slice(0, 3)) {
  console.log({ p: i.period, principal: i.principal, interest: i.interest, fee: i.fee, amount: i.amount });
}
process.exit(0);

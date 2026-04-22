import 'dotenv/config';
import { listDebtTarget } from '../server/debtDb.ts';
const { rows } = await listDebtTarget({ section: 'Boonphone' });
const c = rows.find(r => r.contractExternalId === '1496');
console.log('contract 1496 baseline installmentAmount:', c?.installmentAmount);
for (const i of c?.installments ?? []) {
  console.log({ p: i.period, amt: i.amount, base: i.baselineAmount, overpaid: i.overpaidApplied, closed: i.isClosed, paid: i.paid });
}
process.exit(0);

import { listDebtTarget } from '../server/debtDb.ts';

const { rows } = await listDebtTarget({ section: 'fastfone365' });
const row = rows.find(r => r.contractNo === 'CT1225-AYA013-19847-01');
if (!row) { console.log('NOT FOUND'); process.exit(1); }

console.log('debtStatus:', row.debtStatus);
// แสดง installments งวด 1-4
const insts = row.installments?.slice(0, 4) ?? [];
for (const inst of insts) {
  console.log(`Period ${inst.period}: amount=${inst.amount}, paid=${inst.paid}, rawAmount=${inst.rawAmount}, isPaid=${inst.isPaid}, isClosed=${inst.isClosed}, dueDate=${inst.dueDate}`);
}

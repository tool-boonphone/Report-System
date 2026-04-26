import { listDebtTarget } from './server/debtDb.js';

const result = await listDebtTarget({
  section: 'Fastfone365',
  page: 1,
  pageSize: 1000,
  search: 'CT0225-PTE002-9248-01',
});

const row = result.rows[0];
if (!row) {
  console.log('NOT FOUND');
  process.exit(0);
}

console.log('contract:', row.contractId, 'debtStatus:', row.debtStatus);
console.log('suspendedFromPeriod:', row.suspendedFromPeriod);
console.log('installments:');
row.installments.forEach(i => {
  console.log('  period:', i.period, '| isSuspended:', i.isSuspended, '| suspendLabel:', i.suspendLabel, '| amount:', i.amount, '| inst_status:', i.inst_status ?? '-');
});
process.exit(0);

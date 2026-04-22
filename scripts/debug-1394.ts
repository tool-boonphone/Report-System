import 'dotenv/config';
import { listDebtTarget } from '../server/debtDb.ts';
async function main() {
  const { rows } = await listDebtTarget({ section: 'Boonphone' });
  for (const extId of ['1394','1496','1517','10']) {
    const c = rows.find((r: any) => r.contractExternalId === extId);
    console.log('=== contract', extId, 'baseline', c?.installmentAmount);
    for (const i of c?.installments ?? []) {
      console.log({ p: i.period, amt: i.amount, base: i.baselineAmount, overpaid: i.overpaidApplied, closed: i.isClosed, paid: i.paid });
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });

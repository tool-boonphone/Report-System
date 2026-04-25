import { createRequire } from 'module';
import { execSync } from 'child_process';

// Use tsx to run the debug
const result = execSync(`cd /home/ubuntu/report-system && npx tsx -e "
import { db } from './server/db.ts';
import { contracts, payments } from './drizzle/schema.ts';
import { eq, like } from 'drizzle-orm';

const contract = await db.select().from(contracts).where(like(contracts.external_id, '%19817-01%')).limit(1);
console.log('Contract bad_debt_amount:', contract[0]?.bad_debt_amount);
console.log('Contract status:', contract[0]?.status);

if (contract[0]) {
  const pays = await db.select().from(payments).where(eq(payments.contract_id, contract[0].id)).limit(20);
  console.log('Payments count:', pays.length);
  pays.forEach(p => console.log('  period=' + p.period + ' total_paid=' + p.total_paid_amount + ' receipt=' + p.payment_external_id));
}
process.exit(0);
"`, { encoding: 'utf8', timeout: 30000 });

console.log(result);

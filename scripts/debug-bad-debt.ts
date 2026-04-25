import { getDb } from '../server/db.ts';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();

  // Query contract
  const contractResult = await db.execute(sql`
    SELECT id, external_id, status, bad_debt_amount, bad_debt_date, suspended_from_period
    FROM contracts
    WHERE external_id = 'CT1225-SRI001-19817-01'
    LIMIT 1
  `);
  const contract = (contractResult as any)[0]?.[0];
  console.log('Contract:', JSON.stringify(contract, null, 2));

  if (contract) {
    // Query payments
    const payResult = await db.execute(sql`
      SELECT period, total_paid_amount, payment_external_id, paid_at
      FROM payment_transactions
      WHERE contract_id = ${contract.id}
      ORDER BY period ASC
    `);
    const pays = (payResult as any)[0] as any[];
    console.log('\nPayments count:', pays.length);
    pays.forEach(p => console.log(`  period=${p.period} total_paid=${p.total_paid_amount} receipt=${p.payment_external_id}`));
  }
  process.exit(0);
}

main().catch(console.error);

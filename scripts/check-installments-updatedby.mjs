import { getDb } from '../server/db.ts';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.log('No DB'); process.exit(1); }

// Check raw_json for updated_by in installments
const rows = await db.execute(
  sql`SELECT contract_external_id, period, JSON_EXTRACT(raw_json, '$.updated_by') as updated_by_in_json, JSON_EXTRACT(raw_json, '$.updated_at') as updated_at_in_json FROM installments WHERE section='fastfone365' AND contract_external_id='9289' LIMIT 10`
);
console.log('updated_by in raw_json for contract 9289:');
for (const row of rows[0]) {
  console.log(JSON.stringify(row));
}

// Check a few more contracts to see if updated_by is consistently in raw_json
const sample = await db.execute(
  sql`SELECT contract_external_id, period, JSON_EXTRACT(raw_json, '$.updated_by') as updated_by FROM installments WHERE section='fastfone365' AND JSON_EXTRACT(raw_json, '$.updated_by') IS NOT NULL LIMIT 5`
);
console.log('\nSample installments with updated_by in raw_json:');
for (const row of sample[0]) {
  console.log(JSON.stringify(row));
}

// Count how many have updated_by in raw_json
const cnt = await db.execute(
  sql`SELECT COUNT(*) as total, SUM(JSON_EXTRACT(raw_json, '$.updated_by') IS NOT NULL) as has_updated_by FROM installments WHERE section='fastfone365'`
);
console.log('\nFF365 installments stats:', JSON.stringify(cnt[0][0]));

process.exit(0);

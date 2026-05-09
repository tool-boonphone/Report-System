/**
 * trigger-ff-cache.mjs
 * Manually trigger populateDebtCache for Fastfone365
 * Usage: node trigger-ff-cache.mjs
 */
import { createConnection } from 'mysql2/promise';

const conn = await createConnection(process.env.DATABASE_URL);

// Check current state
const [r1] = await conn.execute('SELECT COUNT(*) as cnt FROM debt_target_cache WHERE section = ?', ['Fastfone365']);
const [r2] = await conn.execute('SELECT COUNT(*) as cnt FROM debt_collected_cache WHERE section = ?', ['Fastfone365']);
console.log(`Before: debt_target_cache=${r1[0].cnt}, debt_collected_cache=${r2[0].cnt}`);

await conn.end();

console.log('Calling populateDebtCache via HTTP trigger...');
// Call the server endpoint to trigger cache population
const res = await fetch('http://localhost:3000/api/trpc/sync.triggerCachePopulate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { section: 'Fastfone365' } }),
});
const text = await res.text();
console.log('Response status:', res.status);
console.log('Response:', text.substring(0, 500));

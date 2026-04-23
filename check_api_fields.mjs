import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Try to find a row with penalty_due > 0
const [rows] = await conn.execute(
  "SELECT raw_json FROM installments WHERE JSON_EXTRACT(raw_json, '$.penalty_due') > 0 LIMIT 1"
);

let sample;
if (rows.length > 0) {
  const rj = rows[0].raw_json;
  sample = typeof rj === 'object' ? rj : JSON.parse(rj);
  console.log('Found row with penalty_due > 0');
} else {
  console.log('No penalty_due > 0 rows, using any row...');
  const [r2] = await conn.execute('SELECT raw_json FROM installments LIMIT 1');
  if (r2.length > 0) {
    const rj = r2[0].raw_json;
    sample = typeof rj === 'object' ? rj : JSON.parse(rj);
  }
}

if (sample) {
  console.log('\nALL KEYS:', Object.keys(sample).join(', '));
  const dueFields = Object.entries(sample).filter(([k]) =>
    k.includes('due') || k.includes('arrear') || k.includes('outstanding') ||
    k.includes('balance') || k.includes('remain') || k.includes('unpaid')
  );
  console.log('\nDUE/BALANCE fields:');
  for (const [k, v] of dueFields) {
    console.log(`  ${k}: ${v}`);
  }
  // Also show penalty/unlock related
  const penaltyFields = Object.entries(sample).filter(([k]) =>
    k.includes('penalty') || k.includes('unlock') || k.includes('fee')
  );
  console.log('\nPENALTY/UNLOCK/FEE fields:');
  for (const [k, v] of penaltyFields) {
    console.log(`  ${k}: ${v}`);
  }
}

await conn.end();

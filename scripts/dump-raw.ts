import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const c = await mysql.createConnection(process.env.DATABASE_URL as string);
  const [rows]: any = await c.execute(
    "SELECT raw_json FROM payment_transactions WHERE section='Boonphone' AND JSON_EXTRACT(raw_json,'$.close_installment_amount') > 0 LIMIT 1",
  );
  console.log('--- CLOSE payment raw_json ---');
  console.log(JSON.stringify(typeof rows[0].raw_json === 'string' ? JSON.parse(rows[0].raw_json) : rows[0].raw_json, null, 2));

  const [rows2]: any = await c.execute(
    "SELECT raw_json FROM payment_transactions WHERE section='Boonphone' AND JSON_EXTRACT(raw_json,'$.close_installment_amount') = 0 LIMIT 1",
  );
  console.log('\n--- NON-CLOSE payment raw_json ---');
  console.log(JSON.stringify(typeof rows2[0].raw_json === 'string' ? JSON.parse(rows2[0].raw_json) : rows2[0].raw_json, null, 2));

  await c.end();
}
main().catch(console.error);

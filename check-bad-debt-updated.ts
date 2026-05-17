import pg from 'pg';

const pool = new pg.Pool({
  connectionString: "postgresql://fastfone_db_user:ppMxqoDAZqZHubpsRjoZ9Qad5rKtSF4M@dpg-d847n5jtqb8s73f408l0-a.oregon-postgres.render.com/fastfone_db?sslmode=require",
});

const r1 = await pool.query(`SELECT COUNT(*) as cnt FROM debt_collected_cache`);
console.log('total rows:', r1.rows[0].cnt);

const r2 = await pool.query(`SELECT COUNT(*) as cnt FROM debt_collected_cache WHERE is_bad_debt_row = true`);
console.log('bad_debt rows:', r2.rows[0].cnt);

const r3 = await pool.query(`SELECT updated_by, updated_at, is_bad_debt_row, bad_debt FROM debt_collected_cache WHERE is_bad_debt_row = true LIMIT 5`);
console.log('bad_debt row samples:', JSON.stringify(r3.rows, null, 2));

await pool.end();
process.exit(0);

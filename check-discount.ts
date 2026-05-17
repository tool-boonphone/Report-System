import { Client } from "pg";

const configs = [
  { name: "Fastfone365", url: "postgresql://fastfone_db_user:ppMxqoDAZqZHubpsRjoZ9Qad5rKtSF4M@dpg-d847n5jtqb8s73f408l0-a.oregon-postgres.render.com/fastfone_db?sslmode=require" },
  { name: "Boonphone",   url: "postgresql://boonphone_db_user:GJBIlh7S9fXuUdvmun3fIjKbBeiX0o8R@dpg-d847l3d7vvec73f1n27g-a.oregon-postgres.render.com/boonphone_db?sslmode=require" },
];

async function main() {
  for (const cfg of configs) {
    const client = new Client({ connectionString: cfg.url });
    await client.connect();
    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'debt_collected_cache'
      ORDER BY ordinal_position
    `);
    const res2 = await client.query(`
      SELECT 
        COUNT(*) as total_rows,
        COALESCE(SUM(discount), 0) as total_discount,
        COUNT(CASE WHEN discount > 0 THEN 1 END) as rows_with_discount
      FROM debt_collected_cache
    `);
    console.log(`\n=== ${cfg.name} ===`);
    console.log('Columns:', res.rows.map((r:any) => r.column_name).join(', '));
    console.log('Discount stats:', res2.rows[0]);
    await client.end();
  }
}
main().catch(console.error);

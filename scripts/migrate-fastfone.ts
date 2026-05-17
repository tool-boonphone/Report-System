/**
 * migrate-fastfone.ts
 * Run drizzle migrations on fastfone-db (new DB)
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FASTFONE_DB_URL =
  process.env.FASTFONE_DATABASE_URL ||
  "postgresql://fastfone_db_user:ppMxqoDAZqZHubpsRjoZ9Qad5rKtSF4M@dpg-d847n5jtqb8s73f408l0-a.oregon-postgres.render.com/fastfone_db?sslmode=require";

async function main() {
  console.log("[migrate-fastfone] Connecting to fastfone-db...");
  const pool = new pg.Pool({
    connectionString: FASTFONE_DB_URL,
    max: 3,
    connectionTimeoutMillis: 30000,
  });

  const db = drizzle(pool);

  const migrationsFolder = path.resolve(__dirname, "../drizzle");
  console.log("[migrate-fastfone] Running migrations from:", migrationsFolder);

  await migrate(db, { migrationsFolder });

  console.log("[migrate-fastfone] ✅ Migration complete!");
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate-fastfone] ❌ Migration failed:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Reset local Sadmin password (for dev DB restored from production dump).
 * Usage: node scripts/reset-local-sadmin-password.mjs [newPassword]
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import pg from "pg";

const username = process.env.LOCAL_ADMIN_USERNAME || "Sadmin";
const password = process.argv[2] || "Aa123456+";
const url =
  process.env.BOONPHONE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://report:report@127.0.0.1:5432/boonphone_db?sslmode=disable";

const pool = new pg.Pool({ connectionString: url });
const hash = await bcrypt.hash(password, 10);
const result = await pool.query(
  "UPDATE app_users SET password_hash = $1, is_active = true WHERE username = $2 RETURNING username",
  [hash, username]
);

if (result.rowCount === 0) {
  console.error(`User not found: ${username}`);
  process.exit(1);
}

console.log(`Updated password for '${username}'`);
await pool.end();

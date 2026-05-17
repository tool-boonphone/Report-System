import { sql } from 'drizzle-orm';
import { db } from './server/_core/context.ts';

const rows = await db.execute(sql`SELECT updated_by, updated_at, is_bad_debt_row, bad_debt FROM debt_collected_cache WHERE is_bad_debt_row = true LIMIT 5`);
console.log(JSON.stringify(rows.rows, null, 2));
process.exit(0);

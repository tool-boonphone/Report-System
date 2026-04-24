import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const db = await getDb();
if (!db) { console.error('No DB'); process.exit(1); }

const rows = await db.execute(sql`SHOW TABLES LIKE '%payment%'`);
console.log('Payment tables:', JSON.stringify(rows[0]));

const rows2 = await db.execute(sql`SHOW TABLES LIKE '%contract%'`);
console.log('Contract tables:', JSON.stringify(rows2[0]));

process.exit(0);

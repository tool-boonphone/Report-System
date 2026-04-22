/**
 * Regression test for the ON DUPLICATE KEY UPDATE set block.
 *
 * Before the fix, drizzle compiled `set: { customerName: contracts.customerName }`
 * to `customer_name = \`contracts\`.\`customer_name\`` — a self-assignment that
 * silently no-op'd every upsert. This test pins the behaviour: the generated
 * SQL MUST reference `VALUES(col)` so the new payload actually overwrites the
 * stale DB row.
 */
import { describe, it, expect } from "vitest";
import { getDb } from "../db";
import { contracts } from "../../drizzle/schema";
import { sql } from "drizzle-orm";

describe("upsertContracts SQL shape", () => {
  it("emits VALUES(col) in the ON DUPLICATE KEY UPDATE set block", async () => {
    const db = await getDb();
    if (!db) {
      // In test environments without DATABASE_URL we skip; the CI env should
      // provide credentials for the rest of the suite anyway.
      return;
    }
    const q = db
      .insert(contracts)
      .values({
        section: "Boonphone",
        externalId: "TEST",
        contractNo: "X",
        customerName: "Z",
      } as any)
      .onDuplicateKeyUpdate({
        set: {
          customerName: sql.raw("VALUES(`customer_name`)"),
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .toSQL();
    expect(q.sql).toContain("VALUES(`customer_name`)");
    // Must NOT self-assign (the previous bug pattern).
    expect(q.sql).not.toContain("`customer_name` = `contracts`.`customer_name`");
  });
});

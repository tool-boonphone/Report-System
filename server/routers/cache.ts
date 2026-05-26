/**
 * cache.ts — tRPC router for DB cache management
 *
 * Procedures:
 *   - cache.populate   : Trigger populate for a section (admin only)
 *   - cache.status     : Get row counts for each section's cache tables
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { router, superAdminProcedure, appProcedure } from "../_core/trpc";
import { populateDebtCache } from "../sync/populateCache";
import { populateMonthlySummaryCache, populateDueMonthCache } from "../monthlySummaryDb";
import { getDb } from "../db";
import { SECTIONS, sectionSchema, type SectionKey } from "../../shared/const";
import { pgRows } from "../db";
// sectionSchema imported from shared/const — normalizes any case to canonical SectionKey
export const cacheRouter = router({
  /**
   * Trigger populate for a specific section.
   * Runs synchronously (awaited) so the caller knows when it's done.
   * Admin-only.
   */
  populate: superAdminProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input }) => {
      const section = input.section as SectionKey;
      const result = await populateDebtCache(section);
      return {
        section,
        targetRows: result.targetRows,
        collectedRows: result.collectedRows,
        populatedAt: new Date().toISOString(),
      };
    }),
  /**
   * Trigger populate asynchronously (fire-and-forget).
   * Returns immediately; populate runs in background.
   * Admin-only.
   */
  populateAsync: superAdminProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input }) => {
      const section = input.section as SectionKey;
      // Fire and forget — do NOT await
      populateDebtCache(section).catch((err: unknown) =>
        console.error(`[cache.populateAsync] ${section} failed:`, err),
      );
      return { section, started: true, startedAt: new Date().toISOString() };
    }),
  /**
   * Trigger populate for monthly summary cache (async, fire-and-forget).
   * Admin-only.
   */
  populateMonthlySummaryAsync: superAdminProcedure
    .input(z.object({ section: sectionSchema }))
    .mutation(async ({ input }) => {
      const section = input.section as SectionKey;
      // Fire and forget — do NOT await
      Promise.all([
        populateMonthlySummaryCache(section),
        populateDueMonthCache(section),
      ]).catch((err: unknown) =>
        console.error(`[cache.populateMonthlySummaryAsync] ${section} failed:`, err),
      );
      return { section, started: true, startedAt: new Date().toISOString() };
    }),
  /**
   * Get row counts for each section's cache tables.
   * Queries each section's dedicated DB separately and merges results.
   * Available to all authenticated users.
   */
  status: appProcedure.query(async () => {
    const rawRows: any[] = [];
    for (const sec of SECTIONS) {
      const db = await getDb(sec);
      if (!db) continue;
      const rows = await db.execute(sql`
        SELECT
          'target' AS cache_type,
          section,
          COUNT(*) AS row_count,
          MAX(populated_at) AS last_populated_at
        FROM debt_target_cache
        WHERE section = ${sec}
        GROUP BY section
        UNION ALL
        SELECT
          'collected' AS cache_type,
          section,
          COUNT(*) AS row_count,
          MAX(populated_at) AS last_populated_at
        FROM debt_collected_cache
        WHERE section = ${sec}
        GROUP BY section
      `);
      rawRows.push(...pgRows(rows));
    }
    const result: Record<string, {
      target: { rowCount: number; lastPopulatedAt: string | null };
      collected: { rowCount: number; lastPopulatedAt: string | null };
    }> = {};
    for (const section of SECTIONS) {
      result[section] = {
        target: { rowCount: 0, lastPopulatedAt: null },
        collected: { rowCount: 0, lastPopulatedAt: null },
      };
    }
    for (const r of rawRows) {
      const section = String(r.section);
      const cacheType = String(r.cache_type) as "target" | "collected";
      if (result[section]) {
        result[section][cacheType] = {
          rowCount: Number(r.row_count ?? 0),
          lastPopulatedAt: r.last_populated_at ? String(r.last_populated_at) : null,
        };
      }
    }
    return { sections: result };
  }),
});

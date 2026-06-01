/**
 * monthlyCollectionSnapshotDb.ts — Monthly Collection Snapshot Engine
 *
 * ตาราง monthly_collection_snapshot เก็บ snapshot รายเดือน:
 *   - target_amount: เป้าเก็บหนี้ (คำนวณจาก debt_target_cache)
 *   - collected_amount: ยอดเก็บหนี้ (คำนวณจาก debt_collected_cache)
 *   - financed_total: ยอดผ่อนรวม (SUM finance_amount × installment_count ต่อ due_month)
 *   - overdue_total: ค้างชำระรวม (SUM total_amount - paid_amount ทุก contract ที่ค้างใน due_month)
 *   - collected_sale: ยอดขายเครื่อง (จาก income_monthly_summary ประเภท 'ขายเครื่อง')
 *
 * Logic:
 *   1. Target = SUM(GREATEST(total_amount - paid_amount, 0)) ต่อ due_month
 *      WHERE due_date อยู่ใน collection_month AND is_closed IS NOT TRUE
 *   2. Collected = SUM(total_amount) จาก debt_collected_cache
 *      WHERE paid_at อยู่ใน collection_month
 *   3. FinancedTotal = SUM(finance_amount * installment_count) ต่อ due_month
 *   4. OverdueTotal = SUM(total_amount - paid_amount) ทุก row ที่ค้างชำระ ใน due_month
 *   5. CollectedSale = total_amount จาก income_monthly_summary WHERE income_type = 'ขายเครื่อง'
 *
 * Trigger: เรียกหลัง populateDebtCache() ใน runner.ts
 *
 * Freeze logic:
 *   - เดือนปัจจุบัน: อัพเดทได้เสมอ (live)
 *   - เดือนที่ผ่านมา: freeze หลังจาก sync ครั้งแรกของเดือนถัดไป
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { pgRows } from "./db";
import type { SectionKey } from "../shared/const";

// ─── Types ────────────────────────────────────────────────────────────────────
export type MonthlyCollectionSnapshotRow = {
  collectionMonth: string; // YYYY-MM
  targetAmount: number;
  targetContractCount: number;
  targetPrincipal: number;
  targetInterest: number;
  targetFee: number;
  targetPenalty: number;
  targetUnlockFee: number;
  collectedAmount: number;
  collectedContractCount: number;
  collectedPrincipal: number;
  collectedInterest: number;
  collectedFee: number;
  collectedPenalty: number;
  collectedUnlockFee: number;
  collectedDiscount: number;
  collectedOverpaid: number;
  collectedBadDebt: number;
  installTotal: number;
  // ── New columns ──────────────────────────────────────────────────────────────
  financedTotal: number;   // ยอดผ่อนรวม (finance_amount × installment_count)
  overdueTotal: number;    // ค้างชำระรวม
  collectedSale: number;   // ยอดขายเครื่อง
  // ── Freeze status ────────────────────────────────────────────────────────────
  collectedIsFrozen: boolean;
  targetFrozenAt: string | null;
  collectedFrozenAt: string | null;
  updatedAt: string;
};

// ─── Helper ───────────────────────────────────────────────────────────────────
function n(v: unknown): number {
  const num = Number(v);
  return isNaN(num) ? 0 : num;
}

// ─── Main: Populate snapshot for all months ───────────────────────────────────
/**
 * Populate monthly_collection_snapshot for a given section.
 * Called from runner.ts after populateDebtCache().
 *
 * Strategy:
 *   - คำนวณ target จาก debt_target_cache (group by due_month)
 *   - คำนวณ collected จาก debt_collected_cache (group by paid_at month)
 *   - คำนวณ financed_total, overdue_total จาก debt_target_cache
 *   - คำนวณ collected_sale จาก income_monthly_summary
 *   - Upsert ลง monthly_collection_snapshot
 *   - เดือนที่ผ่านมาจะ freeze (collected_is_frozen = true) เมื่อ sync เดือนถัดไป
 *
 * @returns จำนวน rows ที่ upsert
 */
export async function populateMonthlyCollectionSnapshot(
  section: SectionKey,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const db = await getDb(section);
  if (!db) throw new Error("[monthlySnapshot] DB not available");

  const nowStr = new Date().toISOString();
  const currentMonth = nowStr.slice(0, 7); // YYYY-MM

  console.log(`[monthlySnapshot] ${section}: starting populate`);

  // ── 1. Query target aggregates per due_month from debt_target_cache ──────────
  // ยอดเป้าเก็บหนี้: ตัดออก is_closed, is_future_period, is_suspended, is_bad_debt
  // (ตรงกับ logic toggle ตั้งหนี้: เหลือแค่ยอดถึงกำหนดชำระ + ค้างชำระ)
  const targetResult = await db.execute(sql`
    SELECT
      TO_CHAR(due_date, 'YYYY-MM') AS due_month,
      COUNT(DISTINCT contract_external_id) AS contract_count,
      SUM(GREATEST(COALESCE(total_amount::numeric, 0) - COALESCE(paid_amount::numeric, 0), 0)) AS target_amount,
      SUM(GREATEST(COALESCE(principal::numeric, 0) - COALESCE(paid_amount::numeric, 0), 0)) AS target_principal,
      SUM(interest::numeric) AS target_interest,
      SUM(fee::numeric) AS target_fee,
      SUM(penalty::numeric) AS target_penalty,
      SUM(unlock_fee::numeric) AS target_unlock_fee,
      SUM(baseline_amount::numeric) AS install_total,
      SUM(COALESCE(finance_amount::numeric, 0) * COALESCE(installment_count, 0)) AS financed_total
    FROM debt_target_cache
    WHERE section = ${section}
      AND due_date IS NOT NULL
      AND is_closed IS NOT TRUE
      AND is_future_period IS NOT TRUE
      AND is_suspended IS NOT TRUE
      AND is_bad_debt IS NOT TRUE
    GROUP BY TO_CHAR(due_date, 'YYYY-MM')
    ORDER BY due_month
  `);
    const targetRows: any[] = pgRows(targetResult);

  // ── 1b. Query overdue_total per due_month ──────────────────────────────────
  // ค้างชำระ: ยอดที่ค้างมาจากเดือนก่อนหน้า (due_date < เดือนนั้น)
  // นับเฉพาะ rows ที่ยังไม่ชำระ (paid_amount < total_amount) และไม่ถูกตัดออกด้วย is_closed/is_suspended/is_bad_debt
  // Group ตามเดือนถัดไปจาก due_month (คือเดือนที่ค้างจะไปปรากฏในตาราง)
  const overdueResult = await db.execute(sql`
    SELECT
      TO_CHAR(
        (DATE_TRUNC('month', due_date::date) + INTERVAL '1 month')::date,
        'YYYY-MM'
      ) AS overdue_month,
      SUM(GREATEST(COALESCE(total_amount::numeric, 0) - COALESCE(paid_amount::numeric, 0), 0)) AS overdue_total
    FROM debt_target_cache
    WHERE section = ${section}
      AND due_date IS NOT NULL
      AND is_closed IS NOT TRUE
      AND is_future_period IS NOT TRUE
      AND is_suspended IS NOT TRUE
      AND is_bad_debt IS NOT TRUE
      AND is_paid IS NOT TRUE
      AND COALESCE(paid_amount::numeric, 0) < COALESCE(total_amount::numeric, 0)
    GROUP BY DATE_TRUNC('month', due_date::date) + INTERVAL '1 month'
    ORDER BY overdue_month
  `);
  const overdueRows: any[] = pgRows(overdueResult);
  const overdueMap = new Map<string, number>();
  for (const row of overdueRows) {
    const m = String(row.overdue_month ?? "").slice(0, 7);
    if (m && m.length === 7) overdueMap.set(m, n(row.overdue_total));
  }

  // ── 2. Query collected aggregates per paid_at month from debt_collected_cache ─
  const collectedResult = await db.execute(sql`
    SELECT
      TO_CHAR(paid_at, 'YYYY-MM') AS paid_month,
      COUNT(DISTINCT contract_external_id) AS contract_count,
      SUM(total_amount::numeric) AS collected_amount,
      SUM(principal::numeric) AS collected_principal,
      SUM(interest::numeric) AS collected_interest,
      SUM(fee::numeric) AS collected_fee,
      SUM(penalty::numeric) AS collected_penalty,
      SUM(unlock_fee::numeric) AS collected_unlock_fee,
      SUM(discount::numeric) AS collected_discount,
      SUM(overpaid::numeric) AS collected_overpaid,
      SUM(bad_debt::numeric) AS collected_bad_debt
    FROM debt_collected_cache
    WHERE section = ${section}
      AND paid_at IS NOT NULL
      AND is_bad_debt_row IS NOT TRUE
    GROUP BY TO_CHAR(paid_at, 'YYYY-MM')
    ORDER BY paid_month
  `);
  const collectedRows: any[] = pgRows(collectedResult);

  // ── 3. Query ยอดขายเครื่อง จาก income_monthly_summary ────────────────────────
  const saleResult = await db.execute(sql`
    SELECT
      LPAD(year::text, 4, '0') || '-' || LPAD(month::text, 2, '0') AS paid_month,
      COALESCE(total_amount::numeric, 0) AS collected_sale
    FROM income_monthly_summary
    WHERE section = ${section}
      AND income_type = 'ขายเครื่อง'
    ORDER BY year, month
  `);
  const saleRows: any[] = pgRows(saleResult);
  const saleMap = new Map<string, number>();
  for (const row of saleRows) {
    saleMap.set(String(row.paid_month), n(row.collected_sale));
  }

  // ── 4. Merge into a map keyed by month ────────────────────────────────────────
  const monthMap = new Map<string, {
    targetAmount: number;
    targetContractCount: number;
    targetPrincipal: number;
    targetInterest: number;
    targetFee: number;
    targetPenalty: number;
    targetUnlockFee: number;
    installTotal: number;
    financedTotal: number;
    overdueTotal: number;
    collectedAmount: number;
    collectedContractCount: number;
    collectedPrincipal: number;
    collectedInterest: number;
    collectedFee: number;
    collectedPenalty: number;
    collectedUnlockFee: number;
    collectedDiscount: number;
    collectedOverpaid: number;
    collectedBadDebt: number;
  }>();

  // Initialize from target rows
  for (const row of targetRows) {
    const month = String(row.due_month ?? "").slice(0, 7);
    if (!month || month.length !== 7) continue;
    monthMap.set(month, {
      targetAmount: n(row.target_amount),
      targetContractCount: n(row.contract_count),
      targetPrincipal: n(row.target_principal),
      targetInterest: n(row.target_interest),
      targetFee: n(row.target_fee),
      targetPenalty: n(row.target_penalty),
      targetUnlockFee: n(row.target_unlock_fee),
      installTotal: n(row.install_total),
      financedTotal: n(row.financed_total),
      overdueTotal: overdueMap.get(month) ?? 0, // ค้างชำระจากเดือนก่อนหน้า
      collectedAmount: 0,
      collectedContractCount: 0,
      collectedPrincipal: 0,
      collectedInterest: 0,
      collectedFee: 0,
      collectedPenalty: 0,
      collectedUnlockFee: 0,
      collectedDiscount: 0,
      collectedOverpaid: 0,
      collectedBadDebt: 0,
    });
  }

  // Merge collected rows
  for (const row of collectedRows) {
    const month = String(row.paid_month ?? "").slice(0, 7);
    if (!month || month.length !== 7) continue;
    const existing = monthMap.get(month);
    if (existing) {
      existing.collectedAmount = n(row.collected_amount);
      existing.collectedContractCount = n(row.contract_count);
      existing.collectedPrincipal = n(row.collected_principal);
      existing.collectedInterest = n(row.collected_interest);
      existing.collectedFee = n(row.collected_fee);
      existing.collectedPenalty = n(row.collected_penalty);
      existing.collectedUnlockFee = n(row.collected_unlock_fee);
      existing.collectedDiscount = n(row.collected_discount);
      existing.collectedOverpaid = n(row.collected_overpaid);
      existing.collectedBadDebt = n(row.collected_bad_debt);
    } else {
      // เดือนที่มียอดเก็บแต่ไม่มีเป้า (เช่น เดือนเก่ามาก)
      monthMap.set(month, {
        targetAmount: 0,
        targetContractCount: 0,
        targetPrincipal: 0,
        targetInterest: 0,
        targetFee: 0,
        targetPenalty: 0,
        targetUnlockFee: 0,
        installTotal: 0,
        financedTotal: 0,
        overdueTotal: 0,
        collectedAmount: n(row.collected_amount),
        collectedContractCount: n(row.contract_count),
        collectedPrincipal: n(row.collected_principal),
        collectedInterest: n(row.collected_interest),
        collectedFee: n(row.collected_fee),
        collectedPenalty: n(row.collected_penalty),
        collectedUnlockFee: n(row.collected_unlock_fee),
        collectedDiscount: n(row.collected_discount),
        collectedOverpaid: n(row.collected_overpaid),
        collectedBadDebt: n(row.collected_bad_debt),
      });
    }
  }

  // ── 5. Fetch existing frozen status from DB ────────────────────────────────
  const existingResult = await db.execute(sql`
    SELECT collection_month, collected_is_frozen, target_frozen_at, collected_frozen_at
    FROM monthly_collection_snapshot
    WHERE section = ${section}
  `);
  const existingRows: any[] = pgRows(existingResult);
  const frozenMap = new Map<string, { isFrozen: boolean; targetFrozenAt: string | null; collectedFrozenAt: string | null }>();
  for (const row of existingRows) {
    frozenMap.set(String(row.collection_month), {
      isFrozen: Boolean(row.collected_is_frozen),
      targetFrozenAt: row.target_frozen_at ? String(row.target_frozen_at) : null,
      collectedFrozenAt: row.collected_frozen_at ? String(row.collected_frozen_at) : null,
    });
  }

  // ── 6. Upsert each month ──────────────────────────────────────────────────
  const months = Array.from(monthMap.keys()).sort();
  let upsertCount = 0;
  const total = months.length;

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const data = monthMap.get(month)!;
    const existing = frozenMap.get(month);
    const collectedSale = saleMap.get(month) ?? 0;

    // Freeze logic: เดือนที่ผ่านมาให้ freeze collected ครั้งแรกที่ sync เดือนถัดไป
    const isPastMonth = month < currentMonth;
    const isFrozen = existing?.isFrozen || isPastMonth;
    const targetFrozenAt = existing?.targetFrozenAt ?? (isPastMonth ? nowStr : null);
    const collectedFrozenAt = existing?.collectedFrozenAt ?? (isPastMonth ? nowStr : null);

    // ถ้าเดือนนั้น freeze แล้ว ไม่อัพเดทยอด collected (แต่ยังอัพเดท target ได้)
    const shouldUpdateCollected = !existing?.isFrozen;

    if (shouldUpdateCollected) {
      // Upsert ทั้ง target และ collected
      await db.execute(sql`
        INSERT INTO monthly_collection_snapshot (
          section, collection_month,
          target_amount, target_contract_count, target_frozen_at,
          target_principal, target_interest, target_fee, target_penalty, target_unlock_fee,
          collected_amount, collected_contract_count, collected_frozen_at, collected_is_frozen,
          collected_principal, collected_interest, collected_fee, collected_penalty,
          collected_unlock_fee, collected_discount, collected_overpaid, collected_bad_debt,
          install_total, financed_total, overdue_total, collected_sale, updated_at
        )
        VALUES (
          ${section}, ${month},
          ${data.targetAmount}, ${data.targetContractCount}, ${targetFrozenAt},
          ${data.targetPrincipal}, ${data.targetInterest}, ${data.targetFee},
          ${data.targetPenalty}, ${data.targetUnlockFee},
          ${data.collectedAmount}, ${data.collectedContractCount}, ${collectedFrozenAt}, ${isFrozen},
          ${data.collectedPrincipal}, ${data.collectedInterest}, ${data.collectedFee},
          ${data.collectedPenalty}, ${data.collectedUnlockFee},
          ${data.collectedDiscount}, ${data.collectedOverpaid}, ${data.collectedBadDebt},
          ${data.installTotal}, ${data.financedTotal}, ${data.overdueTotal}, ${collectedSale}, NOW()
        )
        ON CONFLICT (section, collection_month) DO UPDATE SET
          target_amount = EXCLUDED.target_amount,
          target_contract_count = EXCLUDED.target_contract_count,
          target_frozen_at = COALESCE(monthly_collection_snapshot.target_frozen_at, EXCLUDED.target_frozen_at),
          target_principal = EXCLUDED.target_principal,
          target_interest = EXCLUDED.target_interest,
          target_fee = EXCLUDED.target_fee,
          target_penalty = EXCLUDED.target_penalty,
          target_unlock_fee = EXCLUDED.target_unlock_fee,
          collected_amount = EXCLUDED.collected_amount,
          collected_contract_count = EXCLUDED.collected_contract_count,
          collected_frozen_at = COALESCE(monthly_collection_snapshot.collected_frozen_at, EXCLUDED.collected_frozen_at),
          collected_is_frozen = EXCLUDED.collected_is_frozen,
          collected_principal = EXCLUDED.collected_principal,
          collected_interest = EXCLUDED.collected_interest,
          collected_fee = EXCLUDED.collected_fee,
          collected_penalty = EXCLUDED.collected_penalty,
          collected_unlock_fee = EXCLUDED.collected_unlock_fee,
          collected_discount = EXCLUDED.collected_discount,
          collected_overpaid = EXCLUDED.collected_overpaid,
          collected_bad_debt = EXCLUDED.collected_bad_debt,
          install_total = EXCLUDED.install_total,
          financed_total = EXCLUDED.financed_total,
          overdue_total = EXCLUDED.overdue_total,
          collected_sale = EXCLUDED.collected_sale,
          updated_at = NOW()
      `);
    } else {
      // เดือน freeze แล้ว: อัพเดทเฉพาะ target (ไม่แตะ collected)
      await db.execute(sql`
        INSERT INTO monthly_collection_snapshot (
          section, collection_month,
          target_amount, target_contract_count, target_frozen_at,
          target_principal, target_interest, target_fee, target_penalty, target_unlock_fee,
          collected_amount, collected_contract_count, collected_frozen_at, collected_is_frozen,
          collected_principal, collected_interest, collected_fee, collected_penalty,
          collected_unlock_fee, collected_discount, collected_overpaid, collected_bad_debt,
          install_total, financed_total, overdue_total, collected_sale, updated_at
        )
        VALUES (
          ${section}, ${month},
          ${data.targetAmount}, ${data.targetContractCount}, ${targetFrozenAt},
          ${data.targetPrincipal}, ${data.targetInterest}, ${data.targetFee},
          ${data.targetPenalty}, ${data.targetUnlockFee},
          ${data.collectedAmount}, ${data.collectedContractCount}, ${collectedFrozenAt}, ${isFrozen},
          ${data.collectedPrincipal}, ${data.collectedInterest}, ${data.collectedFee},
          ${data.collectedPenalty}, ${data.collectedUnlockFee},
          ${data.collectedDiscount}, ${data.collectedOverpaid}, ${data.collectedBadDebt},
          ${data.installTotal}, ${data.financedTotal}, ${data.overdueTotal}, ${collectedSale}, NOW()
        )
        ON CONFLICT (section, collection_month) DO UPDATE SET
          target_amount = EXCLUDED.target_amount,
          target_contract_count = EXCLUDED.target_contract_count,
          target_frozen_at = COALESCE(monthly_collection_snapshot.target_frozen_at, EXCLUDED.target_frozen_at),
          target_principal = EXCLUDED.target_principal,
          target_interest = EXCLUDED.target_interest,
          target_fee = EXCLUDED.target_fee,
          target_penalty = EXCLUDED.target_penalty,
          target_unlock_fee = EXCLUDED.target_unlock_fee,
          install_total = EXCLUDED.install_total,
          financed_total = EXCLUDED.financed_total,
          updated_at = NOW()
      `);
    }

    upsertCount++;
    if (onProgress) onProgress(i + 1, total);
  }

  console.log(`[monthlySnapshot] ${section}: upserted ${upsertCount} months`);
  return upsertCount;
}

// ─── Query: Get all snapshot rows for a section ───────────────────────────────
/**
 * ดึง monthly_collection_snapshot ทั้งหมดของ section
 * เรียงจากเดือนล่าสุดไปเก่าสุด
 * กรองเฉพาะตั้งแต่ มิ.ย. 2569 (2026-06) เป็นต้นไป
 */
export async function getMonthlyCollectionSnapshots(
  section: SectionKey,
): Promise<MonthlyCollectionSnapshotRow[]> {
  const db = await getDb(section);
  if (!db) return [];

  const result = await db.execute(sql`
    SELECT
      collection_month,
      target_amount,
      target_contract_count,
      target_principal,
      target_interest,
      target_fee,
      target_penalty,
      target_unlock_fee,
      collected_amount,
      collected_contract_count,
      collected_principal,
      collected_interest,
      collected_fee,
      collected_penalty,
      collected_unlock_fee,
      collected_discount,
      collected_overpaid,
      collected_bad_debt,
      install_total,
      COALESCE(financed_total, 0)  AS financed_total,
      COALESCE(overdue_total, 0)   AS overdue_total,
      COALESCE(collected_sale, 0)  AS collected_sale,
      collected_is_frozen,
      target_frozen_at,
      collected_frozen_at,
      updated_at
    FROM monthly_collection_snapshot
    WHERE section = ${section}
      AND collection_month >= '2026-06'
    ORDER BY collection_month DESC
  `);

  const rows: any[] = pgRows(result);
  return rows.map((row) => ({
    collectionMonth: String(row.collection_month),
    targetAmount: n(row.target_amount),
    targetContractCount: n(row.target_contract_count),
    targetPrincipal: n(row.target_principal),
    targetInterest: n(row.target_interest),
    targetFee: n(row.target_fee),
    targetPenalty: n(row.target_penalty),
    targetUnlockFee: n(row.target_unlock_fee),
    collectedAmount: n(row.collected_amount),
    collectedContractCount: n(row.collected_contract_count),
    collectedPrincipal: n(row.collected_principal),
    collectedInterest: n(row.collected_interest),
    collectedFee: n(row.collected_fee),
    collectedPenalty: n(row.collected_penalty),
    collectedUnlockFee: n(row.collected_unlock_fee),
    collectedDiscount: n(row.collected_discount),
    collectedOverpaid: n(row.collected_overpaid),
    collectedBadDebt: n(row.collected_bad_debt),
    installTotal: n(row.install_total),
    financedTotal: n(row.financed_total),
    overdueTotal: n(row.overdue_total),
    collectedSale: n(row.collected_sale),
    collectedIsFrozen: Boolean(row.collected_is_frozen),
    targetFrozenAt: row.target_frozen_at ? String(row.target_frozen_at) : null,
    collectedFrozenAt: row.collected_frozen_at ? String(row.collected_frozen_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : "",
  }));
}

// ─── Query: Get detail rows for lightbox (target or collected) ─────────────────
/**
 * ดึง detail rows สำหรับ lightbox เป้าเก็บหนี้ (จาก debt_target_cache)
 * กรองตาม due_month = collectionMonth
 */
export async function getMonthlyTargetDetail(params: {
  section: SectionKey;
  collectionMonth: string; // YYYY-MM
  search?: string;
  productType?: string;
  debtRange?: string;
  offset?: number;
  limit?: number;
}): Promise<{ rows: any[]; total: number }> {
  const { section, collectionMonth, search, productType, debtRange, offset = 0, limit = 100 } = params;
  const db = await getDb(section);
  if (!db) return { rows: [], total: 0 };

  const conditions: string[] = [
    `section = '${section}'`,
    `TO_CHAR(due_date, 'YYYY-MM') = '${collectionMonth}'`,
    `is_closed IS NOT TRUE`,
    `is_future_period IS NOT TRUE`,
    `is_suspended IS NOT TRUE`,
    `is_bad_debt IS NOT TRUE`,
  ];

  if (search) {
    const escaped = search.replace(/'/g, "''").toLowerCase();
    conditions.push(`(LOWER(contract_no) LIKE '%${escaped}%' OR LOWER(customer_name) LIKE '%${escaped}%')`);
  }
  if (productType) {
    conditions.push(`product_type = '${productType.replace(/'/g, "''")}'`);
  }
  if (debtRange) {
    conditions.push(`debt_range = '${debtRange.replace(/'/g, "''")}'`);
  }

  const whereClause = conditions.join(" AND ");

  const countResult = await db.execute(sql.raw(`
    SELECT COUNT(DISTINCT contract_external_id) AS cnt
    FROM debt_target_cache
    WHERE ${whereClause}
  `));
  const countRows: any[] = pgRows(countResult);
  const total = n(countRows[0]?.cnt ?? 0);

  const dataResult = await db.execute(sql.raw(`
    SELECT
      contract_external_id,
      contract_no,
      customer_name,
      approve_date,
      product_type,
      due_date,
      period,
      total_amount,
      paid_amount,
      GREATEST(total_amount::numeric - paid_amount::numeric, 0) AS net_amount,
      principal,
      interest,
      fee,
      penalty,
      unlock_fee,
      baseline_amount,
      finance_amount,
      installment_count,
      is_paid,
      is_arrears,
      is_bad_debt,
      is_closed,
      is_suspended,
      debt_range,
      partner_code,
      partner_name,
      device,
      model,
      contract_status
    FROM debt_target_cache
    WHERE ${whereClause}
    ORDER BY contract_no, period
    LIMIT ${limit} OFFSET ${offset}
  `));
  const dataRows: any[] = pgRows(dataResult);

  return { rows: dataRows, total };
}

/**
 * ดึง detail rows สำหรับ lightbox ยอดเก็บหนี้ (จาก debt_collected_cache)
 * กรองตาม paid_at month = collectionMonth
 */
export async function getMonthlyCollectedDetail(params: {
  section: SectionKey;
  collectionMonth: string; // YYYY-MM
  search?: string;
  productType?: string;
  debtRange?: string;
  offset?: number;
  limit?: number;
}): Promise<{ rows: any[]; total: number }> {
  const { section, collectionMonth, search, productType, debtRange, offset = 0, limit = 100 } = params;
  const db = await getDb(section);
  if (!db) return { rows: [], total: 0 };

  const conditions: string[] = [
    `section = '${section}'`,
    `TO_CHAR(paid_at, 'YYYY-MM') = '${collectionMonth}'`,
    `is_bad_debt_row IS NOT TRUE`,
  ];

  if (search) {
    const escaped = search.replace(/'/g, "''").toLowerCase();
    conditions.push(`(LOWER(contract_no) LIKE '%${escaped}%' OR LOWER(customer_name) LIKE '%${escaped}%')`);
  }
  if (productType) {
    conditions.push(`product_type = '${productType.replace(/'/g, "''")}'`);
  }
  if (debtRange) {
    conditions.push(`debt_range = '${debtRange.replace(/'/g, "''")}'`);
  }

  const whereClause = conditions.join(" AND ");

  const countResult = await db.execute(sql.raw(`
    SELECT COUNT(DISTINCT contract_external_id) AS cnt
    FROM debt_collected_cache
    WHERE ${whereClause}
  `));
  const countRows: any[] = pgRows(countResult);
  const total = n(countRows[0]?.cnt ?? 0);

  const dataResult = await db.execute(sql.raw(`
    SELECT
      payment_external_id,
      contract_external_id,
      contract_no,
      customer_name,
      approve_date,
      product_type,
      paid_at,
      period_no,
      total_amount,
      principal,
      interest,
      fee,
      penalty,
      unlock_fee,
      discount,
      overpaid,
      bad_debt,
      payment_tx_amount,
      debt_range,
      partner_code,
      partner_name,
      device,
      model,
      contract_status,
      finance_amount,
      installment_count,
      remark
    FROM debt_collected_cache
    WHERE ${whereClause}
    ORDER BY contract_no, paid_at
    LIMIT ${limit} OFFSET ${offset}
  `));
  const dataRows: any[] = pgRows(dataResult);

  return { rows: dataRows, total };
}

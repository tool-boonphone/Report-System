/**
 * noticeDb.ts — Database helpers สำหรับระบบหนังสือแจ้งเตือน (Notice)
 *
 * Phase 1 (อ่านอย่างเดียว):
 *  - ดึงรายชื่อลูกค้าเช่าซื้อที่ค้างชำระตั้งแต่ 60 วันขึ้นไป (ตาม spec ข้อ 2.1)
 *  - รายการที่ "ได้เครื่องคืนแล้ว" (status = ระงับสัญญา) ยังคงแสดงในตาราง
 *    แต่จะถูกล็อกไม่ให้พิมพ์ Notice เพิ่มในเฟสถัดไป
 *
 * ยังไม่รวม (รอเฟสถัดไป):
 *  - Log การพิมพ์ / Log การแก้ไข (Restore) — Phase 2
 *  - การ Generate PDF + Excel จ่าหน้าซอง — Phase 3
 *  - สถิติรายเดือน — Phase 4
 *
 * หมายเหตุการคำนวณวันค้างชำระ (NOTICE_OVERDUE_DAYS_SQL):
 *  - ใช้สูตรเดียวกับหน้าสัญญา (approveDate + paymentDay + paidInstallments)
 *  - ต่างจาก OVERDUE_DAYS_SQL เดิมตรงที่ "ไม่" reset เป็น NULL สำหรับสถานะ
 *    'หนี้เสีย' และ 'ระงับสัญญา' เพื่อให้รายการที่ได้เครื่องคืนแล้ว (ระงับสัญญา)
 *    และหนี้เสียที่ยังค้างชำระยังคงปรากฏในตาราง Notice
 *  - reset เป็น NULL เฉพาะสถานะที่ปิดจบจริง ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')
 */
import { and, asc, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { contracts } from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

/** สถานะที่ถือว่า "ได้เครื่องคืนแล้ว" (อัตโนมัติจาก status = ระงับสัญญา) */
const RETURNED_STATUS = "ระงับสัญญา";

/** สถานะที่ปิดจบสัญญาแล้ว — ไม่ต้องออก Notice และไม่นับวันค้างชำระ */
const CLOSED_STATUSES = ["สิ้นสุดสัญญา", "ยกเลิกสัญญา"] as const;

/**
 * วันค้างชำระสำหรับ Notice — คำนวณจากงวดแรกที่ค้าง
 * (reset เป็น NULL เฉพาะสถานะปิดจบสัญญา)
 */
const NOTICE_OVERDUE_DAYS_SQL = sql<number | null>`CASE
  WHEN contracts.debt_type IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')
    OR contracts.status IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา') THEN NULL
  WHEN contracts.approve_date IS NULL OR contracts.payment_day IS NULL THEN NULL
  ELSE GREATEST(0, CURRENT_DATE - (
    DATE_TRUNC('month', (contracts.approve_date::text)::date)
    + INTERVAL '1 month' * (COALESCE(contracts.paid_installments, 0) + 1)
    + (contracts.payment_day - 1) * INTERVAL '1 day'
  )::date)
END`;

/** true เมื่อรายการนี้ได้เครื่องคืนแล้ว (status หรือ debt_type = ระงับสัญญา) */
const IS_RETURNED_SQL = sql<boolean>`(contracts.status = ${RETURNED_STATUS} OR contracts.debt_type = ${RETURNED_STATUS})`;

/** เกณฑ์ขั้นต่ำของวันค้างชำระที่จะแสดงในระบบ Notice */
export const NOTICE_MIN_OVERDUE_DAYS = 60;

export type NoticeReturnedFilter = "all" | "hide" | "only";

export type NoticeFilters = {
  /** ค้นหาจาก ชื่อ-นามสกุล หรือ เลขที่สัญญา */
  search?: string;
  /** กรองสถานะได้เครื่องคืน: all (ทั้งหมด) | hide (ซ่อน) | only (เฉพาะคืนแล้ว) */
  returned?: NoticeReturnedFilter;
  /** ช่วงวันอนุมัติสัญญา (YYYY-MM-DD) */
  approveDateFrom?: string;
  approveDateTo?: string;
  /** ช่วงวันค้างชำระ (ค่าขั้นต่ำระบบคือ 60) */
  overdueMin?: number;
  overdueMax?: number;
};

export type NoticeSortField = "approveDate" | "overdueDays";
export type NoticeSort = {
  field?: NoticeSortField;
  dir?: "asc" | "desc";
};

export type NoticeRow = {
  id: number;
  contractNo: string;
  approveDate: string | null;
  customerName: string | null;
  overdueDays: number | null;
  isReturned: boolean;
  /** จำนวนครั้งที่ส่ง Notice แล้ว — Phase 1 ยังไม่มี log จึงเป็น 0 เสมอ */
  sentCount: number;
};

function buildNoticeWhere(section: SectionKey, f: NoticeFilters): SQL {
  const min = Math.max(NOTICE_MIN_OVERDUE_DAYS, f.overdueMin ?? NOTICE_MIN_OVERDUE_DAYS);
  const clauses: SQL[] = [
    eq(contracts.section, section),
    // ตัดสถานะที่ปิดจบสัญญาออก
    sql`COALESCE(contracts.status, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
    sql`COALESCE(contracts.debt_type, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
    // ค้างชำระตั้งแต่เกณฑ์ขั้นต่ำขึ้นไป
    sql`${NOTICE_OVERDUE_DAYS_SQL} >= ${min}`,
  ];

  if (f.overdueMax != null) {
    clauses.push(sql`${NOTICE_OVERDUE_DAYS_SQL} <= ${f.overdueMax}`);
  }

  const q = f.search?.trim();
  if (q) {
    const pattern = `%${q}%`;
    clauses.push(
      or(like(contracts.contractNo, pattern), like(contracts.customerName, pattern))!,
    );
  }

  if (f.returned === "hide") {
    clauses.push(sql`NOT ${IS_RETURNED_SQL}`);
  } else if (f.returned === "only") {
    clauses.push(sql`${IS_RETURNED_SQL}`);
  }

  if (f.approveDateFrom) clauses.push(sql`contracts.approve_date >= ${f.approveDateFrom}`);
  if (f.approveDateTo) clauses.push(sql`contracts.approve_date <= ${f.approveDateTo}`);

  return and(...clauses)!;
}

function resolveNoticeOrder(sort: NoticeSort | undefined): SQL {
  const dir = sort?.dir === "asc" ? asc : desc;
  if (sort?.field === "overdueDays") {
    return sort.dir === "asc"
      ? sql`${NOTICE_OVERDUE_DAYS_SQL} ASC NULLS FIRST`
      : sql`${NOTICE_OVERDUE_DAYS_SQL} DESC NULLS LAST`;
  }
  // default: วันอนุมัติจากใหม่ไปเก่า
  return dir(contracts.approveDate) as unknown as SQL;
}

/**
 * ดึงรายการลูกค้าที่เข้าเงื่อนไขส่ง Notice (ค้างชำระ ≥ 60 วัน) แบบ server-side pagination
 */
export async function listNoticeContracts(params: {
  section: SectionKey;
  filters?: NoticeFilters;
  sort?: NoticeSort;
  page: number;
  pageSize: number;
}): Promise<{ rows: NoticeRow[]; total: number; hasMore: boolean }> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return { rows: [], total: 0, hasMore: false };

  const where = buildNoticeWhere(section, params.filters ?? {});
  const orderBy = resolveNoticeOrder(params.sort);
  const pageSize = Math.max(1, Math.min(200, params.pageSize));
  const offset = Math.max(0, (params.page - 1) * pageSize);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: contracts.id,
        contractNo: contracts.contractNo,
        approveDate: contracts.approveDate,
        customerName: contracts.customerName,
        overdueDays: NOTICE_OVERDUE_DAYS_SQL,
        isReturned: IS_RETURNED_SQL,
      })
      .from(contracts)
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset),
    db.select({ c: sql<number>`count(*)` }).from(contracts).where(where),
  ]);

  const total = Number(countRow?.c ?? 0);
  type RawRow = {
    id: number;
    contractNo: string;
    approveDate: string | null;
    customerName: string | null;
    overdueDays: number | null;
    isReturned: boolean | null;
  };
  const mapped: NoticeRow[] = (rows as RawRow[]).map((r) => ({
    id: r.id,
    contractNo: r.contractNo,
    approveDate: r.approveDate ?? null,
    customerName: r.customerName ?? null,
    overdueDays: r.overdueDays != null ? Number(r.overdueDays) : null,
    isReturned: Boolean(r.isReturned),
    sentCount: 0,
  }));

  return { rows: mapped, total, hasMore: offset + mapped.length < total };
}

/**
 * สรุปภาพรวมสำหรับการ์ดด้านบนของหน้า Notice
 *  - eligible: จำนวนลูกค้าที่ค้างชำระ ≥ 60 วันทั้งหมด (ตามฟิลเตอร์ที่กรอง)
 *  - returned: จำนวนลูกค้าที่ได้เครื่องคืนแล้ว (ภายในกลุ่ม eligible)
 */
export async function getNoticeSummary(params: {
  section: SectionKey;
  filters?: NoticeFilters;
}): Promise<{ eligible: number; returned: number }> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return { eligible: 0, returned: 0 };

  // summary ไม่สนใจฟิลเตอร์ returned (เพื่อให้นับ returned แยกได้ครบ)
  const baseFilters: NoticeFilters = { ...(params.filters ?? {}), returned: "all" };
  const where = buildNoticeWhere(section, baseFilters);

  const [row] = await db
    .select({
      eligible: sql<number>`count(*)`,
      returned: sql<number>`count(*) FILTER (WHERE ${IS_RETURNED_SQL})`,
    })
    .from(contracts)
    .where(where);

  return {
    eligible: Number(row?.eligible ?? 0),
    returned: Number(row?.returned ?? 0),
  };
}

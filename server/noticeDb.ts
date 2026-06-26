/**
 * noticeDb.ts — Database helpers สำหรับระบบหนังสือแจ้งเตือน (Notice)
 *
 * Phase 2:
 *  - ดึงรายชื่อลูกค้าค้างชำระ ≥ 60 วัน พร้อม sentCount + Log การพิมพ์ + Log การแก้ไข
 *  - บันทึกการพิมพ์ (recordPrint) → สร้าง batch + print log + นับรอบ (สูงสุด 3)
 *  - ยกเลิกรอบล่าสุด (restoreLatest) → ลบ print log รอบล่าสุด + บันทึก restore log
 *
 * การนับรอบ:
 *  - sentCount = จำนวน notice_print_logs ที่เหลืออยู่ของสัญญานั้น
 *  - notice_round ของการพิมพ์ใหม่ = sentCount ปัจจุบัน + 1
 *  - Restore ยกเลิกได้เฉพาะรอบล่าสุด (ลบ log รอบที่มากที่สุด)
 *
 * "ได้เครื่องคืนแล้ว" = status = 'ระงับสัญญา' (อัตโนมัติ) → แสดงในตารางแต่พิมพ์ไม่ได้
 *
 * หมายเหตุการคำนวณวันค้างชำระ (NOTICE_OVERDUE_DAYS_SQL):
 *  - ใช้สูตรเดียวกับหน้าสัญญา (approveDate + paymentDay + paidInstallments)
 *  - ไม่ reset เป็น NULL สำหรับ 'หนี้เสีย'/'ระงับสัญญา' (ให้รายการคืนเครื่อง/หนี้เสียที่ค้างยังแสดง)
 *  - reset เป็น NULL เฉพาะ 'สิ้นสุดสัญญา'/'ยกเลิกสัญญา'
 */
import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import {
  contracts,
  noticePrintBatches,
  noticePrintLogs,
  noticeRestoreLogs,
} from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

const RETURNED_STATUS = "ระงับสัญญา";
export const MAX_NOTICE_ROUNDS = 3;
export const NOTICE_MIN_OVERDUE_DAYS = 60;

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

const IS_RETURNED_SQL = sql<boolean>`(contracts.status = ${RETURNED_STATUS} OR contracts.debt_type = ${RETURNED_STATUS})`;

/** sentCount ของสัญญา (นับจาก notice_print_logs ที่เหลืออยู่) */
function sentCountSql(section: SectionKey): SQL<number> {
  return sql<number>`(
    SELECT COUNT(*) FROM notice_print_logs npl
    WHERE npl.section = ${section} AND npl.contract_external_id = contracts.external_id
  )`;
}

export type NoticeReturnedFilter = "all" | "hide" | "only";
export type NoticeSentFilter = "all" | "0" | "1" | "2" | "3";

export type NoticeFilters = {
  search?: string;
  returned?: NoticeReturnedFilter;
  sent?: NoticeSentFilter;
  admin?: string;
  approveDateFrom?: string;
  approveDateTo?: string;
  overdueMin?: number;
  overdueMax?: number;
};

export type NoticeSortField = "approveDate" | "overdueDays" | "sentCount";
export type NoticeSort = { field?: NoticeSortField; dir?: "asc" | "desc" };

export type NoticePrintLogEntry = { round: number; printedAt: string; printedBy: string };
export type NoticeRestoreLogEntry = { round: number; restoredAt: string; restoredBy: string };

export type NoticeRow = {
  externalId: string;
  contractNo: string;
  approveDate: string | null;
  customerName: string | null;
  overdueDays: number | null;
  isReturned: boolean;
  sentCount: number;
  printLogs: NoticePrintLogEntry[];
  restoreLogs: NoticeRestoreLogEntry[];
};

function buildNoticeWhere(section: SectionKey, f: NoticeFilters): SQL {
  const min = Math.max(NOTICE_MIN_OVERDUE_DAYS, f.overdueMin ?? NOTICE_MIN_OVERDUE_DAYS);
  const sc = sentCountSql(section);
  const clauses: SQL[] = [
    eq(contracts.section, section),
    sql`COALESCE(contracts.status, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
    sql`COALESCE(contracts.debt_type, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
    sql`${NOTICE_OVERDUE_DAYS_SQL} >= ${min}`,
  ];

  if (f.overdueMax != null) clauses.push(sql`${NOTICE_OVERDUE_DAYS_SQL} <= ${f.overdueMax}`);

  const q = f.search?.trim();
  if (q) {
    const pattern = `%${q}%`;
    clauses.push(or(like(contracts.contractNo, pattern), like(contracts.customerName, pattern))!);
  }

  if (f.returned === "hide") clauses.push(sql`NOT ${IS_RETURNED_SQL}`);
  else if (f.returned === "only") clauses.push(sql`${IS_RETURNED_SQL}`);

  if (f.sent && f.sent !== "all") {
    const n = parseInt(f.sent, 10);
    clauses.push(sql`${sc} = ${n}`);
  }

  if (f.admin && f.admin !== "all") {
    clauses.push(sql`(
      EXISTS (SELECT 1 FROM notice_print_logs npl WHERE npl.section = ${section}
        AND npl.contract_external_id = contracts.external_id AND npl.printed_by = ${f.admin})
      OR EXISTS (SELECT 1 FROM notice_restore_logs nrl WHERE nrl.section = ${section}
        AND nrl.contract_external_id = contracts.external_id AND nrl.restored_by = ${f.admin})
    )`);
  }

  if (f.approveDateFrom) clauses.push(sql`contracts.approve_date >= ${f.approveDateFrom}`);
  if (f.approveDateTo) clauses.push(sql`contracts.approve_date <= ${f.approveDateTo}`);

  return and(...clauses)!;
}

function resolveNoticeOrder(section: SectionKey, sort: NoticeSort | undefined): SQL {
  const dir = sort?.dir === "asc" ? asc : desc;
  if (sort?.field === "overdueDays") {
    return sort.dir === "asc"
      ? sql`${NOTICE_OVERDUE_DAYS_SQL} ASC NULLS FIRST`
      : sql`${NOTICE_OVERDUE_DAYS_SQL} DESC NULLS LAST`;
  }
  if (sort?.field === "sentCount") {
    const sc = sentCountSql(section);
    return sort.dir === "asc" ? sql`${sc} ASC` : sql`${sc} DESC`;
  }
  return dir(contracts.approveDate) as unknown as SQL;
}

/** ดึงรายการลูกค้าที่เข้าเงื่อนไขส่ง Notice พร้อม sentCount + logs (server-side pagination) */
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
  const orderBy = resolveNoticeOrder(section, params.sort);
  const pageSize = Math.max(1, Math.min(1000, params.pageSize));
  const offset = Math.max(0, (params.page - 1) * pageSize);
  const sc = sentCountSql(section);

  const [baseRows, [countRow]] = await Promise.all([
    db
      .select({
        externalId: contracts.externalId,
        contractNo: contracts.contractNo,
        approveDate: contracts.approveDate,
        customerName: contracts.customerName,
        overdueDays: NOTICE_OVERDUE_DAYS_SQL,
        isReturned: IS_RETURNED_SQL,
        sentCount: sc,
      })
      .from(contracts)
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset),
    db.select({ c: sql<number>`count(*)` }).from(contracts).where(where),
  ]);

  type Base = {
    externalId: string;
    contractNo: string;
    approveDate: string | null;
    customerName: string | null;
    overdueDays: number | null;
    isReturned: boolean | null;
    sentCount: number | string | null;
  };
  const rowsBase = baseRows as Base[];
  const total = Number(countRow?.c ?? 0);

  // ดึง logs ของเฉพาะ externalId ในหน้านี้
  const ids = rowsBase.map((r) => r.externalId);
  const printByContract = new Map<string, NoticePrintLogEntry[]>();
  const restoreByContract = new Map<string, NoticeRestoreLogEntry[]>();

  if (ids.length > 0) {
    const [pLogs, rLogs] = await Promise.all([
      db
        .select({
          contractExternalId: noticePrintLogs.contractExternalId,
          round: noticePrintLogs.noticeRound,
          printedAt: noticePrintLogs.printedAt,
          printedBy: noticePrintLogs.printedBy,
        })
        .from(noticePrintLogs)
        .where(and(eq(noticePrintLogs.section, section), inArray(noticePrintLogs.contractExternalId, ids)))
        .orderBy(asc(noticePrintLogs.noticeRound)),
      db
        .select({
          contractExternalId: noticeRestoreLogs.contractExternalId,
          round: noticeRestoreLogs.noticeRound,
          restoredAt: noticeRestoreLogs.restoredAt,
          restoredBy: noticeRestoreLogs.restoredBy,
        })
        .from(noticeRestoreLogs)
        .where(and(eq(noticeRestoreLogs.section, section), inArray(noticeRestoreLogs.contractExternalId, ids)))
        .orderBy(asc(noticeRestoreLogs.restoredAt)),
    ]);

    for (const l of pLogs as Array<{ contractExternalId: string; round: number; printedAt: Date; printedBy: string }>) {
      const arr = printByContract.get(l.contractExternalId) ?? [];
      arr.push({ round: l.round, printedAt: new Date(l.printedAt).toISOString(), printedBy: l.printedBy });
      printByContract.set(l.contractExternalId, arr);
    }
    for (const l of rLogs as Array<{ contractExternalId: string; round: number; restoredAt: Date; restoredBy: string }>) {
      const arr = restoreByContract.get(l.contractExternalId) ?? [];
      arr.push({ round: l.round, restoredAt: new Date(l.restoredAt).toISOString(), restoredBy: l.restoredBy });
      restoreByContract.set(l.contractExternalId, arr);
    }
  }

  const rows: NoticeRow[] = rowsBase.map((r) => ({
    externalId: r.externalId,
    contractNo: r.contractNo,
    approveDate: r.approveDate ?? null,
    customerName: r.customerName ?? null,
    overdueDays: r.overdueDays != null ? Number(r.overdueDays) : null,
    isReturned: Boolean(r.isReturned),
    sentCount: Number(r.sentCount ?? 0),
    printLogs: printByContract.get(r.externalId) ?? [],
    restoreLogs: restoreByContract.get(r.externalId) ?? [],
  }));

  return { rows, total, hasMore: offset + rows.length < total };
}

/**
 * สรุปภาพรวมสำหรับการ์ดด้านบน:
 *  - eligible: ลูกค้าค้างชำระ ≥ 60 วันทั้งหมด (ตามฟิลเตอร์ ยกเว้น returned/sent/admin)
 *  - returned: ได้เครื่องคืนแล้ว
 *  - never / inProgress / maxed: แยกตาม sentCount (เฉพาะรายการที่ยังพิมพ์ได้ = ไม่คืนเครื่อง)
 */
export async function getNoticeSummary(params: {
  section: SectionKey;
  filters?: NoticeFilters;
}): Promise<{ eligible: number; returned: number; never: number; inProgress: number; maxed: number }> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return { eligible: 0, returned: 0, never: 0, inProgress: 0, maxed: 0 };

  // นับภาพรวมจากชุดเดียวกัน (ไม่กรอง returned/sent/admin เพื่อให้นับครบ)
  const baseFilters: NoticeFilters = {
    search: params.filters?.search,
    approveDateFrom: params.filters?.approveDateFrom,
    approveDateTo: params.filters?.approveDateTo,
    overdueMin: params.filters?.overdueMin,
    overdueMax: params.filters?.overdueMax,
    returned: "all",
  };
  const where = buildNoticeWhere(section, baseFilters);
  const sc = sentCountSql(section);

  const [row] = await db
    .select({
      eligible: sql<number>`count(*)`,
      returned: sql<number>`count(*) FILTER (WHERE ${IS_RETURNED_SQL})`,
      never: sql<number>`count(*) FILTER (WHERE NOT ${IS_RETURNED_SQL} AND ${sc} = 0)`,
      inProgress: sql<number>`count(*) FILTER (WHERE NOT ${IS_RETURNED_SQL} AND ${sc} > 0 AND ${sc} < ${MAX_NOTICE_ROUNDS})`,
      maxed: sql<number>`count(*) FILTER (WHERE NOT ${IS_RETURNED_SQL} AND ${sc} >= ${MAX_NOTICE_ROUNDS})`,
    })
    .from(contracts)
    .where(where);

  return {
    eligible: Number(row?.eligible ?? 0),
    returned: Number(row?.returned ?? 0),
    never: Number(row?.never ?? 0),
    inProgress: Number(row?.inProgress ?? 0),
    maxed: Number(row?.maxed ?? 0),
  };
}

/** รายชื่อแอดมินที่เคยพิมพ์/Restore (สำหรับ dropdown ฟิลเตอร์) */
export async function getNoticeAdminOptions(section: SectionKey): Promise<string[]> {
  const db = await getDb(section);
  if (!db) return [];
  const [pRows, rRows] = await Promise.all([
    db
      .selectDistinct({ name: noticePrintLogs.printedBy })
      .from(noticePrintLogs)
      .where(eq(noticePrintLogs.section, section)),
    db
      .selectDistinct({ name: noticeRestoreLogs.restoredBy })
      .from(noticeRestoreLogs)
      .where(eq(noticeRestoreLogs.section, section)),
  ]);
  const names = new Set<string>();
  for (const r of pRows as Array<{ name: string }>) if (r.name) names.add(r.name);
  for (const r of rRows as Array<{ name: string }>) if (r.name) names.add(r.name);
  return Array.from(names).sort((a, b) => a.localeCompare(b, "th"));
}

export type NoticePrintData = {
  externalId: string;
  contractNo: string;
  customerName: string | null;
  phone: string | null;
  addrDistrict: string | null;
  addrProvince: string | null;
  model: string | null;
  imei: string | null;
  serialNo: string | null;
  approveDate: string | null;
  installmentAmount: number | null;
  installmentCount: number | null;
  paidInstallments: number | null;
  overdueDays: number | null;
  sentCount: number;
};

/**
 * ดึงข้อมูลรายสัญญาสำหรับ generate เอกสาร Notice + Excel จ่าหน้าซอง
 * คืนเฉพาะรายการที่ "พิมพ์ได้จริง" (≥60 วัน, ไม่คืนเครื่อง, ยังส่งไม่ครบ 3)
 * เรียงตามเลขที่สัญญาเพื่อให้ลำดับใน PDF/Excel คงที่
 */
export async function getNoticePrintData(params: {
  section: SectionKey;
  externalIds: string[];
}): Promise<NoticePrintData[]> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return [];
  const ids = Array.from(new Set(params.externalIds)).filter(Boolean);
  if (ids.length === 0) return [];

  const sc = sentCountSql(section);
  const rows = (await db
    .select({
      externalId: contracts.externalId,
      contractNo: contracts.contractNo,
      customerName: contracts.customerName,
      phone: contracts.phone,
      addrDistrict: contracts.addrDistrict,
      addrProvince: contracts.addrProvince,
      model: contracts.model,
      imei: contracts.imei,
      serialNo: contracts.serialNo,
      approveDate: contracts.approveDate,
      installmentAmount: contracts.installmentAmount,
      installmentCount: contracts.installmentCount,
      paidInstallments: contracts.paidInstallments,
      overdueDays: NOTICE_OVERDUE_DAYS_SQL,
      sentCount: sc,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.section, section),
        inArray(contracts.externalId, ids),
        sql`COALESCE(contracts.status, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
        sql`COALESCE(contracts.debt_type, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
        sql`NOT ${IS_RETURNED_SQL}`,
        sql`${NOTICE_OVERDUE_DAYS_SQL} >= ${NOTICE_MIN_OVERDUE_DAYS}`,
        sql`${sc} < ${MAX_NOTICE_ROUNDS}`,
      ),
    )
    .orderBy(asc(contracts.contractNo))) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    externalId: String(r.externalId),
    contractNo: String(r.contractNo),
    customerName: (r.customerName as string) ?? null,
    phone: (r.phone as string) ?? null,
    addrDistrict: (r.addrDistrict as string) ?? null,
    addrProvince: (r.addrProvince as string) ?? null,
    model: (r.model as string) ?? null,
    imei: (r.imei as string) ?? null,
    serialNo: (r.serialNo as string) ?? null,
    approveDate: (r.approveDate as string) ?? null,
    installmentAmount: r.installmentAmount != null ? Number(r.installmentAmount) : null,
    installmentCount: r.installmentCount != null ? Number(r.installmentCount) : null,
    paidInstallments: r.paidInstallments != null ? Number(r.paidInstallments) : null,
    overdueDays: r.overdueDays != null ? Number(r.overdueDays) : null,
    sentCount: Number(r.sentCount ?? 0),
  }));
}

/**
 * บันทึกการพิมพ์ Notice (นับรอบ) ของหลายสัญญาในครั้งเดียว
 * - ตรวจ server-side: ต้องค้างชำระ ≥ 60 วัน, ยังไม่คืนเครื่อง, ยังส่งไม่ครบ 3 ครั้ง
 * - สร้าง 1 batch + insert print log (round = sentCount+1) ของแต่ละสัญญาที่ผ่านเงื่อนไข
 *
 * @returns { batchId, printedCount, skipped } — skipped = externalId ที่ทำไม่ได้
 */
export async function recordNoticePrint(params: {
  section: SectionKey;
  externalIds: string[];
  operator: string;
  pdfFileUrl?: string | null;
  excelFileUrl?: string | null;
}): Promise<{ batchId: number | null; printedCount: number; skipped: string[] }> {
  const { section, operator } = params;
  const db = await getDb(section);
  if (!db) return { batchId: null, printedCount: 0, skipped: params.externalIds };

  const ids = Array.from(new Set(params.externalIds)).filter(Boolean);
  if (ids.length === 0) return { batchId: null, printedCount: 0, skipped: [] };

  const sc = sentCountSql(section);
  // ดึงเฉพาะสัญญาที่พิมพ์ได้จริง (eligible + ยังไม่คืนเครื่อง + ยังส่งไม่ครบ)
  const eligible = (await db
    .select({
      externalId: contracts.externalId,
      contractNo: contracts.contractNo,
      sentCount: sc,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.section, section),
        inArray(contracts.externalId, ids),
        sql`COALESCE(contracts.status, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
        sql`COALESCE(contracts.debt_type, '') NOT IN ('สิ้นสุดสัญญา', 'ยกเลิกสัญญา')`,
        sql`NOT ${IS_RETURNED_SQL}`,
        sql`${NOTICE_OVERDUE_DAYS_SQL} >= ${NOTICE_MIN_OVERDUE_DAYS}`,
        sql`${sc} < ${MAX_NOTICE_ROUNDS}`,
      ),
    )) as Array<{ externalId: string; contractNo: string; sentCount: number | string | null }>;

  const eligibleSet = new Set(eligible.map((e) => e.externalId));
  const skipped = ids.filter((id) => !eligibleSet.has(id));
  if (eligible.length === 0) return { batchId: null, printedCount: 0, skipped };

  const [batch] = await db
    .insert(noticePrintBatches)
    .values({
      section,
      printedBy: operator,
      totalItems: eligible.length,
      pdfFileUrl: params.pdfFileUrl ?? null,
      excelFileUrl: params.excelFileUrl ?? null,
    })
    .returning({ id: noticePrintBatches.id });

  const batchId = batch?.id ?? null;

  await db.insert(noticePrintLogs).values(
    eligible.map((e) => ({
      section,
      contractExternalId: e.externalId,
      contractNo: e.contractNo,
      noticeRound: Number(e.sentCount ?? 0) + 1,
      printedBy: operator,
      batchId: batchId ?? undefined,
      pdfFileUrl: params.pdfFileUrl ?? null,
      excelFileUrl: params.excelFileUrl ?? null,
    })),
  );

  return { batchId, printedCount: eligible.length, skipped };
}

/**
 * ยกเลิก (Restore) รอบส่งล่าสุดของ 1 สัญญา
 * - อนุญาตเฉพาะรอบล่าสุด (ลบ print log รอบที่มากที่สุด)
 * - บันทึก restore log
 */
export async function restoreLatestNoticeRound(params: {
  section: SectionKey;
  externalId: string;
  operator: string;
  reason?: string | null;
}): Promise<{ ok: boolean; restoredRound: number | null; message?: string }> {
  const { section, externalId, operator } = params;
  const db = await getDb(section);
  if (!db) return { ok: false, restoredRound: null, message: "database unavailable" };

  const logs = (await db
    .select({
      id: noticePrintLogs.id,
      round: noticePrintLogs.noticeRound,
      contractNo: noticePrintLogs.contractNo,
    })
    .from(noticePrintLogs)
    .where(
      and(eq(noticePrintLogs.section, section), eq(noticePrintLogs.contractExternalId, externalId)),
    )
    .orderBy(desc(noticePrintLogs.noticeRound))) as Array<{ id: number; round: number; contractNo: string | null }>;

  if (logs.length === 0) {
    return { ok: false, restoredRound: null, message: "ไม่มีรอบส่งให้ยกเลิก" };
  }

  const latest = logs[0];
  await db.delete(noticePrintLogs).where(eq(noticePrintLogs.id, latest.id));
  await db.insert(noticeRestoreLogs).values({
    section,
    contractExternalId: externalId,
    contractNo: latest.contractNo,
    noticeRound: latest.round,
    restoredBy: operator,
    reason: params.reason ?? null,
  });

  return { ok: true, restoredRound: latest.round };
}

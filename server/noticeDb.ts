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
  noticeContractDoc,
  noticePrintBatches,
  noticePrintLogs,
  noticeRestoreLogs,
} from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb, pgRows } from "./db";
import { ensureNoticeSchema, formatDocumentNo } from "./notice/noticeSchema";

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
  /** กรอง sentCount ขั้นต่ำ (ใช้ export — เฉพาะที่มีประวัติส่ง) */
  minSentCount?: number;
};

export type NoticeSortField = "approveDate" | "overdueDays" | "sentCount";
export type NoticeSort = { field?: NoticeSortField; dir?: "asc" | "desc" };

export type NoticePrintLogEntry = { round: number; documentNo: string | null; printedAt: string; printedBy: string };
export type NoticeRestoreLogEntry = { round: number; restoredAt: string; restoredBy: string };

export type NoticeRow = {
  externalId: string;
  contractNo: string;
  approveDate: string | null;
  customerName: string | null;
  overdueDays: number | null;
  isReturned: boolean;
  sentCount: number;
  documentNo: string | null;
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
    clauses.push(
      or(
        like(contracts.contractNo, pattern),
        like(contracts.customerName, pattern),
        sql`EXISTS (
          SELECT 1 FROM notice_print_logs npl_s
          WHERE npl_s.section = ${section}
            AND npl_s.contract_external_id = contracts.external_id
            AND npl_s.document_no ILIKE ${pattern}
        )`,
      )!,
    );
  }

  if (f.returned === "hide") clauses.push(sql`NOT ${IS_RETURNED_SQL}`);
  else if (f.returned === "only") clauses.push(sql`${IS_RETURNED_SQL}`);

  if (f.sent && f.sent !== "all") {
    const n = parseInt(f.sent, 10);
    clauses.push(sql`${sc} = ${n}`);
  }

  if (f.minSentCount != null && f.minSentCount > 0) {
    clauses.push(sql`${sc} >= ${f.minSentCount}`);
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
  await ensureNoticeSchema(section);
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
          documentNo: noticePrintLogs.documentNo,
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

    for (const l of pLogs as Array<{ contractExternalId: string; round: number; documentNo: string | null; printedAt: Date; printedBy: string }>) {
      const arr = printByContract.get(l.contractExternalId) ?? [];
      arr.push({
        round: l.round,
        documentNo: l.documentNo ?? null,
        printedAt: new Date(l.printedAt).toISOString(),
        printedBy: l.printedBy,
      });
      printByContract.set(l.contractExternalId, arr);
    }
    for (const l of rLogs as Array<{ contractExternalId: string; round: number; restoredAt: Date; restoredBy: string }>) {
      const arr = restoreByContract.get(l.contractExternalId) ?? [];
      arr.push({ round: l.round, restoredAt: new Date(l.restoredAt).toISOString(), restoredBy: l.restoredBy });
      restoreByContract.set(l.contractExternalId, arr);
    }
  }

  const rows: NoticeRow[] = rowsBase.map((r) => {
    const logs = printByContract.get(r.externalId) ?? [];
    const latestDoc = logs.length > 0 ? (logs[logs.length - 1]?.documentNo ?? null) : null;
    return {
      externalId: r.externalId,
      contractNo: r.contractNo,
      approveDate: r.approveDate ?? null,
      customerName: r.customerName ?? null,
      overdueDays: r.overdueDays != null ? Number(r.overdueDays) : null,
      isReturned: Boolean(r.isReturned),
      sentCount: Number(r.sentCount ?? 0),
      documentNo: latestDoc,
      printLogs: logs,
      restoreLogs: restoreByContract.get(r.externalId) ?? [],
    };
  });

  return { rows, total, hasMore: offset + rows.length < total };
}

/** ดึงรายการสำหรับ export — เฉพาะที่มีประวัติส่ง (sentCount ≥ 1), ไม่จำกัด pagination มาก */
export async function listNoticeForExport(params: {
  section: SectionKey;
  filters?: NoticeFilters;
  sort?: NoticeSort;
}): Promise<NoticeRow[]> {
  const { rows } = await listNoticeContracts({
    section: params.section,
    filters: { ...params.filters, minSentCount: 1 },
    sort: params.sort,
    page: 1,
    pageSize: 50000,
  });
  return rows;
}

export type NoticeImportPreview = {
  parsedRows: number;
  toInsert: number;
  skipNoContract: number;
  skipDuplicate: number;
  sample: Array<{ contractNo: string; round: number; documentNo: string }>;
};

export type NoticeImportResult = NoticeImportPreview & { imported: number; skipped: number };

/**
 * นำเข้าประวัติ Notice จาก Excel (คอลัมน์ตาม import-sample)
 * dryRun=true → คืน preview ไม่เขียน DB
 */
export async function importNoticeHistorical(params: {
  section: SectionKey;
  rows: Array<{
    contractNo: string;
    documentNo: string;
    round: number;
    printedAt: string;
    printedBy: string;
  }>;
  dryRun?: boolean;
}): Promise<NoticeImportResult> {
  const { section, rows } = params;
  await ensureNoticeSchema(section);
  const db = await getDb(section);
  if (!db) throw new Error("database unavailable");

  let toInsert = 0;
  let skipNoContract = 0;
  let skipDuplicate = 0;
  const sample: NoticeImportPreview["sample"] = [];

  type Pending = (typeof rows)[0] & { externalId: string };
  const pending: Pending[] = [];

  for (const r of rows) {
    const [contract] = (await db
      .select({ externalId: contracts.externalId })
      .from(contracts)
      .where(and(eq(contracts.section, section), eq(contracts.contractNo, r.contractNo)))
      .limit(1)) as Array<{ externalId: string }>;

    if (!contract) {
      skipNoContract++;
      continue;
    }

    const [existing] = (await db
      .select({ id: noticePrintLogs.id })
      .from(noticePrintLogs)
      .where(
        and(
          eq(noticePrintLogs.section, section),
          eq(noticePrintLogs.contractExternalId, contract.externalId),
          eq(noticePrintLogs.noticeRound, r.round),
        ),
      )
      .limit(1)) as Array<{ id: number }>;

    if (existing) {
      skipDuplicate++;
      continue;
    }

    toInsert++;
    pending.push({ ...r, externalId: contract.externalId });
    if (sample.length < 8) {
      sample.push({ contractNo: r.contractNo, round: r.round, documentNo: r.documentNo });
    }
  }

  const preview: NoticeImportResult = {
    parsedRows: rows.length,
    toInsert,
    skipNoContract,
    skipDuplicate,
    sample,
    imported: 0,
    skipped: skipNoContract + skipDuplicate,
  };

  if (params.dryRun || pending.length === 0) return preview;

  let maxDocNum = 0;
  for (const r of pending) {
    await db.insert(noticePrintLogs).values({
      section,
      contractExternalId: r.externalId,
      contractNo: r.contractNo,
      noticeRound: r.round,
      documentNo: r.documentNo || null,
      printedBy: r.printedBy,
      printedAt: new Date(r.printedAt),
    });

    if (r.documentNo) {
      const num = parseInt(r.documentNo.replace(/\D/g, ""), 10);
      if (Number.isFinite(num)) maxDocNum = Math.max(maxDocNum, num);
      await db
        .insert(noticeContractDoc)
        .values({ section, contractExternalId: r.externalId, documentNo: r.documentNo })
        .onConflictDoNothing({
          target: [noticeContractDoc.section, noticeContractDoc.contractExternalId],
        });
    }
  }

  if (maxDocNum > 0) {
    await db.execute(sql`
      INSERT INTO notice_document_counters (section, next_value)
      VALUES (${section}, ${maxDocNum + 1})
      ON CONFLICT (section) DO UPDATE
      SET next_value = GREATEST(notice_document_counters.next_value, ${maxDocNum + 1})
    `);
  }

  return { ...preview, imported: pending.length, skipped: skipNoContract + skipDuplicate };
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
  documentNo: string;
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
    documentNo: "",
  }));
}

/** จัดสรรเลขที่เอกสารก่อนสร้าง PDF/Excel (2B: หนึ่งเลขต่อสัญญา, 5B: reuse หลัง restore) */
export async function allocateDocumentNumbers(params: {
  section: SectionKey;
  items: Array<{ externalId: string; nextRound: number }>;
}): Promise<Map<string, string>> {
  const { section, items } = params;
  await ensureNoticeSchema(section);
  const db = await getDb(section);
  const out = new Map<string, string>();
  if (!db || items.length === 0) return out;

  const ids = items.map((i) => i.externalId);
  const existing = (await db
    .select({
      contractExternalId: noticeContractDoc.contractExternalId,
      documentNo: noticeContractDoc.documentNo,
    })
    .from(noticeContractDoc)
    .where(and(eq(noticeContractDoc.section, section), inArray(noticeContractDoc.contractExternalId, ids)))) as Array<{
    contractExternalId: string;
    documentNo: string;
  }>;
  const byContract = new Map(existing.map((e) => [e.contractExternalId, e.documentNo]));

  for (const item of items) {
    const cached = byContract.get(item.externalId);
    if (cached) {
      out.set(item.externalId, cached);
      continue;
    }

    // 5B: reuse เลขจาก restore log ของรอบที่กำลังจะพิมพ์
    const [restored] = (await db
      .select({ documentNo: noticeRestoreLogs.documentNo })
      .from(noticeRestoreLogs)
      .where(
        and(
          eq(noticeRestoreLogs.section, section),
          eq(noticeRestoreLogs.contractExternalId, item.externalId),
          eq(noticeRestoreLogs.noticeRound, item.nextRound),
        ),
      )
      .orderBy(desc(noticeRestoreLogs.restoredAt))
      .limit(1)) as Array<{ documentNo: string | null }>;

    if (restored?.documentNo) {
      out.set(item.externalId, restored.documentNo);
      await db
        .insert(noticeContractDoc)
        .values({ section, contractExternalId: item.externalId, documentNo: restored.documentNo })
        .onConflictDoNothing({
          target: [noticeContractDoc.section, noticeContractDoc.contractExternalId],
        });
      byContract.set(item.externalId, restored.documentNo);
      continue;
    }

    const counterResult = await db.execute(sql`
      UPDATE notice_document_counters
      SET next_value = next_value + 1
      WHERE section = ${section}
      RETURNING next_value - 1 AS allocated
    `);
    const allocated = Number(pgRows(counterResult)[0]?.allocated ?? 1);
    const docNo = formatDocumentNo(allocated);
    out.set(item.externalId, docNo);
    await db.insert(noticeContractDoc).values({
      section,
      contractExternalId: item.externalId,
      documentNo: docNo,
    });
    byContract.set(item.externalId, docNo);
  }

  return out;
}

/** ผูกเลขที่เอกสารกับข้อมูลพิมพ์ */
export function attachDocumentNumbers(
  records: NoticePrintData[],
  docNos: Map<string, string>,
): NoticePrintData[] {
  return records.map((r) => ({ ...r, documentNo: docNos.get(r.externalId) ?? r.documentNo }));
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
  documentNos?: Map<string, string>;
}): Promise<{ batchId: number | null; printedCount: number; skipped: string[] }> {
  const { section, operator } = params;
  await ensureNoticeSchema(section);
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
      documentNo: params.documentNos?.get(e.externalId) ?? null,
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
  await ensureNoticeSchema(section);
  const db = await getDb(section);
  if (!db) return { ok: false, restoredRound: null, message: "database unavailable" };

  const logs = (await db
    .select({
      id: noticePrintLogs.id,
      round: noticePrintLogs.noticeRound,
      contractNo: noticePrintLogs.contractNo,
      documentNo: noticePrintLogs.documentNo,
    })
    .from(noticePrintLogs)
    .where(
      and(eq(noticePrintLogs.section, section), eq(noticePrintLogs.contractExternalId, externalId)),
    )
    .orderBy(desc(noticePrintLogs.noticeRound))) as Array<{ id: number; round: number; contractNo: string | null; documentNo: string | null }>;

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
    documentNo: latest.documentNo,
    restoredBy: operator,
    reason: params.reason ?? null,
  });

  return { ok: true, restoredRound: latest.round };
}

const THAI_MONTH_SHORT = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

function monthKeyToLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  const be = y + 543;
  return `${THAI_MONTH_SHORT[m - 1] ?? monthKey} ${String(be % 100).padStart(2, "0")}`;
}

export type NoticeMonthlyStatsRow = {
  monthKey: string;
  monthLabel: string;
  totalSent: number;
  round1: number;
  round2: number;
  round3: number;
  returned: number;
  proportion: number;
};

export type NoticeMonthlyStats = {
  subtitle: string;
  totalSent: number;
  avgPerMonth: number;
  latestMonthLabel: string | null;
  latestMonthSent: number;
  latestMonthHint: string;
  totalReturned: number;
  months: NoticeMonthlyStatsRow[];
};

/** สถิติการส่ง Notice รายเดือน (จาก notice_print_logs จริง) */
export async function getNoticeMonthlyStats(section: SectionKey): Promise<NoticeMonthlyStats> {
  await ensureNoticeSchema(section);
  const db = await getDb(section);
  const empty: NoticeMonthlyStats = {
    subtitle: "ยังไม่มีข้อมูลการส่ง Notice",
    totalSent: 0,
    avgPerMonth: 0,
    latestMonthLabel: null,
    latestMonthSent: 0,
    latestMonthHint: "",
    totalReturned: 0,
    months: [],
  };
  if (!db) return empty;

  const printRows = pgRows(
    await db.execute(sql`
      SELECT
        to_char(date_trunc('month', printed_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM') AS month_key,
        COUNT(*)::int AS total_sent,
        COUNT(*) FILTER (WHERE notice_round = 1)::int AS round1,
        COUNT(*) FILTER (WHERE notice_round = 2)::int AS round2,
        COUNT(*) FILTER (WHERE notice_round = 3)::int AS round3
      FROM notice_print_logs
      WHERE section = ${section}
      GROUP BY 1
      ORDER BY 1
    `),
  ) as Array<{ month_key: string; total_sent: number; round1: number; round2: number; round3: number }>;

  const returnRows = pgRows(
    await db.execute(sql`
      SELECT
        to_char(date_trunc('month', COALESCE(
          NULLIF(TRIM(c.bad_debt_date), '')::date,
          c.synced_at::date
        )), 'YYYY-MM') AS month_key,
        COUNT(DISTINCT c.external_id)::int AS returned
      FROM contracts c
      WHERE c.section = ${section}
        AND (c.status = ${RETURNED_STATUS} OR c.debt_type = ${RETURNED_STATUS})
        AND EXISTS (
          SELECT 1 FROM notice_print_logs npl
          WHERE npl.section = c.section AND npl.contract_external_id = c.external_id
        )
      GROUP BY 1
    `),
  ) as Array<{ month_key: string; returned: number }>;

  const returnedByMonth = new Map(returnRows.map((r) => [r.month_key, Number(r.returned ?? 0)]));
  const maxSent = printRows.reduce((m, r) => Math.max(m, Number(r.total_sent ?? 0)), 0);

  const months: NoticeMonthlyStatsRow[] = printRows.map((r) => {
    const totalSent = Number(r.total_sent ?? 0);
    return {
      monthKey: r.month_key,
      monthLabel: monthKeyToLabel(r.month_key),
      totalSent,
      round1: Number(r.round1 ?? 0),
      round2: Number(r.round2 ?? 0),
      round3: Number(r.round3 ?? 0),
      returned: returnedByMonth.get(r.month_key) ?? 0,
      proportion: maxSent > 0 ? Math.round((totalSent / maxSent) * 100) : 0,
    };
  });

  const totalSent = months.reduce((s, m) => s + m.totalSent, 0);
  const totalReturned = months.reduce((s, m) => s + m.returned, 0);
  const latest = months[months.length - 1] ?? null;
  const firstLabel = months[0] ? months[0].monthLabel : null;

  return {
    subtitle: firstLabel
      ? `ข้อมูลตั้งแต่ ${firstLabel} จนถึงปัจจุบัน`
      : "ยังไม่มีข้อมูลการส่ง Notice",
    totalSent,
    avgPerMonth: months.length > 0 ? Math.round(totalSent / months.length) : 0,
    latestMonthLabel: latest?.monthLabel ?? null,
    latestMonthSent: latest?.totalSent ?? 0,
    latestMonthHint: latest ? "เดือนล่าสุดที่มีการส่ง" : "",
    totalReturned,
    months,
  };
}

/**
 * ล้างข้อมูล Notice ทั้งหมดของ section (สำหรับทดสอบ — ไม่แตะ contracts)
 * ลบ print/restore logs, batches, contract doc mapping และรีเซ็ตเลขที่เอกสารเป็น 0001
 */
export async function clearAllNoticeData(section: SectionKey): Promise<{
  printLogs: number;
  restoreLogs: number;
  batches: number;
  contractDocs: number;
}> {
  await ensureNoticeSchema(section);
  const db = await getDb(section);
  if (!db) throw new Error("database unavailable");

  const [printLogs, restoreLogs, batches, contractDocs] = await Promise.all([
    db.delete(noticePrintLogs).where(eq(noticePrintLogs.section, section)).returning({ id: noticePrintLogs.id }),
    db.delete(noticeRestoreLogs).where(eq(noticeRestoreLogs.section, section)).returning({ id: noticeRestoreLogs.id }),
    db.delete(noticePrintBatches).where(eq(noticePrintBatches.section, section)).returning({ id: noticePrintBatches.id }),
    db.delete(noticeContractDoc).where(eq(noticeContractDoc.section, section)).returning({ id: noticeContractDoc.id }),
  ]);

  await db.execute(sql`
    INSERT INTO notice_document_counters (section, next_value)
    VALUES (${section}, 1)
    ON CONFLICT (section) DO UPDATE SET next_value = 1
  `);

  return {
    printLogs: printLogs.length,
    restoreLogs: restoreLogs.length,
    batches: batches.length,
    contractDocs: contractDocs.length,
  };
}

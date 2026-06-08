/**
 * Database helpers for contract listing, searching, and exporting.
 *
 * The contracts table already holds denormalized rows for both sections
 * (Boonphone + Fastfone365) differentiated by the `section` column, so a single
 * set of helpers works for both.
 */
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { contracts, deviceLocationLogs, type Contract } from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

export type ContractFilters = {
  search?: string; // free-text across contract_no / customer / partner / phone / imei
  status?: string;
  debtStatus?: string; // กรองตาม debtType field (alias เป็น debtStatus ใน UI)
  /** @deprecated ใช้ debtStatus แทน — ยังคงรองรับเพื่อ backward compatibility */
  debtType?: string;
  partnerCode?: string;
  dateField?: "submitDate" | "approveDate";
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
};

export type ContractSort = {
  /** one of the Contract columns. Defaults to approveDate desc. */
  field?:
    | "contractNo"
    | "submitDate"
    | "approveDate"
    | "status"
    | "customerName"
    | "partnerCode";
  dir?: "asc" | "desc";
};

/**
 * คำนวณ overdueDays (วันเกินกำหนดนับจากงวดแรกที่ค้าง) จาก approveDate + paymentDay + paidInstallments
 *
 * Logic:
 * - firstDueDate = วันที่ paymentDay ของเดือนถัดจาก approveDate
 * - ถ้า paidInstallments > 0 → เลื่อน firstDueDate ไปข้างหน้า paidInstallments เดือน
 * - overdueDays = วันปัจจุบัน - firstDueDate (ถ้า > 0 แสดงว่าเกินกำหนด)
 * - ถ้า debtType เป็น terminal status → overdueDays = 0
 *
 * หมายเหตุ: ใช้ SQL expression เพื่อคำนวณใน DB โดยตรง
 */
const OVERDUE_DAYS_SQL = sql<number | null>`CASE WHEN contracts.debt_type IN ('ระงับสัญญา', 'สิ้นสุดสัญญา', 'หนี้เสีย', 'ยกเลิกสัญญา') THEN NULL WHEN contracts.approve_date IS NULL OR contracts.payment_day IS NULL THEN NULL ELSE GREATEST(0, CURRENT_DATE - (DATE_TRUNC('month', TO_DATE(contracts.approve_date, 'YYYY-MM-DD')) + INTERVAL '1 month' * (COALESCE(contracts.paid_installments, 0) + 1) + (contracts.payment_day - 1) * INTERVAL '1 day')::date) END`;

function buildWhere(section: SectionKey, f: ContractFilters) {
  const clauses = [eq(contracts.section, section)];

  const q = f.search?.trim();
  if (q) {
    const pattern = `%${q}%`;
    clauses.push(
      or(
        like(contracts.contractNo, pattern),
        like(contracts.customerName, pattern),
        like(contracts.partnerCode, pattern),
        like(contracts.phone, pattern),
        like(contracts.imei, pattern),
        like(contracts.serialNo, pattern),
        like(contracts.citizenId, pattern),
      )!,
    );
  }
  if (f.status) clauses.push(eq(contracts.status, f.status));
  // debtStatus (ใหม่) หรือ debtType (เก่า) กรองจาก field เดียวกัน (debt_type)
  const debtFilter = f.debtStatus ?? f.debtType;
  if (debtFilter) clauses.push(eq(contracts.debtType, debtFilter));
  if (f.partnerCode) clauses.push(eq(contracts.partnerCode, f.partnerCode));

  if (f.dateField && (f.dateFrom || f.dateTo)) {
    const col =
      f.dateField === "submitDate" ? contracts.submitDate : contracts.approveDate;
    if (f.dateFrom) clauses.push(sql`${col} >= ${f.dateFrom}`);
    if (f.dateTo) clauses.push(sql`${col} <= ${f.dateTo}`);
  }
  return and(...clauses);
}

function resolveOrder(sort: ContractSort | undefined) {
  const dir = sort?.dir === "asc" ? asc : desc;
  switch (sort?.field) {
    case "contractNo":
      return dir(contracts.contractNo);
    case "submitDate":
      return dir(contracts.submitDate);
    case "status":
      return dir(contracts.status);
    case "customerName":
      return dir(contracts.customerName);
    case "partnerCode":
      return dir(contracts.partnerCode);
    case "approveDate":
    default:
      return dir(contracts.approveDate);
  }
}

/**
 * Return ALL contracts for a section without pagination, projected to the
 * columns we actually render on the table. This intentionally omits the
 * `rawJson` column because it nearly doubles payload size (~2.4 MB) without
 * being shown to the user. The client-side virtual scroller in
 * `pages/Contracts.tsx` consumes this and handles search/filter/sort on the
 * browser for a snappy "no pagination" feel.
 */
export async function listAllContracts(params: {
  section: SectionKey;
}): Promise<Array<Omit<Contract, "rawJson"> & { debtStatus: string | null; overdueDays: number | null }>> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return [];
  const rows = await db
    .select({
      id: contracts.id,
      section: contracts.section,
      externalId: contracts.externalId,
      contractNo: contracts.contractNo,
      submitDate: contracts.submitDate,
      approveDate: contracts.approveDate,
      partnerCode: contracts.partnerCode,
      partnerName: contracts.partnerName,
      partnerProvince: contracts.partnerProvince,
      partnerStatus: contracts.partnerStatus,
      channel: contracts.channel,
      status: contracts.status,
      debtType: contracts.debtType,
      // debtStatus: alias ของ debtType สำหรับ UI ใหม่
      debtStatus: contracts.debtType,
      // overdueDays: คำนวณจาก approveDate + paymentDay + paidInstallments
      overdueDays: OVERDUE_DAYS_SQL,
      promotionName: contracts.promotionName,
      device: contracts.device,
      productType: contracts.productType,
      model: contracts.model,
      imei: contracts.imei,
      serialNo: contracts.serialNo,
      sellPrice: contracts.sellPrice,
      deviceStatus: contracts.deviceStatus,
      lastOnlineDays: contracts.lastOnlineDays,
      lastOnlineAt: contracts.lastOnlineAt,
      deviceLock: contracts.deviceLock,
      lossStatus: contracts.lossStatus,     // MDM Lost Mode (0=ปกติ, 1=Lost Mode — ดึง GPS ได้)
      mdmDeviceId: contracts.mdmDeviceId,   // MDM internal ID สำหรับดึง GPS location
      // จำนวน location log ที่มีอยู่ (0 = ไม่มี, >0 = มี → ไอคอน MapPin สีเขียว)
      locationLogCount: sql<number>`(
        SELECT COUNT(*) FROM device_location_logs dll
        WHERE dll.section = ${params.section}
          AND dll.serial_no = contracts.serial_no
      )`,
      downPayment: contracts.downPayment,
      financeAmount: contracts.financeAmount,
      commissionNet: contracts.commissionNet,
      installmentCount: contracts.installmentCount,
      multiplier: contracts.multiplier,
      installmentAmount: contracts.installmentAmount,
      paymentDay: contracts.paymentDay,
      paidInstallments: contracts.paidInstallments,
      customerName: contracts.customerName,
      nationality: contracts.nationality,
      citizenId: contracts.citizenId,
      gender: contracts.gender,
      age: contracts.age,
      occupation: contracts.occupation,
      salary: contracts.salary,
      workplace: contracts.workplace,
      phone: contracts.phone,
      idDistrict: contracts.idDistrict,
      idProvince: contracts.idProvince,
      addrDistrict: contracts.addrDistrict,
      addrProvince: contracts.addrProvince,
      workDistrict: contracts.workDistrict,
      workProvince: contracts.workProvince,
      syncedAt: contracts.syncedAt,
    })
    .from(contracts)
    .where(eq(contracts.section, params.section))
    .orderBy(desc(contracts.approveDate));
  return rows as any;
}

/**
 * Return a chunk of contracts for chunked loading with progress tracking.
 * Used by DataLoadingScreen to show "X / Y สัญญา (Z%)" progress.
 * First call (offset=0) also returns the total count; subsequent calls reuse
 * the total returned by the first call to avoid repeated COUNT queries.
 */
export async function listContractChunk(params: {
  section: SectionKey;
  offset: number;
  limit: number;
}): Promise<{ rows: Array<Omit<Contract, "rawJson"> & { debtStatus: string | null; overdueDays: number | null }>; total: number; hasMore: boolean }> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return { rows: [], total: 0, hasMore: false };
  const where = eq(contracts.section, params.section);
  // Count total rows (cheap — indexed on section)
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contracts)
    .where(where);
  const total = Number(countRow?.count ?? 0);
  // Fetch chunk
  const rows = await db
    .select({
      id: contracts.id,
      section: contracts.section,
      externalId: contracts.externalId,
      contractNo: contracts.contractNo,
      submitDate: contracts.submitDate,
      approveDate: contracts.approveDate,
      partnerCode: contracts.partnerCode,
      partnerName: contracts.partnerName,
      partnerProvince: contracts.partnerProvince,
      partnerStatus: contracts.partnerStatus,
      channel: contracts.channel,
      status: contracts.status,
      debtType: contracts.debtType,
      // debtStatus: alias ของ debtType สำหรับ UI ใหม่
      debtStatus: contracts.debtType,
      // overdueDays: คำนวณจาก approveDate + paymentDay + paidInstallments
      overdueDays: OVERDUE_DAYS_SQL,
      promotionName: contracts.promotionName,
      device: contracts.device,
      productType: contracts.productType,
      model: contracts.model,
      imei: contracts.imei,
      serialNo: contracts.serialNo,
      sellPrice: contracts.sellPrice,
      deviceStatus: contracts.deviceStatus,
      lastOnlineDays: contracts.lastOnlineDays,
      lastOnlineAt: contracts.lastOnlineAt,
      deviceLock: contracts.deviceLock,
      lossStatus: contracts.lossStatus,     // MDM Lost Mode (0=ปกติ, 1=Lost Mode — ดึง GPS ได้)
      mdmDeviceId: contracts.mdmDeviceId,   // MDM internal ID สำหรับดึง GPS location
      // จำนวน location log ที่มีอยู่ (0 = ไม่มี, >0 = มี → ไอคอน MapPin สีเขียว)
      locationLogCount: sql<number>`(
        SELECT COUNT(*) FROM device_location_logs dll
        WHERE dll.section = ${params.section}
          AND dll.serial_no = contracts.serial_no
      )`,
      downPayment: contracts.downPayment,
      financeAmount: contracts.financeAmount,
      commissionNet: contracts.commissionNet,
      installmentCount: contracts.installmentCount,
      multiplier: contracts.multiplier,
      installmentAmount: contracts.installmentAmount,
      paymentDay: contracts.paymentDay,
      paidInstallments: contracts.paidInstallments,
      customerName: contracts.customerName,
      nationality: contracts.nationality,
      citizenId: contracts.citizenId,
      gender: contracts.gender,
      age: contracts.age,
      occupation: contracts.occupation,
      salary: contracts.salary,
      workplace: contracts.workplace,
      phone: contracts.phone,
      idDistrict: contracts.idDistrict,
      idProvince: contracts.idProvince,
      addrDistrict: contracts.addrDistrict,
      addrProvince: contracts.addrProvince,
      workDistrict: contracts.workDistrict,
      workProvince: contracts.workProvince,
      syncedAt: contracts.syncedAt,
    })
    .from(contracts)
    .where(where)
    .orderBy(desc(contracts.approveDate))
    .limit(params.limit)
    .offset(params.offset);
  return {
    rows: rows as any,
    total,
    hasMore: params.offset + rows.length < total,
  };
}

export async function listContracts(params: {
  section: SectionKey;
  filters?: ContractFilters;
  sort?: ContractSort;
  page: number;
  pageSize: number;
}) {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return { rows: [] as Contract[], total: 0 };

  const where = buildWhere(params.section, params.filters ?? {});
  const orderBy = resolveOrder(params.sort);

  const offset = Math.max(0, (params.page - 1) * params.pageSize);
  const limit = Math.max(1, Math.min(200, params.pageSize));

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(contracts)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ c: sql<number>`count(*)` })
      .from(contracts)
      .where(where),
  ]);

  return { rows, total: Number(countRow?.c ?? 0) };
}

/**
 * Stream contracts in batches — used by the Excel exporter to avoid loading
 * hundreds of thousands of rows into memory at once.
 * ส่งคืน debtStatus (alias ของ debtType) และ overdueDays (computed) ด้วย
 */
export async function* iterateContracts(params: {
  section: SectionKey;
  filters?: ContractFilters;
  sort?: ContractSort;
  batchSize?: number;
}): AsyncGenerator<Array<Contract & { debtStatus: string | null; overdueDays: number | null }>> {
  const { section } = params;
  const db = await getDb(section);
  if (!db) return;

  const batchSize = params.batchSize ?? 1000;
  const where = buildWhere(params.section, params.filters ?? {});
  const orderBy = resolveOrder(params.sort);

  let offset = 0;
  while (true) {
    const batch = await db
      .select({
        id: contracts.id,
        section: contracts.section,
        externalId: contracts.externalId,
        contractNo: contracts.contractNo,
        submitDate: contracts.submitDate,
        approveDate: contracts.approveDate,
        partnerCode: contracts.partnerCode,
        partnerName: contracts.partnerName,
        partnerProvince: contracts.partnerProvince,
        partnerStatus: contracts.partnerStatus,
        channel: contracts.channel,
        status: contracts.status,
        debtType: contracts.debtType,
        debtStatus: contracts.debtType, // alias สำหรับ export
        overdueDays: OVERDUE_DAYS_SQL,  // computed field
        promotionName: contracts.promotionName,
        device: contracts.device,
        productType: contracts.productType,
        model: contracts.model,
        imei: contracts.imei,
        serialNo: contracts.serialNo,
        sellPrice: contracts.sellPrice,
        deviceStatus: contracts.deviceStatus,
        lastOnlineDays: contracts.lastOnlineDays,
        lastOnlineAt: contracts.lastOnlineAt,
        deviceLock: contracts.deviceLock,
        lossStatus: contracts.lossStatus,
        mdmDeviceId: contracts.mdmDeviceId,
        downPayment: contracts.downPayment,
        financeAmount: contracts.financeAmount,
        commissionNet: contracts.commissionNet,
        installmentCount: contracts.installmentCount,
        multiplier: contracts.multiplier,
        installmentAmount: contracts.installmentAmount,
        paymentDay: contracts.paymentDay,
        paidInstallments: contracts.paidInstallments,
        customerName: contracts.customerName,
        nationality: contracts.nationality,
        citizenId: contracts.citizenId,
        gender: contracts.gender,
        age: contracts.age,
        occupation: contracts.occupation,
        salary: contracts.salary,
        workplace: contracts.workplace,
        phone: contracts.phone,
        idDistrict: contracts.idDistrict,
        idProvince: contracts.idProvince,
        addrDistrict: contracts.addrDistrict,
        addrProvince: contracts.addrProvince,
        workDistrict: contracts.workDistrict,
        workProvince: contracts.workProvince,
        syncedAt: contracts.syncedAt,
        rawJson: contracts.rawJson,
        badDebtAmount: contracts.badDebtAmount,
        badDebtDate: contracts.badDebtDate,
        suspendedFromPeriod: contracts.suspendedFromPeriod,
        badDebtUpdatedBy: contracts.badDebtUpdatedBy,
        badDebtUpdatedAt: contracts.badDebtUpdatedAt,
      })
      .from(contracts)
      .where(where)
      .orderBy(orderBy)
      .limit(batchSize)
      .offset(offset);
    if (!batch.length) return;
    yield batch as any;
    if (batch.length < batchSize) return;
    offset += batchSize;
  }
}

/** Distinct picker values for filter dropdowns (cheap thanks to indexes). */
export async function listContractFilterOptions(section: SectionKey) {
  const db = await getDb(section);
  if (!db) return { statuses: [], debtTypes: [], debtStatuses: [], partnerCodes: [] };
  const [statuses, debtTypes, partnerCodes] = await Promise.all([
    db
      .selectDistinct({ v: contracts.status })
      .from(contracts)
      .where(eq(contracts.section, section)),
    db
      .selectDistinct({ v: contracts.debtType })
      .from(contracts)
      .where(eq(contracts.section, section)),
    db
      .selectDistinct({ v: contracts.partnerCode })
      .from(contracts)
      .where(eq(contracts.section, section)),
  ]);
  const clean = (rows: Array<{ v: string | null }>) =>
    rows
      .map((r) => r.v)
      .filter((v): v is string => !!v && v.trim() !== "")
      .sort((a, b) => a.localeCompare(b, "th"));
  const cleanedDebtTypes = clean(debtTypes);
  return {
    statuses: clean(statuses),
    debtTypes: cleanedDebtTypes,
    debtStatuses: cleanedDebtTypes, // alias ใหม่ (ชื่อเดียวกับ debtTypes แต่ใช้ key ใหม่)
    partnerCodes: clean(partnerCodes),
  };
}

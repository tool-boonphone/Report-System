/**
 * Database helpers for contract listing, searching, and exporting.
 *
 * The contracts table already holds denormalized rows for both sections
 * (Boonphone + Fastfone365) differentiated by the `section` column, so a single
 * set of helpers works for both.
 */
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { contracts, type Contract } from "../drizzle/schema";
import type { SectionKey } from "../shared/const";
import { getDb } from "./db";

export type ContractFilters = {
  search?: string; // free-text across contract_no / customer / partner / phone / imei
  status?: string;
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
  if (f.debtType) clauses.push(eq(contracts.debtType, f.debtType));
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
}): Promise<Array<Omit<Contract, "rawJson">>> {
  const db = await getDb();
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
      promotionName: contracts.promotionName,
      device: contracts.device,
      productType: contracts.productType,
      model: contracts.model,
      imei: contracts.imei,
      serialNo: contracts.serialNo,
      sellPrice: contracts.sellPrice,
      deviceStatus: contracts.deviceStatus,
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
  return rows as Array<Omit<Contract, "rawJson">>;
}

export async function listContracts(params: {
  section: SectionKey;
  filters?: ContractFilters;
  sort?: ContractSort;
  page: number;
  pageSize: number;
}) {
  const db = await getDb();
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
 */
export async function* iterateContracts(params: {
  section: SectionKey;
  filters?: ContractFilters;
  sort?: ContractSort;
  batchSize?: number;
}): AsyncGenerator<Contract[]> {
  const db = await getDb();
  if (!db) return;

  const batchSize = params.batchSize ?? 1000;
  const where = buildWhere(params.section, params.filters ?? {});
  const orderBy = resolveOrder(params.sort);

  let offset = 0;
  while (true) {
    const batch = await db
      .select()
      .from(contracts)
      .where(where)
      .orderBy(orderBy)
      .limit(batchSize)
      .offset(offset);
    if (!batch.length) return;
    yield batch;
    if (batch.length < batchSize) return;
    offset += batchSize;
  }
}

/** Distinct picker values for filter dropdowns (cheap thanks to indexes). */
export async function listContractFilterOptions(section: SectionKey) {
  const db = await getDb();
  if (!db) return { statuses: [], debtTypes: [], partnerCodes: [] };
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
  return {
    statuses: clean(statuses),
    debtTypes: clean(debtTypes),
    partnerCodes: clean(partnerCodes),
  };
}

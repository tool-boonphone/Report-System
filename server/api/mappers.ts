/**
 * Field mappers between the partner API response shape and the DB rows.
 *
 * Both Boonphone and Fastfone365 expose the same schema on
 * `partner.{domain}.co.th`, so a single set of mappers serves both sections.
 * Each function returns `InsertRow` objects ready to be passed to the
 * drizzle `.insert().onDuplicateKeyUpdate()` call.
 */

import type { SectionKey } from "../../shared/const";
import { mapContactAddressFields, mergeAddressFields, parseThaiAddressLine, isLikelyAddressLine } from "./addressFields";

/** Utility: take first day-of-YYYY-MM-DD from possibly timestamped string. */
function toDate(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : v;
}

function toNumStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toFixed(2);
}

/** Truncate string to max length to prevent MySQL column overflow. */
function trunc(v: unknown, maxLen: number): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

function deriveDevice(cat: unknown): string | null {
  if (!cat || typeof cat !== "string") return null;
  if (cat.includes("แท็บเล็ต")) return "iPad";
  if (cat.includes("โทรศัพท์")) return "iPhone";
  return cat;
}

/* -------------------------------------------------------------------------- */
/* Contracts — list endpoint (cheap; covers most columns).                    */
/* -------------------------------------------------------------------------- */

type ContractListItem = {
  contract_id: string | number;
  contract_no: string;
  customer_id?: string | number;
  partner_id?: string | number;
  applied_at?: string;
  approved_at?: string;
  contract_status_code?: string;
  debt_type?: string;
  promotion_name?: string;
  product_category?: string;
  product_type?: string;
  product_model?: string;
  sale_price?: number;
  down_payment_amount?: number;
  finance_amount?: number;
  net_commission_amount?: number;
  term_count?: number;
  multiplier_rate?: number;
  installment_amount?: number;
  due_day_of_month?: number;
  paid_installment_count?: number;
};

export function mapContractListItem(section: SectionKey, it: ContractListItem) {
  return {
    section,
    externalId: String(it.contract_id),
    contractNo: String(it.contract_no ?? ""),
    submitDate: toDate(it.applied_at),
    approveDate: toDate(it.approved_at),
    channel: "หน้าร้าน",
    status: it.contract_status_code ?? null,
    promotionName: it.promotion_name ?? null,
    device: deriveDevice(it.product_category),
    productType: it.product_type ?? null,
    model: it.product_model ?? null,
    sellPrice: toNumStr(it.sale_price),
    deviceStatus: "ปกติ",
    downPayment: toNumStr(it.down_payment_amount),
    financeAmount: toNumStr(it.finance_amount),
    commissionNet: toNumStr(it.net_commission_amount),
    installmentCount: toInt(it.term_count),
    multiplier: toNumStr(it.multiplier_rate),
    installmentAmount: toNumStr(it.installment_amount),
    paymentDay: toInt(it.due_day_of_month),
    paidInstallments: toInt(it.paid_installment_count) ?? 0,
    debtType: it.debt_type ? it.debt_type : "ปกติ",
    rawJson: it as any,
  };
}


type ContractDetail = any; // deeply nested; see docs/contract-columns.md

export function mapContractDetailOverrides(
  section: SectionKey,
  detail: ContractDetail,
) {
  const c = detail?.contract ?? {};
  const member = c.member ?? {};
  const card = c.card_address ?? {};
  const contactAddr = c.contact_address ?? {};
  const occ = c.occupation ?? {};
  const occPlace = typeof occ.place === "string" ? occ.place.trim() : "";
  const workAddr = occ.address ?? {};
  const memberAddrRaw = member.address ?? member.current_address ?? null;
  const memberAddr =
    memberAddrRaw && typeof memberAddrRaw === "object" && !Array.isArray(memberAddrRaw)
      ? (memberAddrRaw as Record<string, unknown>)
      : {};
  const memberAddrLine = typeof memberAddrRaw === "string" ? memberAddrRaw.trim() : "";
  const mailing = mergeAddressFields(
    mapContactAddressFields(contactAddr),
    mapContactAddressFields(card),
    mapContactAddressFields(workAddr),
    mapContactAddressFields(memberAddr),
    isLikelyAddressLine(occPlace) ? parseThaiAddressLine(occPlace) : {},
    isLikelyAddressLine(memberAddrLine) ? parseThaiAddressLine(memberAddrLine) : {},
  );
  const product = c.product ?? {};
  const partner = c.partner ?? {};
  const approved = c.approved ?? {};

  const partnerLabel =
    partner.code && partner.shop
      ? `${partner.code} : ${partner.shop}`
      : partner.code ?? null;

  return {
    section,
    externalId: String(c.id ?? ""),
    contractNo: String(c.code ?? ""),

    // Partner
    partnerCode: partnerLabel,
    partnerName: partner.shop ?? null,

    // Customer
    customerName: member.name ?? null,
    nationality: member.nationality ?? null,
    citizenId: member.identity_number ?? null,
    gender: member.sex ?? null,
    occupation: occ.career ?? null,
    salary: toNumStr(occ.income),
    workplace: trunc(occ.place, 1024),
    phone: trunc(member.tel, 32),
    idDistrict: trunc(card.amphure, 128),
    idProvince: trunc(card.province, 128),
    addrDistrict: trunc(mailing.addrDistrict ?? contactAddr.amphure, 128),
    addrProvince: trunc(mailing.addrProvince ?? contactAddr.province, 128),
    addrHouseNo: trunc(mailing.addrHouseNo, 64),
    addrMoo: trunc(mailing.addrMoo, 32),
    addrVillage: trunc(mailing.addrVillage, 128),
    addrSoi: trunc(mailing.addrSoi, 128),
    addrStreet: trunc(mailing.addrStreet, 128),
    addrSubdistrict: trunc(mailing.addrSubdistrict, 128),
    addrPostalCode: trunc(mailing.addrPostalCode, 16),
    workDistrict: trunc(workAddr.amphure, 128),
    workProvince: trunc(workAddr.province, 128),

    // Product extras
    imei: product.imei ?? null,
    serialNo: product.serial_no ?? null,

    // Approval
    approveDate: toDate(approved.approved_at) ?? undefined,
    status: c.status ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Customers — join by customer_id to enrich contract rows with member info.  */
/* -------------------------------------------------------------------------- */

export type CustomerListItem = {
  customer_id: number | string;
  customer_code?: string;
  full_name?: string;
  nationality?: string;
  id_document_no?: string;
  gender?: string;
  age_years?: number;
  occupation_title?: string;
  monthly_income?: number | string;
  workplace_name?: string;
  mobile_phone?: string;
  idcard_district?: string;
  idcard_province?: string;
  current_district?: string;
  current_province?: string;
  work_district?: string;
  work_province?: string;
};

/**
 * Turn a customer list item into the subset of contract columns it fills.
 * The contract list endpoint does not carry member data, so we merge this
 * on top of `mapContractListItem` when the `customer_id` is known.
 */
export function mapCustomerProfile(cust: CustomerListItem) {
  return {
    customerName: cust.full_name ?? null,
    nationality: cust.nationality ?? null,
    citizenId: cust.id_document_no ?? null,
    gender: cust.gender ?? null,
    age: toInt(cust.age_years),
    occupation: cust.occupation_title ?? null,
    salary: toNumStr(cust.monthly_income),
    workplace: trunc(cust.workplace_name, 1024),
    phone: trunc(cust.mobile_phone, 32),
    idDistrict: trunc(cust.idcard_district, 128),
    idProvince: trunc(cust.idcard_province, 128),
    addrDistrict: trunc(cust.current_district, 128),
    addrProvince: trunc(cust.current_province, 128),
    workDistrict: trunc(cust.work_district, 128),
    workProvince: trunc(cust.work_province, 128),
  };
}

/* -------------------------------------------------------------------------- */
/* Partners — used for province / active status on contract rows.             */
/* -------------------------------------------------------------------------- */

export type PartnerListItem = {
  partner_id: number | string;
  partner_code?: string;
  partner_name?: string;
  partner_province?: string;
  partner_status?: string;
};

/* -------------------------------------------------------------------------- */
/* Installments.                                                              */
/* -------------------------------------------------------------------------- */

type InstallmentItem = {
  installment_id?: number | string;
  id?: number | string;
  contract_id?: number | string;
  contract_code?: string;
  contract_no?: string;
  period?: number;
  installment_no?: number;
  due_date?: string;
  amount?: number;
  installment_amount?: number;
  total_due_amount?: number;
  paid_amount?: number;
  paid?: number;
  total_paid_amount?: number;
  status?: string;
  installment_status_code?: string;
  updated_by?: string;  // ผู้บันทึก — ส่งมาจาก contract?action=detail → installments[].updated_by (ทั้ง Boonphone และ FF365)
  updated_at?: string;  // วันเวลาที่บันทึก
};

export function mapInstallment(section: SectionKey, it: InstallmentItem) {
  const external =
    it.installment_id ??
    it.id ??
    `${it.contract_id ?? it.contract_code ?? "?"}-${it.period ?? it.installment_no ?? ""}`;
  return {
    section,
    externalId: String(external),
    contractExternalId: String(it.contract_id ?? ""),
    contractNo: it.contract_code ?? it.contract_no ?? null,
    period: toInt(it.period ?? it.installment_no),
    dueDate: toDate(it.due_date),
    amount: toNumStr(it.amount ?? it.installment_amount ?? it.total_due_amount),
    paidAmount:
      toNumStr(it.paid_amount ?? it.paid ?? it.total_paid_amount) ?? "0",
    status: it.status ?? it.installment_status_code ?? null,
    updatedBy: it.updated_by ?? null,
    updatedAt: it.updated_at ? String(it.updated_at) : null,
    rawJson: it as any,
  };
}

/* -------------------------------------------------------------------------- */
/* Payment transactions.                                                      */
/* -------------------------------------------------------------------------- */

type PaymentItem = {
  payment_id: number | string;
  contract_id?: number | string;
  contract_code?: string;
  payment_date?: string;
  payment_time?: string;  // เวลาชำระเงิน (HH:mm:ss) — เพิ่มใหม่จาก API
  payment_status?: string;
  payment_method?: string;
  total_paid_amount?: number;
  created_at?: string;   // วันเวลาที่สร้างรายการ
  created_by?: string;   // ผู้สร้างรายการ — เพิ่มใหม่จาก API
  updated_at?: string;   // วันเวลาที่แก้ไขล่าสุด
  updated_by?: string;   // ผู้แก้ไขล่าสุด
  receipt_no?: string;   // เลขที่ใบเสร็จ — TXRT prefix สำหรับ FF365 ใช้ระบุ period
};

export function mapPayment(section: SectionKey, it: PaymentItem) {
  // เก็บทุก field ลง column โดยตรง เพื่อไม่ต้อง JOIN installments ทุกครั้งที่ query
  return {
    section,
    externalId: String(it.payment_id),
    contractExternalId: it.contract_id ? String(it.contract_id) : null,
    contractNo: it.contract_code ?? null,
    paidAt: it.payment_date ?? toDate(it.created_at) ?? null,
    paymentTime: it.payment_time ?? null,
    amount: toNumStr(it.total_paid_amount),
    method: it.payment_method ?? null,
    status: it.payment_status ?? null,
    rawJson: it as any,
    // เลขที่ใบเสร็จ — TXRT prefix สำหรับ FF365 ใช้ระบุ period ใน assignPayPeriods
    receiptNo: it.receipt_no ?? null,
    // เก็บ created_by/created_at จาก API โดยตรง
    createdBy: it.created_by ?? null,
    createdAt: it.created_at ? String(it.created_at) : null,
    // เก็บ updated_by/updated_at จาก API โดยตรง
    updatedBy: it.updated_by ?? null,
    updatedAt: it.updated_at ? String(it.updated_at) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Commissions (รายจ่าย).                                                     */
/* -------------------------------------------------------------------------- */

export type CommissionItem = {
  id?: string | number;
  contract_id?: string | number;
  contract_code?: string;
  approved_at?: string;
  partner_code?: string;
  member_name?: string;
  member_tel?: string;
  product_name?: string;
  product_price?: string | number;
  deposit_amount?: string | number;
  finance_amount?: string | number;
  installment_number?: string | number;
  installment_amount?: string | number;
  comm_amount?: string | number;
  incentive?: string | number;
  total_transfer?: string | number;
  payment_at?: string;
  payment_status?: string;
  payment_slip?: string;
  payment_slip2?: string;
  payment_channel?: string;
  payment_by?: string;
  [key: string]: unknown;
};

export function mapCommission(section: SectionKey, it: CommissionItem) {
  return {
    section,
    externalId: String(it.id),
    contractExternalId: it.contract_id ? String(it.contract_id) : null,
    contractNo: it.contract_code ?? null,
    approvedAt: it.approved_at ?? null,
    partnerCode: it.partner_code ?? null,
    memberName: it.member_name ?? null,
    memberTel: it.member_tel ?? null,
    productName: it.product_name ?? null,
    productPrice: toNumStr(it.product_price),
    depositAmount: toNumStr(it.deposit_amount),
    financeAmount: toNumStr(it.finance_amount),
    installmentNumber: it.installment_number != null ? Number(it.installment_number) : null,
    installmentAmount: toNumStr(it.installment_amount),
    commAmount: toNumStr(it.comm_amount),
    incentive: toNumStr(it.incentive),
    totalTransfer: toNumStr(it.total_transfer),
    paymentAt: it.payment_at ?? null,
    paymentStatus: it.payment_status ?? null,
    paymentSlip: it.payment_slip ?? null,
    paymentSlip2: it.payment_slip2 ?? null,
    paymentChannel: it.payment_channel ?? null,
    paymentBy: it.payment_by ?? null,
    rawJson: it as any,
  };
}

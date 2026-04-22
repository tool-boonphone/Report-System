/**
 * Field mappers between the partner API response shape and the DB rows.
 *
 * Both Boonphone and Fastfone365 expose the same schema on
 * `partner.{domain}.co.th`, so a single set of mappers serves both sections.
 * Each function returns `InsertRow` objects ready to be passed to the
 * drizzle `.insert().onDuplicateKeyUpdate()` call.
 */

import type { SectionKey } from "../../shared/const";

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

/* -------------------------------------------------------------------------- */
/* Contracts — detail endpoint (enriches customer/partner/product columns).   */
/* -------------------------------------------------------------------------- */

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
  const workAddr = occ.address ?? {};
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
    workplace: occ.place ?? null,
    phone: member.tel ?? null,
    idDistrict: card.amphure ?? null,
    idProvince: card.province ?? null,
    addrDistrict: contactAddr.amphure ?? null,
    addrProvince: contactAddr.province ?? null,
    workDistrict: workAddr.amphure ?? null,
    workProvince: workAddr.province ?? null,

    // Product extras
    imei: product.imei ?? null,
    serialNo: product.serial_no ?? null,

    // Approval
    approveDate: toDate(approved.approved_at) ?? undefined,
    status: c.status ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Customers — join by customer_id to fill age column.                         */
/* -------------------------------------------------------------------------- */

export type CustomerListItem = {
  customer_id: number | string;
  age_years?: number;
  full_name?: string;
};

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
  payment_status?: string;
  payment_method?: string;
  total_paid_amount?: number;
  created_at?: string;
};

export function mapPayment(section: SectionKey, it: PaymentItem) {
  return {
    section,
    externalId: String(it.payment_id),
    contractExternalId: it.contract_id ? String(it.contract_id) : null,
    contractNo: it.contract_code ?? null,
    paidAt: it.payment_date ?? toDate(it.created_at) ?? null,
    amount: toNumStr(it.total_paid_amount),
    method: it.payment_method ?? null,
    status: it.payment_status ?? null,
    rawJson: it as any,
  };
}

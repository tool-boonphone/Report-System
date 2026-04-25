/**
 * Shared constants between client and server.
 */

export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

/** Application session cookie (distinct from Manus OAuth cookie). */
export const APP_SESSION_COOKIE = "report_session";
export const APP_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** Report System supports 2 fixed sections — exact names required. */
export const SECTIONS = ["Boonphone", "Fastfone365"] as const;
export type SectionKey = (typeof SECTIONS)[number];

/** Menu codes used by group permissions. */
export const MENU_CODES = [
  "section_switch", // การสลับ Section (ไว้บนสุด)
  "contract", // ข้อมูลสัญญา
  "debt_overview", // ภาพรวมหนี้ (ตารางสรุปรายเดือน)
  "debt_summary", // สรุปหนี้ (มุมมองย่อของรายงานหนี้)
  "debt_report", // รายงานหนี้
  "bad_debt_summary", // สรุปหนี้เสีย
  "settings_users", // ตั้งค่า > จัดการผู้ใช้งาน
  "settings_groups", // ตั้งค่า > จัดการสิทธิ์
] as const;
export type MenuCode = (typeof MENU_CODES)[number];

export const MENU_LABELS: Record<MenuCode, string> = {
  section_switch: "การสลับ Section",
  contract: "ข้อมูลสัญญา",
  debt_overview: "ภาพรวมหนี้",
  debt_summary: "สรุปหนี้",
  debt_report: "รายงานหนี้",
  bad_debt_summary: "สรุปหนี้เสีย",
  settings_users: "จัดการผู้ใช้งาน",
  settings_groups: "จัดการสิทธิ์",
};

/** Permission actions attached to every menu. */
export const PERMISSION_ACTIONS = [
  "view",
  "add",
  "edit",
  "delete",
  "approve",
  "export",
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_ACTION_LABELS: Record<PermissionAction, string> = {
  view: "ดู",
  add: "เพิ่ม",
  edit: "แก้ไข",
  delete: "ลบ",
  approve: "อนุมัติ",
  export: "Export",
};

/** Super Admin defaults (seeded on first boot). */
export const SUPER_ADMIN_GROUP = "Super Admin";
export const SUPER_ADMIN_USERNAME = "Sadmin";

/** Sync log triggers. */
export const SYNC_TRIGGERS = ["cron", "manual", "on-demand", "startup"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_STATUSES = ["in_progress", "success", "error"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/* =============================================================================
 * Contract report — 41 ordered columns (see docs/contract-columns.md)
 * ============================================================================= */

export type ContractColumnKey =
  | "seq"
  | "contractNo"
  | "submitDate"
  | "approveDate"
  | "channel"
  | "status"
  | "partnerCode"
  | "partnerProvince"
  | "commissionNet"
  | "partnerStatus"
  | "customerName"
  | "nationality"
  | "citizenId"
  | "gender"
  | "age"
  | "occupation"
  | "salary"
  | "workplace"
  | "phone"
  | "idDistrict"
  | "idProvince"
  | "addrDistrict"
  | "addrProvince"
  | "workDistrict"
  | "workProvince"
  | "promotionName"
  | "device"
  | "productType"
  | "model"
  | "imei"
  | "serialNo"
  | "sellPrice"
  | "deviceStatus"
  | "downPayment"
  | "financeAmount"
  | "installmentCount"
  | "multiplier"
  | "installmentAmount"
  | "paymentDay"
  | "paidInstallments"
  | "debtType";

export type ContractColumnType = "text" | "number" | "money" | "date";

export const CONTRACT_COLUMNS: Array<{
  key: ContractColumnKey;
  label: string;
  type: ContractColumnType;
  width?: number; // for Excel (approx. characters)
}> = [
  { key: "seq", label: "ลำดับ", type: "number", width: 6 },
  { key: "contractNo", label: "เลขที่สัญญา", type: "text", width: 22 },
  { key: "submitDate", label: "วันยื่นสินเชื่อ", type: "date", width: 14 },
  { key: "approveDate", label: "วันอนุมัติสัญญา", type: "date", width: 14 },
  { key: "channel", label: "ช่องทาง", type: "text", width: 12 },
  { key: "status", label: "สถานะสัญญา", type: "text", width: 16 },
  { key: "partnerCode", label: "รหัสพาร์ทเนอร์", type: "text", width: 24 },
  { key: "partnerProvince", label: "จังหวัดพาร์ทเนอร์", type: "text", width: 14 },
  { key: "commissionNet", label: "ค่าคอมมิชชั่น สุทธิ", type: "money", width: 14 },
  { key: "partnerStatus", label: "สถานะพาร์ทเนอร์", type: "text", width: 14 },
  { key: "customerName", label: "ชื่อลูกค้า", type: "text", width: 24 },
  { key: "nationality", label: "สัญชาติ", type: "text", width: 10 },
  { key: "citizenId", label: "เลขบัตรประชาชน/Passport", type: "text", width: 18 },
  { key: "gender", label: "เพศ", type: "text", width: 8 },
  { key: "age", label: "อายุ(ปี)", type: "number", width: 8 },
  { key: "occupation", label: "ตำแหน่งงาน", type: "text", width: 18 },
  { key: "salary", label: "เงินเดือน/รายได้", type: "money", width: 14 },
  { key: "workplace", label: "บริษัท/สถานที่ทำงาน", type: "text", width: 22 },
  { key: "phone", label: "โทรศัพท์", type: "text", width: 14 },
  { key: "idDistrict", label: "อำเภอ (ตามบัตร ปชช.)", type: "text", width: 16 },
  { key: "idProvince", label: "จังหวัด (ตามบัตร ปชช.)", type: "text", width: 14 },
  { key: "addrDistrict", label: "อำเภอ (ที่อยู่ปัจจุบัน)", type: "text", width: 16 },
  { key: "addrProvince", label: "จังหวัด (ที่อยู่ปัจจุบัน)", type: "text", width: 14 },
  { key: "workDistrict", label: "อำเภอ (ที่ทำงาน)", type: "text", width: 16 },
  { key: "workProvince", label: "จังหวัด (ที่ทำงาน)", type: "text", width: 14 },
  { key: "promotionName", label: "Promotion ID", type: "text", width: 22 },
  { key: "device", label: "Device", type: "text", width: 12 },
  { key: "productType", label: "ประเภทสินค้า", type: "text", width: 14 },
  { key: "model", label: "รุ่น", type: "text", width: 18 },
  { key: "imei", label: "Imei", type: "text", width: 18 },
  { key: "serialNo", label: "Serial No", type: "text", width: 18 },
  { key: "sellPrice", label: "ราคาขาย", type: "money", width: 12 },
  { key: "deviceStatus", label: "สถานะอุปกรณ์", type: "text", width: 12 },
  { key: "downPayment", label: "ยอดดาวน์", type: "money", width: 12 },
  { key: "financeAmount", label: "ยอดจัดไฟแนนซ์", type: "money", width: 14 },
  { key: "installmentCount", label: "จำนวนงวดผ่อน", type: "number", width: 12 },
  { key: "multiplier", label: "ตัวคูณ", type: "number", width: 8 },
  { key: "installmentAmount", label: "ผ่อนงวดละ", type: "money", width: 12 },
  { key: "paymentDay", label: "ชำระทุกวันที่(ของทุกเดือน)", type: "number", width: 12 },
  { key: "paidInstallments", label: "งวดที่ชำระแล้ว", type: "number", width: 12 },
  { key: "debtType", label: "ประเภทหนี้", type: "text", width: 12 },
];

export const CONTRACT_COLUMN_COUNT = CONTRACT_COLUMNS.length; // must be 41

/** Columns exposed to the filter form (subset). */
export const CONTRACT_FILTER_KEYS: ContractColumnKey[] = [
  "contractNo",
  "status",
  "customerName",
  "partnerCode",
  "debtType",
];

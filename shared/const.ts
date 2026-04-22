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
  "contract", // ข้อมูลสัญญา
  "debt_report", // รายงานหนี้
  "settings_users", // ตั้งค่า > จัดการผู้ใช้งาน
  "settings_groups", // ตั้งค่า > จัดการสิทธิ์
] as const;
export type MenuCode = (typeof MENU_CODES)[number];

export const MENU_LABELS: Record<MenuCode, string> = {
  contract: "ข้อมูลสัญญา",
  debt_report: "รายงานหนี้",
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

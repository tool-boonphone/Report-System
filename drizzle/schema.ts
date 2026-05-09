import {
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/* =============================================================================
 * Legacy Manus OAuth table (kept for framework compatibility but unused).
 * The Report System uses its own app_users/app_sessions tables below.
 * ============================================================================= */

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/* =============================================================================
 * Authentication & Authorization
 * ============================================================================= */

/** Groups that hold the permission matrix. */
export const appGroups = mysqlTable(
  "app_groups",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 64 }).notNull(),
    description: varchar("description", { length: 255 }),
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    // Comma-separated allowed sections e.g. "Boonphone,Fastfone365"
    // Empty string = all sections allowed (used for Super Admin / backward compat)
    allowedSections: varchar("allowed_sections", { length: 255 }).notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    nameIdx: uniqueIndex("app_groups_name_idx").on(t.name),
  }),
);

/** Permission matrix: one row per (group, menu). */
export const appGroupPermissions = mysqlTable(
  "app_group_permissions",
  {
    id: int("id").autoincrement().primaryKey(),
    groupId: int("group_id").notNull(),
    menuCode: varchar("menu_code", { length: 64 }).notNull(),
    canView: boolean("can_view").notNull().default(false),
    canAdd: boolean("can_add").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    canApprove: boolean("can_approve").notNull().default(false),
    canExport: boolean("can_export").notNull().default(false),
    canSync: boolean("can_sync").notNull().default(false),
  },
  (t) => ({
    groupMenuIdx: uniqueIndex("app_group_perm_group_menu_idx").on(
      t.groupId,
      t.menuCode,
    ),
  }),
);

/** In-app users (independent from Manus OAuth). */
export const appUsers = mysqlTable(
  "app_users",
  {
    id: int("id").autoincrement().primaryKey(),
    username: varchar("username", { length: 64 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 128 }),
    email: varchar("email", { length: 255 }),
    groupId: int("group_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    usernameIdx: uniqueIndex("app_users_username_idx").on(t.username),
    groupIdx: index("app_users_group_idx").on(t.groupId),
  }),
);

/** Session tokens for the custom login flow. */
export const appSessions = mysqlTable(
  "app_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("user_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("app_sessions_user_idx").on(t.userId),
  }),
);

export type AppUser = typeof appUsers.$inferSelect;
export type AppGroup = typeof appGroups.$inferSelect;
export type AppGroupPermission = typeof appGroupPermissions.$inferSelect;

/* =============================================================================
 * Sync Log
 * ============================================================================= */

export const syncLogs = mysqlTable(
  "sync_logs",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 32 }).notNull(), // Boonphone | Fastfone365
    entity: varchar("entity", { length: 48 }).notNull(), // contracts | installments | payments | all
    status: mysqlEnum("status", ["in_progress", "success", "error"]).notNull(),
    triggeredBy: varchar("triggered_by", { length: 32 }).notNull(), // cron | manual | on-demand | startup
    rowCount: int("row_count").default(0),
    errorMessage: text("error_message"),
    // Stage tracking for cross-instance progress reporting (Cloud Run multi-instance)
    currentStage: varchar("current_stage", { length: 32 }),
    progress: int("progress").default(0),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    sectionIdx: index("sync_logs_section_idx").on(t.section),
    finishedIdx: index("sync_logs_finished_idx").on(t.finishedAt),
  }),
);
export type SyncLog = typeof syncLogs.$inferSelect;

/* =============================================================================
 * Shared contract schema used by BOTH Boonphone + Fastfone365.
 * We use the `section` column to distinguish the source, backed by an index
 * so per-section queries stay in milliseconds.
 * ============================================================================= */

export const contracts = mysqlTable(
  "contracts",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 32 }).notNull(), // Boonphone | Fastfone365
    externalId: varchar("external_id", { length: 64 }).notNull(), // API contract id
    contractNo: varchar("contract_no", { length: 64 }).notNull(),

    // === Contract header ===
    submitDate: varchar("submit_date", { length: 20 }), // YYYY-MM-DD
    approveDate: varchar("approve_date", { length: 20 }),
    channel: varchar("channel", { length: 64 }),
    status: varchar("status", { length: 32 }),

    // === Partner ===
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    partnerProvince: varchar("partner_province", { length: 64 }),
    partnerStatus: varchar("partner_status", { length: 32 }),
    commissionNet: decimal("commission_net", { precision: 12, scale: 2 }),

    // === Customer ===
    customerName: varchar("customer_name", { length: 255 }),
    nationality: varchar("nationality", { length: 64 }),
    citizenId: varchar("citizen_id", { length: 32 }),
    gender: varchar("gender", { length: 16 }),
    age: int("age"),
    occupation: varchar("occupation", { length: 512 }),
    salary: decimal("salary", { precision: 12, scale: 2 }),
    workplace: varchar("workplace", { length: 1024 }),
    phone: varchar("phone", { length: 32 }),
    idDistrict: varchar("id_district", { length: 128 }),
    idProvince: varchar("id_province", { length: 128 }),
    addrDistrict: varchar("addr_district", { length: 128 }),
    addrProvince: varchar("addr_province", { length: 128 }),
    workDistrict: varchar("work_district", { length: 128 }),
    workProvince: varchar("work_province", { length: 128 }),

    // === Product ===
    promotionName: varchar("promotion_name", { length: 255 }),
    device: varchar("device", { length: 64 }),
    productType: varchar("product_type", { length: 64 }),
    model: varchar("model", { length: 128 }),
    imei: varchar("imei", { length: 64 }),
    serialNo: varchar("serial_no", { length: 64 }),
    sellPrice: decimal("sell_price", { precision: 12, scale: 2 }),
    deviceStatus: varchar("device_status", { length: 32 }),

    // === Financing ===
    downPayment: decimal("down_payment", { precision: 12, scale: 2 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentCount: int("installment_count"),
    multiplier: decimal("multiplier", { precision: 6, scale: 2 }),
    installmentAmount: decimal("installment_amount", { precision: 12, scale: 2 }),
    paymentDay: int("payment_day"),
    paidInstallments: int("paid_installments").default(0),
    debtType: varchar("debt_type", { length: 32 }),

    // Bookkeeping
    rawJson: json("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),

    // Bad-debt summary — computed & stored after each sync.
    // bad_debt_amount:       total proceeds from device sale (ยอดขายเครื่อง)
    // bad_debt_date:         date the bad-debt was recorded (YYYY-MM-DD)
    // suspended_from_period: first installment period that became suspended/bad-debt
    // bad_debt_updated_by:   ผู้ทำรายการสุดท้าย (จาก installments.updated_by ของรายการล่าสุด)
    // bad_debt_updated_at:   วันเวลาที่ทำรายการสุดท้าย (จาก installments.updated_at ของรายการล่าสุด)
    badDebtAmount: decimal("bad_debt_amount", { precision: 12, scale: 2 }),
    badDebtDate: varchar("bad_debt_date", { length: 20 }),
    suspendedFromPeriod: int("suspended_from_period"),
    badDebtUpdatedBy: varchar("bad_debt_updated_by", { length: 128 }),
    badDebtUpdatedAt: varchar("bad_debt_updated_at", { length: 32 }),
  },
  (t) => ({
    sectionExternalIdx: uniqueIndex("contracts_section_external_idx").on(
      t.section,
      t.externalId,
    ),
    sectionContractNoIdx: index("contracts_section_contract_no_idx").on(
      t.section,
      t.contractNo,
    ),
    sectionCustomerIdx: index("contracts_section_customer_idx").on(
      t.section,
      t.customerName,
    ),
    sectionStatusIdx: index("contracts_section_status_idx").on(
      t.section,
      t.status,
    ),
    sectionApproveIdx: index("contracts_section_approve_idx").on(
      t.section,
      t.approveDate,
    ),
  }),
);
export type Contract = typeof contracts.$inferSelect;

/* Installments attached to a contract. Used for "เป้าเก็บหนี้" computation. */
export const installments = mysqlTable(
  "installments",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }),
    period: int("period"),
    dueDate: varchar("due_date", { length: 20 }),
    amount: decimal("amount", { precision: 12, scale: 2 }),
    paidAmount: decimal("paid_amount", { precision: 12, scale: 2 }).default("0"),
    status: varchar("status", { length: 32 }),
    /** ผู้บันทึก — ดึงจาก contract?action=detail → installments[].updated_by (ทั้ง Boonphone และ FF365) */
    updatedBy: varchar("updated_by", { length: 128 }),
    /** วันเวลาที่บันทึก — ดึงจาก contract?action=detail → installments[].updated_at */
    updatedAt: varchar("updated_at", { length: 32 }),
    rawJson: json("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionExternalIdx: uniqueIndex("installments_section_external_idx").on(
      t.section,
      t.externalId,
    ),
    sectionContractIdx: index("installments_section_contract_idx").on(
      t.section,
      t.contractExternalId,
    ),
    sectionDueIdx: index("installments_section_due_idx").on(t.section, t.dueDate),
  }),
);
export type Installment = typeof installments.$inferSelect;

/* Payment transactions. Used for "ยอดเก็บหนี้" computation. */
export const paymentTransactions = mysqlTable(
  "payment_transactions",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }),
    contractNo: varchar("contract_no", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    paidAt: varchar("paid_at", { length: 32 }),
    amount: decimal("amount", { precision: 12, scale: 2 }),
    method: varchar("method", { length: 64 }),
    status: varchar("status", { length: 32 }),
    rawJson: json("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    /** เลขที่ใบเสร็จ — TXRT prefix สำหรับ FF365 ใช้ระบุ period ใน assignPayPeriods */
    receiptNo: varchar("receipt_no", { length: 128 }),
    /** เวลาชำระเงิน — จาก payment_time (HH:mm:ss) รวมกับ paid_at เป็น datetime เต็ม */
    paymentTime: varchar("payment_time", { length: 8 }),
    /** ผู้สร้างรายการ — จาก created_by */
    createdBy: varchar("created_by", { length: 128 }),
    /** วันเวลาที่สร้างรายการ — จาก created_at */
    createdAt: varchar("created_at", { length: 32 }),
    /** ผู้แก้ไขล่าสุด — จาก updated_by */
    updatedBy: varchar("updated_by", { length: 128 }),
    /** วันเวลาที่แก้ไขล่าสุด — จาก updated_at */
    updatedAt: varchar("updated_at", { length: 32 }),
  },
  (t) => ({
    sectionExternalIdx: uniqueIndex("payments_section_external_idx").on(
      t.section,
      t.externalId,
    ),
    sectionContractIdx: index("payments_section_contract_idx").on(
      t.section,
      t.contractExternalId,
    ),
    sectionPaidAtIdx: index("payments_section_paid_at_idx").on(
      t.section,
      t.paidAt,
    ),
  }),
);
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;

/* =============================================================================
 * Precomputed Cache Tables
 * Built once per day (06:00 cron) from contracts + installments + payment_transactions.
 * Frontend reads directly from these tables — no real-time calculation needed.
 * ============================================================================= */

/**
 * debt_target_cache — เป้าเก็บหนี้ (1 row per installment period per contract)
 * Stores all calculated fields needed to render the target table without any joins.
 */
export const debtTargetCache = mysqlTable(
  "debt_target_cache",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 32 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }).notNull(),
    customerName: varchar("customer_name", { length: 255 }),
    approveDate: varchar("approve_date", { length: 20 }),
    contractStatus: varchar("contract_status", { length: 32 }),
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    productType: varchar("product_type", { length: 64 }),
    device: varchar("device", { length: 64 }),
    model: varchar("model", { length: 128 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentCount: int("installment_count"),
    // === Per-period fields ===
    period: int("period").notNull(),
    dueDate: varchar("due_date", { length: 20 }),
    // Calculated amounts
    principal: decimal("principal", { precision: 12, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 12, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 12, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 12, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 12, scale: 2 }).notNull().default("0"),
    netAmount: decimal("net_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    paidAmount: decimal("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    overpaidApplied: decimal("overpaid_applied", { precision: 12, scale: 2 }).notNull().default("0"),
    baselineAmount: decimal("baseline_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // Status flags (stored as tinyint 0/1)
    isPaid: boolean("is_paid").notNull().default(false),
    isPartialPaid: boolean("is_partial_paid").notNull().default(false),
    isClosed: boolean("is_closed").notNull().default(false),
    isSuspended: boolean("is_suspended").notNull().default(false),
    isCurrentPeriod: boolean("is_current_period").notNull().default(false),
    isFuturePeriod: boolean("is_future_period").notNull().default(false),
    isArrears: boolean("is_arrears").notNull().default(false),
    isBadDebt: boolean("is_bad_debt").notNull().default(false),
    // Debt range badge (เกิน 1-30, เกิน 31-60, ฯลฯ)
    debtRange: varchar("debt_range", { length: 32 }),
    // Bookkeeping
    populatedAt: timestamp("populated_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionContractPeriodIdx: uniqueIndex("dtc_section_contract_period_idx").on(
      t.section,
      t.contractExternalId,
      t.period,
    ),
    sectionDueDateIdx: index("dtc_section_due_date_idx").on(t.section, t.dueDate),
    sectionApproveDateIdx: index("dtc_section_approve_date_idx").on(t.section, t.approveDate),
    sectionStatusIdx: index("dtc_section_status_idx").on(t.section, t.contractStatus),
    sectionDebtRangeIdx: index("dtc_section_debt_range_idx").on(t.section, t.debtRange),
    sectionProductTypeIdx: index("dtc_section_product_type_idx").on(t.section, t.productType),
  }),
);
export type DebtTargetCache = typeof debtTargetCache.$inferSelect;

/**
 * debt_collected_cache — ยอดเก็บหนี้ (1 row per payment transaction)
 * Stores all calculated fields needed to render the collected table without any joins.
 */
export const debtCollectedCache = mysqlTable(
  "debt_collected_cache",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 32 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }).notNull(),
    customerName: varchar("customer_name", { length: 255 }),
    approveDate: varchar("approve_date", { length: 20 }),
    contractStatus: varchar("contract_status", { length: 32 }),
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    productType: varchar("product_type", { length: 64 }),
    device: varchar("device", { length: 64 }),
    model: varchar("model", { length: 128 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentCount: int("installment_count"),
    // === Per-payment fields ===
    paymentExternalId: varchar("payment_external_id", { length: 64 }).notNull(),
    period: int("period"),
    paidAt: varchar("paid_at", { length: 32 }),
    // Calculated amounts
    principal: decimal("principal", { precision: 12, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 12, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 12, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 12, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 12, scale: 2 }).notNull().default("0"),
    discount: decimal("discount", { precision: 12, scale: 2 }).notNull().default("0"),
    overpaid: decimal("overpaid", { precision: 12, scale: 2 }).notNull().default("0"),
    badDebt: decimal("bad_debt", { precision: 12, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // Raw payment_transactions.amount (ตรงกับ Fastfone Report — source IS NULL rows)
    paymentTxAmount: decimal("payment_tx_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // Metadata
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: varchar("updated_at", { length: 32 }),
    isBadDebtRow: boolean("is_bad_debt_row").notNull().default(false),
    isCloseRow: boolean("is_close_row").notNull().default(false),
    // Bookkeeping
    populatedAt: timestamp("populated_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionPaymentIdx: uniqueIndex("dcc_section_payment_idx").on(
      t.section,
      t.paymentExternalId,
    ),
    sectionContractIdx: index("dcc_section_contract_idx").on(t.section, t.contractExternalId),
    sectionPaidAtIdx: index("dcc_section_paid_at_idx").on(t.section, t.paidAt),
    sectionApproveDateIdx: index("dcc_section_approve_date_idx").on(t.section, t.approveDate),
    sectionProductTypeIdx: index("dcc_section_product_type_idx").on(t.section, t.productType),
    sectionUpdatedByIdx: index("dcc_section_updated_by_idx").on(t.section, t.updatedBy),
  }),
);
export type DebtCollectedCache = typeof debtCollectedCache.$inferSelect;

/* =============================================================================
 * Pre-built Export Cache
 * สร้างไฟล์ Excel ล่วงหน้าหลัง sync เสร็จ แล้วเก็บ S3 URL ไว้
 * ============================================================================= */

export const debtExportCache = mysqlTable(
  "debt_export_cache",
  {
    id: int("id").autoincrement().primaryKey(),
    section: varchar("section", { length: 64 }).notNull(),
    variant: mysqlEnum("variant", ["target", "collected"]).notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    storageUrl: varchar("storage_url", { length: 512 }).notNull(),
    rowCount: int("row_count").notNull().default(0),
    builtAt: timestamp("built_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionVariantIdx: uniqueIndex("dec_section_variant_idx").on(t.section, t.variant),
  }),
);
export type DebtExportCache = typeof debtExportCache.$inferSelect;

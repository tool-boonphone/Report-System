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
    partnerCode: varchar("partner_code", { length: 64 }),
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
    occupation: varchar("occupation", { length: 128 }),
    salary: decimal("salary", { precision: 12, scale: 2 }),
    workplace: varchar("workplace", { length: 255 }),
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

import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const syncStatusEnum = pgEnum("sync_status", ["in_progress", "success", "error"]);
export const exportVariantEnum = pgEnum("export_variant", ["target", "collected"]);

export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: roleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const appGroups = pgTable(
  "app_groups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: varchar("name", { length: 64 }).notNull(),
    description: varchar("description", { length: 255 }),
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    allowedSections: varchar("allowed_sections", { length: 255 }).notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: uniqueIndex("app_groups_name_idx").on(t.name),
  }),
);

export const appGroupPermissions = pgTable(
  "app_group_permissions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer("group_id").notNull(),
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

export const appUsers = pgTable(
  "app_users",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    username: varchar("username", { length: 64 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 128 }),
    email: varchar("email", { length: 255 }),
    groupId: integer("group_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    usernameIdx: uniqueIndex("app_users_username_idx").on(t.username),
    groupIdx: index("app_users_group_idx").on(t.groupId),
  }),
);

export const appSessions = pgTable(
  "app_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: integer("user_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("app_sessions_user_idx").on(t.userId),
  }),
);

export const syncLogs = pgTable(
  "sync_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    entity: varchar("entity", { length: 48 }).notNull(),
    status: syncStatusEnum("status").notNull(),
    triggeredBy: varchar("triggered_by", { length: 32 }).notNull(),
    rowCount: integer("row_count").default(0),
    errorMessage: text("error_message"),
    currentStage: varchar("current_stage", { length: 32 }),
    progress: integer("progress").default(0),
    resumePage: integer("resume_page").default(0),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    sectionIdx: index("sync_logs_section_idx").on(t.section),
    finishedIdx: index("sync_logs_finished_idx").on(t.finishedAt),
  }),
);

export const contracts = pgTable(
  "contracts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }).notNull(),
    submitDate: varchar("submit_date", { length: 20 }),
    approveDate: varchar("approve_date", { length: 20 }),
    channel: varchar("channel", { length: 64 }),
    status: varchar("status", { length: 32 }),
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    partnerProvince: varchar("partner_province", { length: 64 }),
    partnerStatus: varchar("partner_status", { length: 32 }),
    commissionNet: decimal("commission_net", { precision: 12, scale: 2 }),
    customerName: varchar("customer_name", { length: 255 }),
    nationality: varchar("nationality", { length: 64 }),
    citizenId: varchar("citizen_id", { length: 32 }),
    gender: varchar("gender", { length: 16 }),
    age: integer("age"),
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
    promotionName: varchar("promotion_name", { length: 255 }),
    device: varchar("device", { length: 64 }),
    productType: varchar("product_type", { length: 64 }),
    model: varchar("model", { length: 128 }),
    imei: varchar("imei", { length: 64 }),
    serialNo: varchar("serial_no", { length: 64 }),
    sellPrice: decimal("sell_price", { precision: 12, scale: 2 }),
    deviceStatus: varchar("device_status", { length: 32 }),
    downPayment: decimal("down_payment", { precision: 12, scale: 2 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentCount: integer("installment_count"),
    multiplier: decimal("multiplier", { precision: 6, scale: 2 }),
    installmentAmount: decimal("installment_amount", { precision: 12, scale: 2 }),
    paymentDay: integer("payment_day"),
    paidInstallments: integer("paid_installments").default(0),
    debtType: varchar("debt_type", { length: 32 }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    badDebtAmount: decimal("bad_debt_amount", { precision: 12, scale: 2 }),
    badDebtDate: varchar("bad_debt_date", { length: 20 }),
    suspendedFromPeriod: integer("suspended_from_period"),
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

export const installments = pgTable(
  "installments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }),
    period: integer("period"),
    dueDate: varchar("due_date", { length: 20 }),
    amount: decimal("amount", { precision: 12, scale: 2 }),
    paidAmount: decimal("paid_amount", { precision: 12, scale: 2 }).default("0"),
    status: varchar("status", { length: 32 }),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: varchar("updated_at", { length: 32 }),
    rawJson: jsonb("raw_json"),
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

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }),
    contractNo: varchar("contract_no", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    paidAt: varchar("paid_at", { length: 32 }),
    amount: decimal("amount", { precision: 12, scale: 2 }),
    method: varchar("method", { length: 64 }),
    status: varchar("status", { length: 32 }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    receiptNo: varchar("receipt_no", { length: 128 }),
    paymentTime: varchar("payment_time", { length: 8 }),
    createdBy: varchar("created_by", { length: 128 }),
    createdAt: varchar("created_at", { length: 32 }),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: varchar("updated_at", { length: 32 }),
    periodNo: integer("period_no"),
    subNo: integer("sub_no"),
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
  }),
);

export const debtTargetCache = pgTable(
  "debt_target_cache",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    approveDate: varchar("approve_date", { length: 20 }),
    productType: varchar("product_type", { length: 64 }),
    installmentCount: integer("installment_count"),
    installmentAmount: decimal("installment_amount", { precision: 12, scale: 2 }),
    dueDate: varchar("due_date", { length: 20 }),
    period: integer("period"),
    amount: decimal("amount", { precision: 12, scale: 2 }),
    paidAmount: decimal("paid_amount", { precision: 12, scale: 2 }),
    status: varchar("status", { length: 32 }),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: varchar("updated_at", { length: 32 }),
    populatedAt: timestamp("populated_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionContractPeriodIdx: uniqueIndex("dtc_section_contract_period_idx").on(
      t.section,
      t.contractExternalId,
      t.period,
    ),
    sectionDueIdx: index("dtc_section_due_idx").on(t.section, t.dueDate),
  }),
);

export const debtCollectedCache = pgTable(
  "debt_collected_cache",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    paymentExternalId: varchar("payment_external_id", { length: 64 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }),
    contractNo: varchar("contract_no", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    approveDate: varchar("approve_date", { length: 20 }),
    productType: varchar("product_type", { length: 64 }),
    paidAt: varchar("paid_at", { length: 32 }),
    periodNo: integer("period_no"),
    subNo: integer("sub_no"),
    principal: decimal("principal", { precision: 12, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 12, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 12, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 12, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 12, scale: 2 }).notNull().default("0"),
    discount: decimal("discount", { precision: 12, scale: 2 }).notNull().default("0"),
    overpaid: decimal("overpaid", { precision: 12, scale: 2 }).notNull().default("0"),
    badDebt: decimal("bad_debt", { precision: 12, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    paymentTxAmount: decimal("payment_tx_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: varchar("updated_at", { length: 32 }),
    isBadDebtRow: boolean("is_bad_debt_row").notNull().default(false),
    isCloseRow: boolean("is_close_row").notNull().default(false),
    remark: text("remark"),
    populatedAt: timestamp("populated_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionPaymentIdx: uniqueIndex("dcc_section_payment_idx").on(
      t.section,
      t.paymentExternalId,
    ),
    sectionContractIdx: index("dcc_section_contract_idx").on(t.section, t.contractExternalId),
    sectionPaidAtIdx: index("dcc_section_paid_at_idx").on(t.section, t.paidAt),
  }),
);

export const debtExportCache = pgTable(
  "debt_export_cache",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 64 }).notNull(),
    variant: exportVariantEnum("variant").notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    storageUrl: varchar("storage_url", { length: 512 }).notNull(),
    rowCount: integer("row_count").notNull().default(0),
    builtAt: timestamp("built_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionVariantIdx: uniqueIndex("dec_section_variant_idx").on(t.section, t.variant),
  }),
);

export const cachedCustomers = pgTable(
  "cached_customers",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    customerId: varchar("customer_id", { length: 64 }).notNull(),
    customerCode: varchar("customer_code", { length: 64 }),
    fullName: varchar("full_name", { length: 255 }),
    nationality: varchar("nationality", { length: 64 }),
    idDocumentNo: varchar("id_document_no", { length: 32 }),
    gender: varchar("gender", { length: 16 }),
    ageYears: integer("age_years"),
    occupationTitle: varchar("occupation_title", { length: 512 }),
    monthlyIncome: decimal("monthly_income", { precision: 12, scale: 2 }),
    workplaceName: varchar("workplace_name", { length: 1024 }),
    mobilePhone: varchar("mobile_phone", { length: 32 }),
    idcardDistrict: varchar("idcard_district", { length: 128 }),
    idcardProvince: varchar("idcard_province", { length: 128 }),
    currentDistrict: varchar("current_district", { length: 128 }),
    currentProvince: varchar("current_province", { length: 128 }),
    workDistrict: varchar("work_district", { length: 128 }),
    workProvince: varchar("work_province", { length: 128 }),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionCustomerIdx: uniqueIndex("cc_section_customer_idx").on(t.section, t.customerId),
    sectionIdx: index("cc_section_idx").on(t.section),
  }),
);

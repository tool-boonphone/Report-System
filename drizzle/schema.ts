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
export type AppUser = typeof appUsers.$inferSelect;
export type AppGroup = typeof appGroups.$inferSelect;
export type AppGroupPermission = typeof appGroupPermissions.$inferSelect;

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
    cancelRequested: boolean("cancel_requested").default(false),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    /** Last time currentStage/progress was updated — used to detect zombie sync rows */
    stageUpdatedAt: timestamp("stage_updated_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
        sectionIdx: index("sync_logs_section_idx").on(t.section),
    finishedIdx: index("sync_logs_finished_idx").on(t.finishedAt),
  }),
);
export type SyncLog = typeof syncLogs.$inferSelect;

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
    lastOnlineDays: integer("last_online_days"),            // จำนวนวันที่ออนไลน์ล่าสุดจาก MDM (0=วันนี้, null=ไม่พบ)
    lastOnlineAt: varchar("last_online_at", { length: 32 }), // "YYYY-MM-DD HH:mm:ss" จาก MDM lastTime
    deviceLock: boolean("device_lock"),                       // สถานะล็อคเครื่องจาก MDM (true=ล็อค, false=ปลดล็อค, null=ไม่พบ)
    lossStatus: integer("loss_status"),                        // MDM Lost Mode (0=ปกติ, 1=Lost Mode เปิดอยู่ — ดึง GPS ได้)
    mdmDeviceId: integer("mdm_device_id"),                    // MDM internal ID (ใช้ดึง GPS location โดยตรง)
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
export type Installment = typeof installments.$inferSelect;

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
    incomeType: varchar("income_type", { length: 32 }),
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
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;

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
    status: varchar("status", { length: 32 }),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: varchar("updated_at", { length: 32 }),
    populatedAt: timestamp("populated_at").defaultNow().notNull(),
    // --- columns matching DB schema ---
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    device: varchar("device", { length: 64 }),
    model: varchar("model", { length: 128 }),
    serialNo: varchar("serial_no", { length: 64 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    contractStatus: varchar("contract_status", { length: 32 }),
    debtRange: varchar("debt_range", { length: 32 }),
    principal: decimal("principal", { precision: 12, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 12, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 12, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 12, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 12, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    netAmount: decimal("net_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    paidAmount: decimal("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    baselineAmount: decimal("baseline_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    overpaidApplied: decimal("overpaid_applied", { precision: 12, scale: 2 }).notNull().default("0"),
    isPaid: boolean("is_paid").notNull().default(false),
    isArrears: boolean("is_arrears").notNull().default(false),
    isBadDebt: boolean("is_bad_debt").notNull().default(false),
    isClosed: boolean("is_closed").notNull().default(false),
    isSuspended: boolean("is_suspended").notNull().default(false),
    isCurrentPeriod: boolean("is_current_period").notNull().default(false),
    isFuturePeriod: boolean("is_future_period").notNull().default(false),
    isPartialPaid: boolean("is_partial_paid").notNull().default(false),
  },
  (t) => ({
    sectionContractPeriodIdx: uniqueIndex("dtc_section_contract_period_idx").on(
      t.section,
      t.contractExternalId,
      t.period,
    ),
    sectionDueIdx: index("dtc_section_due_idx").on(t.section, t.dueDate),
    sectionIsPaidIdx: index("dtc_section_is_paid_idx").on(t.section, t.isPaid),
    sectionIsArrearsIdx: index("dtc_section_is_arrears_idx").on(t.section, t.isArrears),
    sectionIsBadDebtIdx: index("dtc_section_is_bad_debt_idx").on(t.section, t.isBadDebt),
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
    // --- columns added to match SQL schema ---
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    device: varchar("device", { length: 64 }),
    model: varchar("model", { length: 128 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentCount: integer("installment_count"),
    contractStatus: varchar("contract_status", { length: 32 }),
    debtRange: varchar("debt_range", { length: 32 }),
    period: integer("period"),
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

export const commissions = pgTable(
  "commissions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }),
    contractNo: varchar("contract_no", { length: 64 }),
    approvedAt: varchar("approved_at", { length: 32 }),
    partnerCode: varchar("partner_code", { length: 64 }),
    memberName: varchar("member_name", { length: 255 }),
    memberTel: varchar("member_tel", { length: 32 }),
    productName: varchar("product_name", { length: 512 }),
    productPrice: decimal("product_price", { precision: 12, scale: 2 }),
    depositAmount: decimal("deposit_amount", { precision: 12, scale: 2 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentNumber: integer("installment_number"),
    installmentAmount: decimal("installment_amount", { precision: 12, scale: 2 }),
    commAmount: decimal("comm_amount", { precision: 12, scale: 2 }),
    incentive: decimal("incentive", { precision: 12, scale: 2 }),
    totalTransfer: decimal("total_transfer", { precision: 12, scale: 2 }),
    paymentAt: varchar("payment_at", { length: 32 }),
    paymentStatus: varchar("payment_status", { length: 64 }),
    paymentSlip: text("payment_slip"),
    paymentSlip2: text("payment_slip2"),
    paymentChannel: varchar("payment_channel", { length: 64 }),
    paymentBy: varchar("payment_by", { length: 128 }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionExternalIdx: uniqueIndex("commissions_section_external_idx").on(
      t.section,
      t.externalId,
    ),
    sectionContractIdx: index("commissions_section_contract_idx").on(
      t.section,
      t.contractExternalId,
    ),
    sectionApprovedIdx: index("commissions_section_approved_idx").on(
      t.section,
      t.approvedAt,
    ),
  }),
);
export type Commission = typeof commissions.$inferSelect;

// ─── Income Monthly Summary (pre-aggregated) ──────────────────────────────────
export const incomeMonthlySummary = pgTable(
  "income_monthly_summary",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    incomeType: varchar("income_type", { length: 32 }).notNull(),
    totalAmount: decimal("total_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    rowCount: integer("row_count").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionYearMonthTypeIdx: uniqueIndex("ims_section_year_month_type_idx").on(
      t.section,
      t.year,
      t.month,
      t.incomeType,
    ),
    sectionYearIdx: index("ims_section_year_idx").on(t.section, t.year),
  }),
);
export type IncomeMonthlySummary = typeof incomeMonthlySummary.$inferSelect;

// ─── Monthly Summary Cache (pre-aggregated per query_type + filter combo) ─────
export const monthlySummaryCache = pgTable(
  "monthly_summary_cache",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    queryType: varchar("query_type", { length: 32 }).notNull(), // count | target | paid | due | notYetDue | installTotal
    approveMonth: varchar("approve_month", { length: 7 }).notNull(), // YYYY-MM
    bucket: varchar("bucket", { length: 32 }).notNull(),
    // Filter dimensions (NULL = ทั้งหมด ไม่ได้ filter)
    productType: varchar("product_type", { length: 64 }),
    deviceFamily: varchar("device_family", { length: 16 }), // iOS | Android | NULL
    dateMonth: varchar("date_month", { length: 7 }), // YYYY-MM ของ due_month หรือ paid_at_month (NULL = ทั้งหมด)
    // Aggregated values
    contractCount: integer("contract_count").notNull().default(0),
    principal: decimal("principal", { precision: 18, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 18, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 18, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 18, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 18, scale: 2 }).notNull().default("0"),
    discount: decimal("discount", { precision: 18, scale: 2 }).notNull().default("0"),
    overpaid: decimal("overpaid", { precision: 18, scale: 2 }).notNull().default("0"),
    badDebt: decimal("bad_debt", { precision: 18, scale: 2 }).notNull().default("0"),
    badDebtInstallment: decimal("bad_debt_installment", { precision: 18, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Unique key: section + queryType + approveMonth + bucket + all filter dims
    mscUniqueIdx: uniqueIndex("msc_unique_idx").on(
      t.section,
      t.queryType,
      t.approveMonth,
      t.bucket,
      t.productType,
      t.deviceFamily,
      t.dateMonth,
    ),
    mscSectionQueryIdx: index("msc_section_query_idx").on(t.section, t.queryType),
    mscSectionMonthIdx: index("msc_section_month_idx").on(t.section, t.approveMonth),
  }),
);
export type MonthlySummaryCache = typeof monthlySummaryCache.$inferSelect;

// ─── Monthly Summary Due Month Cache (pre-aggregated per approve_month × due_month) ─
// ใช้สำหรับ Mode "เดือนที่ต้องชำระ" ใน Combined Tab ของ /monthly-summary
export const monthlySummaryDueMonthCache = pgTable(
  "monthly_summary_due_month_cache",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    queryType: varchar("query_type", { length: 32 }).notNull(), // count | target | due | notYetDue | installTotal
    approveMonth: varchar("approve_month", { length: 7 }).notNull(), // YYYY-MM
    dueMonth: varchar("due_month", { length: 7 }).notNull(),         // YYYY-MM ของ due_date
    // Filter dimensions (NULL = ทั้งหมด ไม่ได้ filter)
    productType: varchar("product_type", { length: 64 }),
    deviceFamily: varchar("device_family", { length: 16 }), // iOS | Android | NULL
    // Aggregated values
    contractCount: integer("contract_count").notNull().default(0),
    principal: decimal("principal", { precision: 18, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 18, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 18, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 18, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 18, scale: 2 }).notNull().default("0"),
    discount: decimal("discount", { precision: 18, scale: 2 }).notNull().default("0"),
    overpaid: decimal("overpaid", { precision: 18, scale: 2 }).notNull().default("0"),
    badDebt: decimal("bad_debt", { precision: 18, scale: 2 }).notNull().default("0"),
    badDebtInstallment: decimal("bad_debt_installment", { precision: 18, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    financeTotal: decimal("finance_total", { precision: 18, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    msdmcUniqueIdx: uniqueIndex("msdmc_unique_idx").on(
      t.section,
      t.queryType,
      t.approveMonth,
      t.dueMonth,
      t.productType,
      t.deviceFamily,
    ),
    msdmcSectionQueryIdx: index("msdmc_section_query_idx").on(t.section, t.queryType),
    msdmcSectionApproveIdx: index("msdmc_section_approve_idx").on(t.section, t.approveMonth),
    msdmcSectionDueIdx: index("msdmc_section_due_idx").on(t.section, t.dueMonth),
  }),
);
export type MonthlySummaryDueMonthCache = typeof monthlySummaryDueMonthCache.$inferSelect;

// ─── Monthly Collection Snapshot ─────────────────────────────────────────────
// เก็บ snapshot รายเดือนสำหรับฟีเจอร์ "รายเดือน" ใน DebtReport (เป้า-ยอดเก็บหนี้)
// - target_amount: เป้าเก็บหนี้ (freeze วันที่ 1 ของเดือน)
// - collected_amount: ยอดเก็บหนี้ (freeze หลังสิ้นเดือน)
// - install_total: ยอดผ่อนรวมทั้งสัญญา (สำหรับคำนวณ %)
export const monthlyCollectionSnapshot = pgTable(
  "monthly_collection_snapshot",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    collectionMonth: varchar("collection_month", { length: 7 }).notNull(), // YYYY-MM

    // เป้าเก็บหนี้ (frozen วันที่ 1 ของ collection_month)
    targetAmount: decimal("target_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    targetContractCount: integer("target_contract_count").notNull().default(0),
    targetFrozenAt: timestamp("target_frozen_at"),

    // ยอดเก็บหนี้ (frozen หลังสิ้นเดือน)
    collectedAmount: decimal("collected_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedContractCount: integer("collected_contract_count").notNull().default(0),
    collectedFrozenAt: timestamp("collected_frozen_at"),
    collectedIsFrozen: boolean("collected_is_frozen").notNull().default(false),

    // ยอดผ่อนรวมทั้งสัญญา (สำหรับคำนวณ % เทียบ)
    installTotal: decimal("install_total", { precision: 18, scale: 2 }).notNull().default("0"),

    // Breakdown เป้าเก็บหนี้
    targetPrincipal: decimal("target_principal", { precision: 18, scale: 2 }).notNull().default("0"),
    targetInterest: decimal("target_interest", { precision: 18, scale: 2 }).notNull().default("0"),
    targetFee: decimal("target_fee", { precision: 18, scale: 2 }).notNull().default("0"),
    targetPenalty: decimal("target_penalty", { precision: 18, scale: 2 }).notNull().default("0"),
    targetUnlockFee: decimal("target_unlock_fee", { precision: 18, scale: 2 }).notNull().default("0"),

    // Breakdown ยอดเก็บหนี้
    collectedPrincipal: decimal("collected_principal", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedInterest: decimal("collected_interest", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedFee: decimal("collected_fee", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedPenalty: decimal("collected_penalty", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedUnlockFee: decimal("collected_unlock_fee", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedDiscount: decimal("collected_discount", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedOverpaid: decimal("collected_overpaid", { precision: 18, scale: 2 }).notNull().default("0"),
    collectedBadDebt: decimal("collected_bad_debt", { precision: 18, scale: 2 }).notNull().default("0"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Unique: 1 row per section per collection_month
    mcsSectionMonthIdx: uniqueIndex("mcs_section_month_idx").on(t.section, t.collectionMonth),
    mcsSectionIdx: index("mcs_section_idx").on(t.section),
    mcsCollectionMonthIdx: index("mcs_collection_month_idx").on(t.collectionMonth),
  }),
);
export type MonthlyCollectionSnapshot = typeof monthlyCollectionSnapshot.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// monthly_target_detail_snapshot
// เก็บ snapshot รายสัญญา ณ วันที่ 1 ของทุกเดือน (freeze ตลอด)
// ใช้สำหรับ Lightbox "ยอดเก็บหนี้" ใน tab รายเดือน
// ─────────────────────────────────────────────────────────────────────────────
export const monthlyTargetDetailSnapshot = pgTable(
  "monthly_target_detail_snapshot",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    snapshotMonth: varchar("snapshot_month", { length: 7 }).notNull(), // YYYY-MM
    // ข้อมูลสัญญา
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    partnerCode: varchar("partner_code", { length: 255 }),
    partnerName: varchar("partner_name", { length: 255 }),
    approveDate: varchar("approve_date", { length: 20 }),
    productType: varchar("product_type", { length: 64 }),
    device: varchar("device", { length: 64 }),
    model: varchar("model", { length: 128 }),
    financeAmount: decimal("finance_amount", { precision: 12, scale: 2 }),
    installmentCount: integer("installment_count"),
    baselineAmount: decimal("baseline_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // ข้อมูลงวด
    period: integer("period"),
    dueDate: varchar("due_date", { length: 20 }),
    principal: decimal("principal", { precision: 12, scale: 2 }).notNull().default("0"),
    interest: decimal("interest", { precision: 12, scale: 2 }).notNull().default("0"),
    fee: decimal("fee", { precision: 12, scale: 2 }).notNull().default("0"),
    penalty: decimal("penalty", { precision: 12, scale: 2 }).notNull().default("0"),
    unlockFee: decimal("unlock_fee", { precision: 12, scale: 2 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    paidAmount: decimal("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // สถานะ
    contractStatus: varchar("contract_status", { length: 32 }),
    debtRange: varchar("debt_range", { length: 32 }),
    isPaid: boolean("is_paid").notNull().default(false),
    isArrears: boolean("is_arrears").notNull().default(false),
    isBadDebt: boolean("is_bad_debt").notNull().default(false),
    isClosed: boolean("is_closed").notNull().default(false),
    isSuspended: boolean("is_suspended").notNull().default(false),
    isCurrentPeriod: boolean("is_current_period").notNull().default(false),
    isFuturePeriod: boolean("is_future_period").notNull().default(false),
    // เวลาที่ populate
    populatedAt: timestamp("populated_at").defaultNow().notNull(),
  },
  (t) => ({
    // index สำหรับ query
    mtdsSectionMonthIdx: index("mtds_section_month_idx").on(t.section, t.snapshotMonth),
    mtdsSectionMonthContractIdx: index("mtds_section_month_contract_idx").on(
      t.section,
      t.snapshotMonth,
      t.contractExternalId,
    ),
    mtdsSectionMonthDueIdx: index("mtds_section_month_due_idx").on(
      t.section,
      t.snapshotMonth,
      t.dueDate,
    ),
  }),
);
export type MonthlyTargetDetailSnapshot = typeof monthlyTargetDetailSnapshot.$inferSelect;

// ─── Device Location Logs (GPS History) ──────────────────────────────────────
// เก็บประวัติตำแหน่ง GPS ของอุปกรณ์ที่ online+locked ระหว่าง MDM sync
// append-only: ไม่ลบของเก่า ไม่ล้างเมื่อ sync ใหม่
export const deviceLocationLogs = pgTable(
  "device_location_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 64 }).notNull(),
    serialNo: varchar("serial_no", { length: 64 }).notNull(),
    mdmDeviceId: integer("mdm_device_id").notNull(),
    latitude: varchar("latitude", { length: 32 }).notNull(),
    longitude: varchar("longitude", { length: 32 }).notNull(),
    altitude: varchar("altitude", { length: 32 }),
    speed: varchar("speed", { length: 32 }),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionSerialIdx: index("dll_section_serial_idx").on(t.section, t.serialNo),
    sectionRecordedIdx: index("dll_section_recorded_idx").on(t.section, t.recordedAt),
  }),
);
export type DeviceLocationLog = typeof deviceLocationLogs.$inferSelect;

// ─── Notice: Print Batches ───────────────────────────────────────────────────
// บันทึกการกด "พิมพ์รายการที่เลือก" แต่ละครั้ง (1 batch = หลายสัญญา)
export const noticePrintBatches = pgTable(
  "notice_print_batches",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    printedBy: varchar("printed_by", { length: 128 }).notNull(),
    printedAt: timestamp("printed_at").defaultNow().notNull(),
    totalItems: integer("total_items").notNull().default(0),
    pdfFileUrl: text("pdf_file_url"),
    excelFileUrl: text("excel_file_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionPrintedIdx: index("npb_section_printed_idx").on(t.section, t.printedAt),
  }),
);
export type NoticePrintBatch = typeof noticePrintBatches.$inferSelect;

// ─── Notice: Print Logs ──────────────────────────────────────────────────────
// 1 แถว = การส่ง Notice 1 รอบของ 1 สัญญา (round 1/2/3)
// sentCount ของสัญญา = จำนวนแถวที่เหลืออยู่ (การ Restore จะลบแถวรอบล่าสุดออก)
export const noticePrintLogs = pgTable(
  "notice_print_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }),
    noticeRound: integer("notice_round").notNull(),
    printedBy: varchar("printed_by", { length: 128 }).notNull(),
    printedAt: timestamp("printed_at").defaultNow().notNull(),
    batchId: integer("batch_id"),
    pdfFileUrl: text("pdf_file_url"),
    excelFileUrl: text("excel_file_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionContractIdx: index("npl_section_contract_idx").on(t.section, t.contractExternalId),
    sectionPrintedByIdx: index("npl_section_printed_by_idx").on(t.section, t.printedBy),
    sectionPrintedAtIdx: index("npl_section_printed_at_idx").on(t.section, t.printedAt),
  }),
);
export type NoticePrintLog = typeof noticePrintLogs.$inferSelect;

// ─── Notice: Restore Logs (audit) ────────────────────────────────────────────
// บันทึกการยกเลิก (Restore) รอบส่งล่าสุด — ใช้แสดงในคอลัมน์ "Log การแก้ไข"
export const noticeRestoreLogs = pgTable(
  "notice_restore_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: varchar("section", { length: 32 }).notNull(),
    contractExternalId: varchar("contract_external_id", { length: 64 }).notNull(),
    contractNo: varchar("contract_no", { length: 64 }),
    noticeRound: integer("notice_round").notNull(),
    restoredBy: varchar("restored_by", { length: 128 }).notNull(),
    restoredAt: timestamp("restored_at").defaultNow().notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    sectionContractIdx: index("nrl_section_contract_idx").on(t.section, t.contractExternalId),
    sectionRestoredByIdx: index("nrl_section_restored_by_idx").on(t.section, t.restoredBy),
  }),
);
export type NoticeRestoreLog = typeof noticeRestoreLogs.$inferSelect;

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  appGroupPermissions,
  appGroups,
  appUsers,
  contracts,
  installments,
  paymentTransactions,
} from "../drizzle/schema";
import {
  MENU_CODES,
  SUPER_ADMIN_GROUP,
  SUPER_ADMIN_USERNAME,
} from "../shared/const";
import {
  getSectionDatabases,
  loadStagingEnv,
  maskDatabaseUrl,
  type SectionDbConfig,
} from "./stagingEnv";

type Db = ReturnType<typeof drizzle>;

const envFile = process.argv[2] ?? ".env.staging";
loadStagingEnv(envFile);

function makePool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });
}

async function ensureSuperAdmin(db: Db) {
  const existingGroup = await db
    .select()
    .from(appGroups)
    .where(eq(appGroups.name, SUPER_ADMIN_GROUP))
    .limit(1);

  let groupId = existingGroup[0]?.id;
  if (!groupId) {
    const [group] = await db
      .insert(appGroups)
      .values({
        name: SUPER_ADMIN_GROUP,
        description: "Full access to every menu and action.",
        isSuperAdmin: true,
        allowedSections: "Boonphone,Fastfone365",
      })
      .returning({ id: appGroups.id });
    groupId = group.id;
  }

  for (const menuCode of MENU_CODES) {
    await db
      .insert(appGroupPermissions)
      .values({
        groupId,
        menuCode,
        canView: true,
        canAdd: true,
        canEdit: true,
        canDelete: true,
        canApprove: true,
        canExport: true,
        canSync: true,
      })
      .onConflictDoUpdate({
        target: [appGroupPermissions.groupId, appGroupPermissions.menuCode],
        set: {
          canView: true,
          canAdd: true,
          canEdit: true,
          canDelete: true,
          canApprove: true,
          canExport: true,
          canSync: true,
        },
      });
  }

  const existingUser = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.username, SUPER_ADMIN_USERNAME))
    .limit(1);

  if (existingUser.length === 0) {
    const passwordHash = await bcrypt.hash("Aa123456+", 10);
    await db.insert(appUsers).values({
      username: SUPER_ADMIN_USERNAME,
      passwordHash,
      fullName: "Staging Super Admin",
      email: "staging-admin@example.test",
      groupId,
      isActive: true,
    });
  }
}

function sampleContracts(section: SectionDbConfig["section"]) {
  const prefix = section === "Boonphone" ? "BP" : "FF";
  return [
    {
      externalId: `staging-${prefix}-001`,
      contractNo: `${prefix}-STG-0001`,
      customerName: `${section} Staging Current`,
      citizenId: `${prefix}0000000001`,
      phone: "0800000001",
      status: "active",
      debtType: "normal",
      paidInstallments: 1,
      approveDate: "2026-01-15",
      submitDate: "2026-01-10",
      paymentDay: 15,
      deviceLock: false,
    },
    {
      externalId: `staging-${prefix}-002`,
      contractNo: `${prefix}-STG-0002`,
      customerName: `${section} Staging Overdue`,
      citizenId: `${prefix}0000000002`,
      phone: "0800000002",
      status: "active",
      debtType: "overdue",
      paidInstallments: 0,
      approveDate: "2025-12-20",
      submitDate: "2025-12-18",
      paymentDay: 20,
      deviceLock: true,
    },
    {
      externalId: `staging-${prefix}-003`,
      contractNo: `${prefix}-STG-0003`,
      customerName: `${section} Staging Closed`,
      citizenId: `${prefix}0000000003`,
      phone: "0800000003",
      status: "closed",
      debtType: "closed",
      paidInstallments: 3,
      approveDate: "2025-11-05",
      submitDate: "2025-11-01",
      paymentDay: 5,
      deviceLock: false,
    },
  ];
}

async function seedSectionData(db: Db, section: SectionDbConfig["section"]) {
  const rows = sampleContracts(section);

  for (const row of rows) {
    await db
      .insert(contracts)
      .values({
        section,
        externalId: row.externalId,
        contractNo: row.contractNo,
        submitDate: row.submitDate,
        approveDate: row.approveDate,
        channel: "staging",
        status: row.status,
        partnerCode: `${section.slice(0, 2).toUpperCase()}-PARTNER`,
        partnerName: "Staging Partner",
        partnerProvince: "Bangkok",
        partnerStatus: "active",
        commissionNet: "500.00",
        customerName: row.customerName,
        nationality: "TH",
        citizenId: row.citizenId,
        gender: "N/A",
        age: 30,
        occupation: "Tester",
        salary: "30000.00",
        workplace: "Staging Company",
        phone: row.phone,
        idDistrict: "Staging District",
        idProvince: "Bangkok",
        addrDistrict: "Staging District",
        addrProvince: "Bangkok",
        workDistrict: "Staging District",
        workProvince: "Bangkok",
        promotionName: "STAGING-PROMO",
        device: "Phone",
        productType: "Mobile",
        model: "Staging Model",
        imei: `${row.citizenId}IMEI`,
        serialNo: `${row.citizenId}SN`,
        sellPrice: "12000.00",
        deviceStatus: "active",
        downPayment: "1000.00",
        financeAmount: "11000.00",
        installmentCount: 3,
        multiplier: "1.00",
        installmentAmount: "4000.00",
        paymentDay: row.paymentDay,
        paidInstallments: row.paidInstallments,
        debtType: row.debtType,
        rawJson: { source: "staging-seed" },
        deviceLock: row.deviceLock,
        lossStatus: 0,
        mdmDeviceId: 1000 + rows.indexOf(row),
      })
      .onConflictDoUpdate({
        target: [contracts.section, contracts.externalId],
        set: {
          contractNo: row.contractNo,
          customerName: row.customerName,
          phone: row.phone,
          status: row.status,
          debtType: row.debtType,
          paidInstallments: row.paidInstallments,
          deviceLock: row.deviceLock,
          syncedAt: new Date(),
        },
      });

    for (let period = 1; period <= 3; period += 1) {
      const paidAmount = period <= row.paidInstallments ? "4000.00" : "0.00";
      const month = String(period).padStart(2, "0");
      await db
        .insert(installments)
        .values({
          section,
          externalId: `${row.externalId}-inst-${period}`,
          contractExternalId: row.externalId,
          contractNo: row.contractNo,
          period,
          dueDate: `2026-${month}-${String(row.paymentDay).padStart(2, "0")}`,
          amount: "4000.00",
          paidAmount,
          status: paidAmount === "0.00" ? "due" : "paid",
          rawJson: { source: "staging-seed" },
        })
        .onConflictDoUpdate({
          target: [installments.section, installments.externalId],
          set: {
            paidAmount,
            status: paidAmount === "0.00" ? "due" : "paid",
            syncedAt: new Date(),
          },
        });
    }

    if (row.paidInstallments > 0) {
      await db
        .insert(paymentTransactions)
        .values({
          section,
          externalId: `${row.externalId}-pay-1`,
          contractExternalId: row.externalId,
          contractNo: row.contractNo,
          customerName: row.customerName,
          paidAt: "2026-01-20 10:00:00",
          amount: "4000.00",
          method: "staging",
          status: "paid",
          receiptNo: `${row.contractNo}-R001`,
          periodNo: 1,
          incomeType: "installment",
          rawJson: { source: "staging-seed" },
        })
        .onConflictDoUpdate({
          target: [paymentTransactions.section, paymentTransactions.externalId],
          set: {
            paidAt: "2026-01-20 10:00:00",
            amount: "4000.00",
            status: "paid",
            syncedAt: new Date(),
          },
        });
    }
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contracts)
    .where(
      and(eq(contracts.section, section), eq(contracts.channel, "staging"))
    );

  console.log(
    `[staging] Seeded ${section} sample contracts: ${count ?? rows.length}`
  );
}

async function main() {
  const databases = getSectionDatabases();

  for (const config of databases) {
    console.log(
      `[staging] Seeding ${config.section}: ${maskDatabaseUrl(config.url)}`
    );
    const pool = makePool(config.url);
    const db = drizzle(pool);
    try {
      if (config.section === "Boonphone") {
        await ensureSuperAdmin(db);
      }
      await seedSectionData(db, config.section);
    } finally {
      await pool.end();
    }
  }

  console.log("[staging] Seed completed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

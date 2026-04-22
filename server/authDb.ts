/**
 * Database helpers for the Report System's custom authentication
 * (independent from Manus OAuth).
 */
import { and, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import bcrypt from "bcryptjs";
import {
  appGroupPermissions,
  appGroups,
  appSessions,
  appUsers,
  type AppGroupPermission,
  type AppGroup,
  type AppUser,
} from "../drizzle/schema";
import {
  APP_SESSION_TTL_MS,
  MENU_CODES,
  SUPER_ADMIN_GROUP,
  SUPER_ADMIN_USERNAME,
  type MenuCode,
  type PermissionAction,
} from "../shared/const";
import { getDb } from "./db";

export type AppUserWithGroup = AppUser & {
  group: AppGroup;
  permissions: AppGroupPermission[];
};

/* --------------------------------------------------------------------------
 * Seeding
 * ------------------------------------------------------------------------ */

/** Ensures the Super Admin group + default Sadmin user exist. */
export async function seedSuperAdmin(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[authDb] Cannot seed: database unavailable");
    return;
  }

  // 1. Super Admin group
  const existing = await db
    .select()
    .from(appGroups)
    .where(eq(appGroups.name, SUPER_ADMIN_GROUP))
    .limit(1);

  let groupId: number;
  if (existing.length === 0) {
    const [res] = await db.insert(appGroups).values({
      name: SUPER_ADMIN_GROUP,
      description: "Full access to every menu and action.",
      isSuperAdmin: true,
    });
    groupId = Number((res as { insertId: number }).insertId);
    console.log(`[authDb] Created Super Admin group id=${groupId}`);
  } else {
    groupId = existing[0].id;
  }

  // 2. Seed permission matrix for Super Admin group (all true)
  for (const menu of MENU_CODES) {
    const perm = await db
      .select()
      .from(appGroupPermissions)
      .where(
        and(
          eq(appGroupPermissions.groupId, groupId),
          eq(appGroupPermissions.menuCode, menu),
        ),
      )
      .limit(1);

    if (perm.length === 0) {
      await db.insert(appGroupPermissions).values({
        groupId,
        menuCode: menu,
        canView: true,
        canAdd: true,
        canEdit: true,
        canDelete: true,
        canApprove: true,
        canExport: true,
      });
    }
  }

  // 3. Default Sadmin user
  const existingUser = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.username, SUPER_ADMIN_USERNAME))
    .limit(1);

  if (existingUser.length === 0) {
    const hash = await bcrypt.hash("Aa123456+", 10);
    await db.insert(appUsers).values({
      username: SUPER_ADMIN_USERNAME,
      passwordHash: hash,
      fullName: "Super Admin",
      groupId,
      isActive: true,
    });
    console.log(`[authDb] Created default user '${SUPER_ADMIN_USERNAME}'`);
  }
}

/* --------------------------------------------------------------------------
 * Authentication
 * ------------------------------------------------------------------------ */

export async function authenticate(
  username: string,
  password: string,
): Promise<AppUser | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.username, username))
    .limit(1);

  const user = rows[0];
  if (!user) return null;
  if (!user.isActive) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  await db
    .update(appUsers)
    .set({ lastLoginAt: new Date() })
    .where(eq(appUsers.id, user.id));

  return user;
}

export async function createSession(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const id = nanoid(48);
  const expiresAt = new Date(Date.now() + APP_SESSION_TTL_MS);

  await db.insert(appSessions).values({ id, userId, expiresAt });
  return id;
}

export async function getUserFromSession(
  sessionId: string,
): Promise<AppUserWithGroup | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.id, sessionId), gt(appSessions.expiresAt, new Date())))
    .limit(1);

  const session = rows[0];
  if (!session) return null;

  const userRows = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.id, session.userId))
    .limit(1);
  const user = userRows[0];
  if (!user || !user.isActive) return null;

  const groupRows = await db
    .select()
    .from(appGroups)
    .where(eq(appGroups.id, user.groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) return null;

  const permissions = await db
    .select()
    .from(appGroupPermissions)
    .where(eq(appGroupPermissions.groupId, group.id));

  return { ...user, group, permissions };
}

export async function destroySession(sessionId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(appSessions).where(eq(appSessions.id, sessionId));
}

/* --------------------------------------------------------------------------
 * Permission helpers
 * ------------------------------------------------------------------------ */

export function checkPermission(
  user: AppUserWithGroup,
  menu: MenuCode,
  action: PermissionAction,
): boolean {
  if (user.group.isSuperAdmin) return true;

  const perm = user.permissions.find((p) => p.menuCode === menu);
  if (!perm) return false;

  switch (action) {
    case "view":
      return perm.canView;
    case "add":
      return perm.canAdd;
    case "edit":
      return perm.canEdit;
    case "delete":
      return perm.canDelete;
    case "approve":
      return perm.canApprove;
    case "export":
      return perm.canExport;
  }
}

/* --------------------------------------------------------------------------
 * User/Group CRUD (Super Admin only at call site)
 * ------------------------------------------------------------------------ */

export async function listUsers() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: appUsers.id,
      username: appUsers.username,
      fullName: appUsers.fullName,
      email: appUsers.email,
      groupId: appUsers.groupId,
      groupName: appGroups.name,
      isActive: appUsers.isActive,
      lastLoginAt: appUsers.lastLoginAt,
      createdAt: appUsers.createdAt,
    })
    .from(appUsers)
    .leftJoin(appGroups, eq(appGroups.id, appUsers.groupId))
    .orderBy(appUsers.id);
}

export async function createUser(input: {
  username: string;
  password: string;
  fullName?: string | null;
  email?: string | null;
  groupId: number;
  isActive?: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const hash = await bcrypt.hash(input.password, 10);
  await db.insert(appUsers).values({
    username: input.username,
    passwordHash: hash,
    fullName: input.fullName ?? null,
    email: input.email ?? null,
    groupId: input.groupId,
    isActive: input.isActive ?? true,
  });
}

export async function updateUser(
  id: number,
  patch: Partial<{
    fullName: string | null;
    email: string | null;
    groupId: number;
    isActive: boolean;
  }>,
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(appUsers).set(patch).where(eq(appUsers.id, id));
}

export async function changeUserPassword(id: number, newPassword: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const hash = await bcrypt.hash(newPassword, 10);
  await db
    .update(appUsers)
    .set({ passwordHash: hash })
    .where(eq(appUsers.id, id));
}

export async function deleteUser(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(appSessions).where(eq(appSessions.userId, id));
  await db.delete(appUsers).where(eq(appUsers.id, id));
}

export async function listGroupsWithPermissions() {
  const db = await getDb();
  if (!db) return [];
  const groups = await db.select().from(appGroups).orderBy(appGroups.id);
  const permissions = await db.select().from(appGroupPermissions);
  return groups.map((g) => ({
    ...g,
    permissions: permissions.filter((p) => p.groupId === g.id),
  }));
}

export async function createGroup(input: {
  name: string;
  description?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [res] = await db.insert(appGroups).values({
    name: input.name,
    description: input.description ?? null,
    isSuperAdmin: false,
  });
  const id = Number((res as { insertId: number }).insertId);

  // default: all permissions = false
  for (const menu of MENU_CODES) {
    await db.insert(appGroupPermissions).values({
      groupId: id,
      menuCode: menu,
    });
  }
  return id;
}

export async function updateGroup(
  id: number,
  patch: { name?: string; description?: string | null },
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(appGroups).set(patch).where(eq(appGroups.id, id));
}

export async function deleteGroup(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  // Protect super admin
  const rows = await db.select().from(appGroups).where(eq(appGroups.id, id)).limit(1);
  if (rows[0]?.isSuperAdmin) {
    throw new Error("Cannot delete Super Admin group");
  }
  await db.delete(appGroupPermissions).where(eq(appGroupPermissions.groupId, id));
  await db.delete(appGroups).where(eq(appGroups.id, id));
}

export async function updateGroupPermission(
  groupId: number,
  menuCode: MenuCode,
  patch: Partial<{
    canView: boolean;
    canAdd: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canApprove: boolean;
    canExport: boolean;
  }>,
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  // Ensure a row exists first
  const existing = await db
    .select()
    .from(appGroupPermissions)
    .where(
      and(
        eq(appGroupPermissions.groupId, groupId),
        eq(appGroupPermissions.menuCode, menuCode),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    await db.insert(appGroupPermissions).values({
      groupId,
      menuCode,
      canView: patch.canView ?? false,
      canAdd: patch.canAdd ?? false,
      canEdit: patch.canEdit ?? false,
      canDelete: patch.canDelete ?? false,
      canApprove: patch.canApprove ?? false,
      canExport: patch.canExport ?? false,
    });
  } else {
    await db
      .update(appGroupPermissions)
      .set(patch)
      .where(
        and(
          eq(appGroupPermissions.groupId, groupId),
          eq(appGroupPermissions.menuCode, menuCode),
        ),
      );
  }
}

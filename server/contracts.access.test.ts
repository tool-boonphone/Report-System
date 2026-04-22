import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import type { AppGroup, AppGroupPermission, AppUser } from "../drizzle/schema";
import type { AppUserWithGroup } from "./authDb";

type ReqRes = Pick<TrpcContext, "req" | "res">;

function mkReqRes(): ReqRes {
  return {
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => undefined,
      cookie: () => undefined,
    } as unknown as TrpcContext["res"],
  };
}

function mkGroup(opts: { isSuperAdmin: boolean }): AppGroup {
  return {
    id: 1,
    name: opts.isSuperAdmin ? "Super Admin" : "Agent",
    description: null,
    isSuperAdmin: opts.isSuperAdmin,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mkUser(group: AppGroup, perms: Partial<AppGroupPermission>[] = []): AppUserWithGroup {
  const base: AppUser = {
    id: 10,
    username: group.isSuperAdmin ? "Sadmin" : "viewer",
    passwordHash: "",
    fullName: group.isSuperAdmin ? "Super Admin" : "Viewer",
    email: null,
    groupId: group.id,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const permissions: AppGroupPermission[] = perms.map((p, idx) => ({
    id: idx + 1,
    groupId: group.id,
    menuCode: p.menuCode ?? "contract",
    canView: p.canView ?? false,
    canAdd: p.canAdd ?? false,
    canEdit: p.canEdit ?? false,
    canDelete: p.canDelete ?? false,
    canApprove: p.canApprove ?? false,
    canExport: p.canExport ?? false,
  }));
  return { ...base, group, permissions };
}

describe("contracts router access control", () => {
  it("rejects unauthenticated access", async () => {
    const ctx: TrpcContext = { ...mkReqRes(), user: null, appUser: null };
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.contracts.list({ section: "Boonphone", page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a logged-in user without view permission", async () => {
    const group = mkGroup({ isSuperAdmin: false });
    const user = mkUser(group, [{ menuCode: "contract", canView: false }]);
    const ctx: TrpcContext = { ...mkReqRes(), user: null, appUser: user };
    const caller = appRouter.createCaller(ctx);
    try {
      await caller.contracts.list({ section: "Boonphone", page: 1, pageSize: 10 });
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
  });

  it("allows Super Admin to query filter options", async () => {
    const group = mkGroup({ isSuperAdmin: true });
    const user = mkUser(group);
    const ctx: TrpcContext = { ...mkReqRes(), user: null, appUser: user };
    const caller = appRouter.createCaller(ctx);
    const out = await caller.contracts.filterOptions({ section: "Boonphone" });
    // Should return an object with at least the expected keys.
    expect(out).toHaveProperty("statuses");
    expect(out).toHaveProperty("debtTypes");
    expect(out).toHaveProperty("partnerCodes");
  });
});

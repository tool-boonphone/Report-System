import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import type { AppGroup, AppGroupPermission, AppUser } from "../drizzle/schema";
import type { AppUserWithGroup } from "./authDb";

type ReqRes = Pick<TrpcContext, "req" | "res">;

function mkReqRes(): ReqRes {
  return {
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: () => undefined,
      cookie: () => undefined,
    } as unknown as TrpcContext["res"],
  };
}

function mkGroup(isSuperAdmin: boolean): AppGroup {
  return {
    id: 1,
    name: isSuperAdmin ? "Super Admin" : "Agent",
    description: null,
    isSuperAdmin,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mkUser(
  group: AppGroup,
  perms: Partial<AppGroupPermission>[] = [],
): AppUserWithGroup {
  const base: AppUser = {
    id: 20,
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
    menuCode: p.menuCode ?? "debt_report",
    canView: p.canView ?? false,
    canAdd: p.canAdd ?? false,
    canEdit: p.canEdit ?? false,
    canDelete: p.canDelete ?? false,
    canApprove: p.canApprove ?? false,
    canExport: p.canExport ?? false,
  }));
  return { ...base, group, permissions };
}

describe("debt router access control", () => {
  it("rejects unauthenticated access", async () => {
    const ctx: TrpcContext = { ...mkReqRes(), user: null, appUser: null };
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.debt.summary({
        section: "Boonphone",
        from: "2026-01-01",
        to: "2026-12-31",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a logged-in user without debt_report.view", async () => {
    const group = mkGroup(false);
    const user = mkUser(group, [{ menuCode: "debt_report", canView: false }]);
    const ctx: TrpcContext = { ...mkReqRes(), user: null, appUser: user };
    const caller = appRouter.createCaller(ctx);
    try {
      await caller.debt.summary({
        section: "Boonphone",
        from: "2026-01-01",
        to: "2026-12-31",
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
  });

  // TiDB can take several seconds for the 42k-row aggregation on a cold
  // connection, so we raise the timeout to 15s for this one integration test.
  it("allows Super Admin to query the debt summary (returns shape)", async () => {
    const group = mkGroup(true);
    const user = mkUser(group);
    const ctx: TrpcContext = { ...mkReqRes(), user: null, appUser: user };
    const caller = appRouter.createCaller(ctx);
    const out = await caller.debt.summary({
      section: "Boonphone",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    // Must always return a well-formed shape (even with 0 rows).
    expect(out).toHaveProperty("summary");
    expect(out).toHaveProperty("monthly");
    expect(out.summary).toHaveProperty("target");
    expect(out.summary).toHaveProperty("collected");
    expect(out.summary).toHaveProperty("gap");
    expect(out.summary).toHaveProperty("rate");
  }, 15000);
});

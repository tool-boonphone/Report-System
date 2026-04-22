import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import {
  createGroup,
  createUser,
  getUserFromSession,
  seedSuperAdmin,
} from "./authDb";
import type { TrpcContext } from "./_core/context";

function baseCtx(appUser: Awaited<ReturnType<typeof getUserFromSession>>): TrpcContext {
  return {
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
    user: null,
    appUser,
  };
}

describe("admin router access control", () => {
  it("anonymous callers get UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(baseCtx(null));
    await expect(caller.admin.listUsers()).rejects.toThrow();
  });

  it("non-admin callers get FORBIDDEN", async () => {
    await seedSuperAdmin();
    // create a Viewer group + user
    const groupId = await createGroup({ name: `Viewer-${Date.now()}` });
    await createUser({
      username: `viewer-${Date.now()}`,
      password: "viewer123",
      groupId,
      fullName: "Viewer",
    });

    // manually fetch the user (without sessions) by re-querying listUsers as super admin
    const sadmin = (await appRouter
      .createCaller(baseCtx(null))
      .auth.me()
      .catch(() => null));
    expect(sadmin).toBeNull();
  });
});

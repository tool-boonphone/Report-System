import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function anonCtx(): TrpcContext {
  return {
    user: null,
    appUser: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: { clearCookie: () => {} } as any,
  };
}

describe("sync.* access control", () => {
  it("rejects unauthenticated calls to sync.trigger", async () => {
    const caller = appRouter.createCaller(anonCtx());
    await expect(
      caller.sync.trigger({ section: "Boonphone" as any }),
    ).rejects.toThrow();
  });

  it("rejects unauthenticated calls to sync.status", async () => {
    const caller = appRouter.createCaller(anonCtx());
    await expect(caller.sync.status()).rejects.toThrow();
  });
});

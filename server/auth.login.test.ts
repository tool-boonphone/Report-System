import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { seedSuperAdmin, getUserFromSession } from "./authDb";
import { APP_SESSION_COOKIE, SUPER_ADMIN_USERNAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

function mkCtx(sessionId?: string): {
  ctx: TrpcContext;
  setCookies: Array<{ name: string; value: string; options: Record<string, unknown> }>;
  clearedCookies: string[];
} {
  const setCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const clearedCookies: string[] = [];

  const req = {
    protocol: "https",
    headers: {
      cookie: sessionId ? `${APP_SESSION_COOKIE}=${sessionId}` : "",
    },
  } as TrpcContext["req"];

  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      setCookies.push({ name, value, options });
    },
    clearCookie: (name: string) => {
      clearedCookies.push(name);
    },
  } as unknown as TrpcContext["res"];

  return {
    ctx: { req, res, user: null, appUser: null },
    setCookies,
    clearedCookies,
  };
}

describe("auth router", () => {
  it("seeds Super Admin and logs in with default credentials", async () => {
    await seedSuperAdmin();

    const { ctx, setCookies } = mkCtx();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.login({
      username: SUPER_ADMIN_USERNAME,
      password: "Aa123456+",
    });

    expect(result).toEqual({ success: true });
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0].name).toBe(APP_SESSION_COOKIE);
    expect(setCookies[0].value.length).toBeGreaterThan(10);

    // session is resolvable → user returned
    const u = await getUserFromSession(setCookies[0].value);
    expect(u?.username).toBe(SUPER_ADMIN_USERNAME);
    expect(u?.group.isSuperAdmin).toBe(true);
  });

  it("rejects invalid password", async () => {
    await seedSuperAdmin();
    const { ctx } = mkCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.login({ username: SUPER_ADMIN_USERNAME, password: "wrong" }),
    ).rejects.toThrow();
  });

  it("me returns null when no session cookie", async () => {
    const { ctx } = mkCtx();
    const caller = appRouter.createCaller(ctx);
    const me = await caller.auth.me();
    expect(me).toBeNull();
  });

  it("logout clears the session cookie", async () => {
    await seedSuperAdmin();
    // first login to obtain a valid sid
    const login = mkCtx();
    const loginCaller = appRouter.createCaller(login.ctx);
    await loginCaller.auth.login({
      username: SUPER_ADMIN_USERNAME,
      password: "Aa123456+",
    });
    const sid = login.setCookies[0].value;

    const { ctx, clearedCookies } = mkCtx(sid);
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(clearedCookies).toContain(APP_SESSION_COOKIE);
  });
});

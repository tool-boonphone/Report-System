/**
 * accounting.test.ts — Unit tests for accounting router (income + expense)
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user,
    req: {
      cookies: {},
      headers: {},
    } as TrpcContext["req"],
    res: {
      cookie: () => {},
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };
  return { ctx };
}

describe("accounting.listIncome", () => {
  it("returns rows and total for valid section", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.accounting.listIncome({
      section: "Boonphone",
      page: 1,
      pageSize: 10,
    });
    expect(result).toHaveProperty("rows");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.rows)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  it("returns empty for invalid section", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.accounting.listIncome({
      section: "InvalidSection",
      page: 1,
      pageSize: 10,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("accounting.listExpense", () => {
  it("returns rows and total for valid section", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.accounting.listExpense({
      section: "Boonphone",
      page: 1,
      pageSize: 10,
    });
    expect(result).toHaveProperty("rows");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.rows)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  it("returns empty for invalid section", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.accounting.listExpense({
      section: "InvalidSection",
      page: 1,
      pageSize: 10,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("accounting.listIncomeUpdatedBy", () => {
  it("returns array of strings for valid section", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.accounting.listIncomeUpdatedBy({
      section: "Boonphone",
    });
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns empty array for invalid section", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.accounting.listIncomeUpdatedBy({
      section: "InvalidSection",
    });
    expect(result).toHaveLength(0);
  });
});

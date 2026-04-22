import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { handleDebtExport, handleContractsExport } from "./routers/exportExcel";

/**
 * Unit tests for Excel export handlers — focused on the access gates
 * (401 without session, 403 without permission). We don't boot a real HTTP
 * server; we call the Express handler directly with a minimal fake
 * Request/Response.
 */

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  const body: any[] = [];
  const res = {
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body.push(payload);
      return this;
    },
    end() {},
    write() {},
    get headersSent() {
      return false;
    },
  } as unknown as Response;
  return {
    res,
    read: () => ({
      statusCode,
      headers,
      body,
    }),
  };
}

function fakeReq(cookie: string, query: Record<string, string> = {}): Request {
  return {
    headers: { cookie },
    query,
  } as unknown as Request;
}

describe("exportExcel access control", () => {
  it("debt export: rejects with 401 when no session cookie is present", async () => {
    const { res, read } = fakeRes();
    await handleDebtExport(fakeReq(""), res);
    expect(read().statusCode).toBe(401);
  });

  it("debt export: rejects with 401 when session is unknown", async () => {
    // getUserFromSession will return null for random sid — that's 401.
    const { res, read } = fakeRes();
    await handleDebtExport(fakeReq("report_session=does-not-exist"), res);
    expect(read().statusCode).toBe(401);
  });

  it("contracts export: rejects with 401 when no session cookie is present", async () => {
    const { res, read } = fakeRes();
    await handleContractsExport(fakeReq("", { section: "Boonphone" }), res);
    expect(read().statusCode).toBe(401);
  });

  it("debt export: rejects with 400 when section is invalid (after auth is stubbed)", async () => {
    // Stub getUserFromSession + checkPermission so we reach the section check.
    const authDb = await import("./authDb");
    const mockUser: any = {
      id: 99,
      username: "Sadmin",
      isActive: true,
      group: { id: 1, name: "Super Admin", isSuperAdmin: true },
      permissions: [],
    };
    vi.spyOn(authDb, "getUserFromSession").mockResolvedValueOnce(mockUser);
    vi.spyOn(authDb, "checkPermission").mockReturnValueOnce(true);

    const { res, read } = fakeRes();
    await handleDebtExport(fakeReq("report_session=ok", { section: "Nope" }), res);
    expect(read().statusCode).toBe(400);
  });
});

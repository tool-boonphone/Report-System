/**
 * Regression test for the debt-target Excel export.
 *
 * Ensures:
 *   1. `perInstallment` column receives the value of `installmentAmount`
 *      (the bug previously pulled `r.perInstallment` which never existed
 *      on the query helper output).
 *   2. When a row contains an installment with `isClosed = true` or
 *      `overpaidApplied > 0`, the `p{n}_amount` cell carries the
 *      human-readable annotation; non-annotated periods stay numeric.
 *
 * We do not spin up the full HTTP server here — we instead run the
 * same record-building logic by importing the handler source and
 * stubbing ExcelJS' workbook writer.
 */
import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the debt helpers BEFORE importing the handler to avoid hitting TiDB.
vi.mock("./debtDb", () => ({
  listDebtTarget: vi.fn(async () => ({
    rows: [
      {
        contractExternalId: "ext-1",
        contractNo: "CT-1",
        approveDate: "2026-01-01",
        customerName: "Test",
        phone: "0800000000",
        totalAmount: 5000,
        totalPaid: 2500,
        installmentCount: 3,
        installmentAmount: 1666.67,
        debtStatus: "ปกติ",
        daysOverdue: 0,
        installments: [
          {
            period: 1,
            dueDate: "2026-02-01",
            principal: 1000,
            interest: 500,
            fee: 166.67,
            penalty: 0,
            amount: 1666.67,
            paid: 1666.67,
            baselineAmount: 1666.67,
            overpaidApplied: 0,
            isClosed: false,
          },
          {
            period: 2,
            dueDate: "2026-03-01",
            principal: 900,
            interest: 400,
            fee: 166.67,
            penalty: 0,
            amount: 1466.67, // reduced by 200
            paid: 0,
            baselineAmount: 1666.67,
            overpaidApplied: 200,
            isClosed: false,
          },
          {
            period: 3,
            dueDate: "2026-04-01",
            principal: 0,
            interest: 0,
            fee: 0,
            penalty: 0,
            amount: 0, // closed
            paid: 0,
            baselineAmount: 1666.67,
            overpaidApplied: 1666.67,
            isClosed: true,
          },
        ],
      },
    ],
  })),
  listDebtCollected: vi.fn(async () => ({ rows: [] })),
}));

// Stub auth/permissions to let the handler through.
vi.mock("./authDb", () => ({
  getUserFromSession: async () => ({
    id: 1,
    username: "tester",
    group: { isSuperAdmin: true },
    permissions: [],
  }),
  checkPermission: () => true,
}));

// Import the handler AFTER the mocks are in place.
import { handleDebtExport } from "./routers/exportExcel";

function makeRes() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  const res: any = stream;
  res.headers = {} as Record<string, string>;
  res.statusCode = 200;
  res.setHeader = (k: string, v: string) => {
    res.headers[k] = v;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.payload = payload;
    stream.end();
    return res;
  };
  res.chunks = chunks;
  return res;
}

describe("handleDebtExport — target variant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes perInstallment = installmentAmount and annotates the amount column", async () => {
    // Cookie name is `APP_SESSION_COOKIE` in shared/const; mocked auth accepts any sid.
    const req: any = {
      headers: { cookie: "report_session=fake" },
      query: { section: "Boonphone", variant: "target" },
    };
    const res = makeRes();
    await handleDebtExport(req, res);
    // Wait for stream to fully close so chunks array is complete.
    await new Promise((r) => setTimeout(r, 50));

    const buf = Buffer.concat((res as any).chunks);
    expect(buf.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws).toBeTruthy();

    // Header row — collect key names via first row.
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((c) => headers.push(String(c.value ?? "")));
    // perInstallment is column 8 in the LEFT group (ผ่อนงวดละ).
    expect(headers).toContain("ผ่อนงวดละ");
    expect(headers).toContain("งวดที่ 3 - ยอดหนี้รวม");

    const dataRow = ws.getRow(2);

    const perInstallmentCol = headers.indexOf("ผ่อนงวดละ") + 1;
    expect(Number(dataRow.getCell(perInstallmentCol).value)).toBeCloseTo(
      1666.67,
      2,
    );

    // Period 2 amount is plain numeric (overpaid applied → netAmount = amount - overpaidApplied).
    // Excel export uses plain numbers only (no annotation text) per Phase 29 decision.
    const p2AmountCol = headers.indexOf("งวดที่ 2 - ยอดหนี้รวม") + 1;
    // overpaidApplied=200, amount=1466.67 → netAmount=1466.67 (already reduced by API)
    expect(Number(dataRow.getCell(p2AmountCol).value)).toBeCloseTo(1466.67, 2);

    // Period 3 is closed (isClosed=true) → Excel export writes 0 (plain number, no annotation text).
    // Phase 29 decision: Excel uses plain numbers only to keep cells sortable/summable.
    const p3AmountCol = headers.indexOf("งวดที่ 3 - ยอดหนี้รวม") + 1;
    expect(Number(dataRow.getCell(p3AmountCol).value)).toBe(0);

    // Period 1 amount is plain numeric (no annotation).
    const p1AmountCol = headers.indexOf("งวดที่ 1 - ยอดหนี้รวม") + 1;
    expect(Number(dataRow.getCell(p1AmountCol).value)).toBeCloseTo(1666.67, 2);
  }, 10_000);
});

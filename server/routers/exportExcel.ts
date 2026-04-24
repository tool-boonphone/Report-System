/**
 * Excel export endpoint for the "ข้อมูลสัญญา" menu.
 *
 * Streaming design: ExcelJS's streaming writer + batched DB reads keeps memory
 * flat even for 100k+ rows. Guarded by app session + "export" permission.
 */
import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import {
  APP_SESSION_COOKIE,
  CONTRACT_COLUMNS,
  type ContractColumnKey,
  SECTIONS,
  type SectionKey,
} from "../../shared/const";
import { checkPermission, getUserFromSession } from "../authDb";
import {
  iterateContracts,
  type ContractFilters,
  type ContractSort,
} from "../contractsDb";
import { listDebtTarget, listDebtCollected } from "../debtDb";
import { getBadDebtSummary } from "../badDebtDb";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") ?? "");
  }
  return out;
}

function cellValue(key: ContractColumnKey, row: any, seq: number) {
  if (key === "seq") return seq;
  const v = row[key];
  if (v === null || v === undefined) return "";
  const meta = CONTRACT_COLUMNS.find((c) => c.key === key);
  if (meta?.type === "money" || meta?.type === "number") {
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? (n as number) : "";
  }
  return String(v);
}

export async function handleContractsExport(req: Request, res: Response) {
  try {
    const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
    const appUser = sid ? await getUserFromSession(sid) : null;
    if (!appUser) {
      res.status(401).json({ message: "Please login (10001)" });
      return;
    }
    if (!checkPermission(appUser, "contract", "export")) {
      res.status(403).json({ message: "ไม่มีสิทธิ์ Export ข้อมูลสัญญา" });
      return;
    }

    const sectionRaw = String(req.query.section ?? "");
    if (!SECTIONS.includes(sectionRaw as SectionKey)) {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }
    const section = sectionRaw as SectionKey;

    const filters: ContractFilters = {
      search: req.query.search ? String(req.query.search) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      debtType: req.query.debtType ? String(req.query.debtType) : undefined,
      partnerCode: req.query.partnerCode
        ? String(req.query.partnerCode)
        : undefined,
      dateField:
        req.query.dateField === "submitDate"
          ? "submitDate"
          : req.query.dateField === "approveDate"
            ? "approveDate"
            : undefined,
      dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : undefined,
      dateTo: req.query.dateTo ? String(req.query.dateTo) : undefined,
    };
    const sort: ContractSort = {
      field: (req.query.sortField as any) ?? undefined,
      dir: (req.query.sortDir as any) ?? undefined,
    };

    const fileName = `contracts_${section}_${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`,
    );

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet("Super report");

    ws.columns = CONTRACT_COLUMNS.map((c) => ({
      header: c.label,
      key: c.key,
      width: c.width ?? 14,
    }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(1).commit();

    let seq = 0;
    for await (const batch of iterateContracts({ section, filters, sort })) {
      for (const row of batch) {
        seq += 1;
        const record: Record<string, string | number> = {};
        for (const col of CONTRACT_COLUMNS) {
          record[col.key] = cellValue(col.key, row, seq);
        }
        ws.addRow(record).commit();
      }
    }

    ws.commit();
    await wb.commit();
  } catch (err) {
    console.error("[export] contracts failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Export failed" });
    } else {
      res.end();
    }
  }
}

/* ----------------------------------------------------------------------- */
/*  Debt report export                                                      */
/* ----------------------------------------------------------------------- */

// Left-side columns shared by both variants (matches DebtReport.tsx UI).
const DEBT_LEFT_COLUMNS: Array<{ key: string; header: string; width: number }> =
  [
    { key: "seq", header: "#", width: 6 },
    { key: "approveDate", header: "วันที่อนุมัติ", width: 14 },
    { key: "contractNo", header: "เลขที่สัญญา", width: 22 },
    { key: "customerName", header: "ชื่อ-นามสกุล", width: 22 },
    { key: "phone", header: "เบอร์โทร", width: 14 },
    { key: "totalAmount", header: "ยอดผ่อนรวม", width: 16 },
    { key: "installmentCount", header: "งวดผ่อน", width: 10 },
    { key: "perInstallment", header: "ผ่อนงวดละ", width: 14 },
    { key: "debtStatus", header: "สถานะหนี้", width: 14 },
    { key: "daysOverdue", header: "เกินกำหนด (วัน)", width: 14 },
  ];

function matchesSearch(hay: string | null | undefined, needle: string) {
  if (!needle) return true;
  const h = (hay ?? "").toLowerCase();
  return h.includes(needle.toLowerCase());
}

export async function handleDebtExport(req: Request, res: Response) {
  try {
    const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
    const appUser = sid ? await getUserFromSession(sid) : null;
    if (!appUser) {
      res.status(401).json({ message: "Please login (10001)" });
      return;
    }
    if (!checkPermission(appUser, "debt_report", "export")) {
      res.status(403).json({ message: "ไม่มีสิทธิ์ Export รายงานหนี้" });
      return;
    }

    const sectionRaw = String(req.query.section ?? "");
    if (!SECTIONS.includes(sectionRaw as SectionKey)) {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }
    const section = sectionRaw as SectionKey;

    const variantRaw = String(req.query.variant ?? "target");
    if (variantRaw !== "target" && variantRaw !== "collected") {
      res.status(400).json({ message: "variant ต้องเป็น target หรือ collected" });
      return;
    }
    const variant = variantRaw as "target" | "collected";

    const search = req.query.search ? String(req.query.search).trim() : "";
    const statusFilter = req.query.status ? String(req.query.status) : "";

    // 1. Load all rows for the selected variant (DB has ~3.5k contracts — safe).
    let rows: any[];
    if (variant === "target") {
      const r = await listDebtTarget({ section });
      rows = r.rows;
    } else {
      const r = await listDebtCollected({ section });
      rows = r.rows;
    }

    // 2. Apply same filters as the UI.
    const filtered = (rows as any[]).filter((r) => {
      if (statusFilter && r.debtStatus !== statusFilter) return false;
      if (search) {
        return (
          matchesSearch(r.contractNo, search) ||
          matchesSearch(r.customerName, search) ||
          matchesSearch(r.phone, search)
        );
      }
      return true;
    });

    // 3. Build worksheet.
    const fileName = `debt_${variant}_${section}_${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`,
    );

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet(variant === "target" ? "เป้าเก็บหนี้" : "ยอดเก็บหนี้");

    // Determine how many installment groups we need (cap at 36 like UI).
    let maxPeriods = 0;
    for (const r of filtered as any[]) {
      const arr = variant === "target" ? r.installments : r.payments;
      if (Array.isArray(arr)) {
        if (variant === "target") {
          if (arr.length > maxPeriods) maxPeriods = arr.length;
        } else {
          // For collected, payments are flat; find max period
          for (const p of arr) {
            if (p.period != null && p.period > maxPeriods) maxPeriods = p.period;
          }
        }
      }
    }
    maxPeriods = Math.min(maxPeriods, 36);

    // Build column list: left fixed + per-period group.
    const perGroup =
      variant === "target"
        ? [
            { key: "period", header: "งวดที่", width: 8 },
            { key: "dueDate", header: "วันที่ต้องชำระ", width: 14 },
            { key: "principal", header: "เงินต้น", width: 12 },
            { key: "interest", header: "ดอกเบี้ย", width: 12 },
            { key: "fee", header: "ค่าดำเนินการ", width: 12 },
            { key: "penalty", header: "ค่าปรับ", width: 10 },
            { key: "unlockFee", header: "ค่าปลดล็อก", width: 12 },
            { key: "amount", header: "ยอดหนี้รวม", width: 18 },
          ]
        : [
            { key: "period", header: "งวดที่", width: 8 },
            { key: "paidAt", header: "วันที่ชำระ", width: 14 },
            { key: "principal", header: "เงินต้น", width: 12 },
            { key: "interest", header: "ดอกเบี้ย", width: 12 },
            { key: "fee", header: "ค่าดำเนินการ", width: 12 },
            { key: "penalty", header: "ค่าปรับ", width: 10 },
            { key: "unlockFee", header: "ค่าปลดล็อก", width: 10 },
            { key: "discount", header: "ส่วนลด", width: 10 },
            { key: "overpaid", header: "ชำระเกิน", width: 10 },
            { key: "badDebt", header: "หนี้เสีย", width: 10 },
            { key: "total", header: "ยอดที่ชำระรวม", width: 14 },
          ];

    const cols: Array<{ header: string; key: string; width: number }> = [
      ...DEBT_LEFT_COLUMNS,
    ];
    for (let p = 1; p <= maxPeriods; p += 1) {
      for (const g of perGroup) {
        cols.push({
          header: `งวดที่ ${p} - ${g.header}`,
          key: `p${p}_${g.key}`,
          width: g.width,
        });
      }
    }
    ws.columns = cols;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(1).commit();

    // 4. Stream rows.
    let seq = 0;
    for (const r of filtered as any[]) {
      seq += 1;
      const baseRec: Record<string, string | number> = {
        seq,
        approveDate: r.approveDate ?? "",
        contractNo: r.contractNo ?? "",
        customerName: r.customerName ?? "",
        phone: r.phone ?? "",
        totalAmount: Number(r.totalAmount ?? 0),
        installmentCount: Number(r.installmentCount ?? 0),
        perInstallment: Number(r.installmentAmount ?? 0),
        debtStatus: r.debtStatus ?? "",
        daysOverdue: Number(r.daysOverdue ?? 0),
      };

      if (variant === "target") {
        const rec = { ...baseRec };
        const arr = r.installments;
        if (Array.isArray(arr)) {
          for (let i = 0; i < Math.min(arr.length, maxPeriods); i += 1) {
            const item = arr[i];
            const p = i + 1;
            rec[`p${p}_period`] = Number(item.period ?? p);
            rec[`p${p}_dueDate`] = item.dueDate ?? "";
            rec[`p${p}_principal`] = Number(item.principal ?? 0);
            rec[`p${p}_interest`] = Number(item.interest ?? 0);
            rec[`p${p}_fee`] = Number(item.fee ?? 0);
            rec[`p${p}_penalty`] = Number(item.penalty ?? 0);
            rec[`p${p}_unlockFee`] = Number(item.unlockFee ?? 0);
            // Annotate the total column (matches UI): closed / overpaid applied.
            let amountCell: string | number = Number(item.amount ?? 0);
            if (item.isClosed) {
              amountCell = "0 (ปิดค่างวดแล้ว)";
            } else if (Number(item.overpaidApplied ?? 0) > 0.009) {
              amountCell = `${Number(item.amount ?? 0).toFixed(2)} (-หักชำระเกิน ${Number(item.overpaidApplied).toFixed(2)})`;
            }
            rec[`p${p}_amount`] = amountCell;
          }
        }
        ws.addRow(rec).commit();
      } else {
        // Collected variant: payments can be split.
        // We group payments by period, find the max split depth for this row,
        // and emit multiple Excel rows if a period has multiple payments.
        const arr = r.payments;
        const byPeriod = new Map<number, any[]>();
        if (Array.isArray(arr)) {
          for (const p of arr) {
            if (p.period == null) continue;
            if (!byPeriod.has(p.period)) byPeriod.set(p.period, []);
            byPeriod.get(p.period)!.push(p);
          }
        }
        let lines = 1;
        byPeriod.forEach((pays) => {
          if (pays.length > lines) lines = pays.length;
        });

        for (let li = 0; li < lines; li += 1) {
          const rec: Record<string, string | number> = {};
          // Only the first line gets the left-side contract info
          if (li === 0) {
            Object.assign(rec, baseRec);
          } else {
            rec.customerName = "- แบ่งชำระ -";
          }

          for (let p = 1; p <= maxPeriods; p += 1) {
            const pays = byPeriod.get(p) ?? [];
            const item = pays[li];
            if (item) {
              rec[`p${p}_period`] = li === 0 ? p : "—";
              rec[`p${p}_paidAt`] = item.paidAt ?? "";
              rec[`p${p}_principal`] = Number(item.principal ?? 0);
              rec[`p${p}_interest`] = Number(item.interest ?? 0);
              rec[`p${p}_fee`] = Number(item.fee ?? 0);
              rec[`p${p}_penalty`] = Number(item.penalty ?? 0);
              rec[`p${p}_unlockFee`] = Number(item.unlockFee ?? 0);
              rec[`p${p}_discount`] = Number(item.discount ?? 0);
              rec[`p${p}_overpaid`] = Number(item.overpaid ?? 0);
              rec[`p${p}_badDebt`] = Number(item.badDebt ?? 0);
              rec[`p${p}_total`] = Number(item.total ?? 0);
            }
          }
          ws.addRow(rec).commit();
        }
      }
    }

    ws.commit();
    await wb.commit();
  } catch (err) {
    console.error("[export] debt failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Export failed" });
    } else {
      res.end();
    }
  }
}

/* -------------------------------------------------------------------- */
/* Bad Debt Summary Export                                              */
/* -------------------------------------------------------------------- */

/**
 * GET /api/export/bad-debt?section=Fastfone365&approveMonth=2024-10&search=...
 *
 * ดาวน์โหลดตารางสรุปหนี้เสีย (กำไร/ขาดทุน) เป็น .xlsx
 * ต้องมี permission: bad_debt_summary / view
 */
export async function handleBadDebtExport(req: Request, res: Response) {
  try {
    const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
    const appUser = sid ? await getUserFromSession(sid) : null;
    if (!appUser) {
      res.status(401).json({ message: "Please login (10001)" });
      return;
    }
    if (!checkPermission(appUser, "bad_debt_summary", "view")) {
      res.status(403).json({ message: "ไม่มีสิทธิ์ Export สรุปหนี้เสีย" });
      return;
    }
    const sectionRaw = String(req.query.section ?? "");
    if (!SECTIONS.includes(sectionRaw as SectionKey)) {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }
    const section = sectionRaw as SectionKey;
    const approveMonth = req.query.approveMonth
      ? String(req.query.approveMonth)
      : undefined;
    const search = req.query.search ? String(req.query.search).trim() : "";

    // 1. Load rows
    const { rows } = await getBadDebtSummary({ section, approveMonth });

    // 2. Apply search filter (same as UI)
    const filtered = search
      ? rows.filter(
          (r) =>
            matchesSearch(r.contractNo, search) ||
            matchesSearch(r.customerName, search) ||
            matchesSearch(r.phone, search),
        )
      : rows;

    // 3. Stream Excel
    const fileName = `bad_debt_summary_${section}_${new Date()
      .toISOString()
      .slice(0, 10)}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`,
    );

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet("สรุปหนี้เสีย");

    ws.columns = [
      { header: "#", key: "seq", width: 6 },
      { header: "เลขที่สัญญา", key: "contractNo", width: 24 },
      { header: "ชื่อลูกค้า", key: "customerName", width: 24 },
      { header: "โทรศัพท์", key: "phone", width: 14 },
      { header: "วันอนุมัติ", key: "approveDate", width: 14 },
      { header: "รุ่น", key: "model", width: 20 },
      { header: "ราคาขาย", key: "salePrice", width: 14 },
      { header: "ยอดจัดไฟแนนซ์", key: "financeAmount", width: 16 },
      { header: "ยอดเก็บได้", key: "totalPaid", width: 14 },
      { header: "กำไร/ขาดทุน", key: "profitLoss", width: 14 },
      { header: "งวด/ชำระแล้ว", key: "installments", width: 14 },
      { header: "วันที่หนี้เสีย", key: "badDebtDate", width: 14 },
    ];

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9D9D9" },
    };
    ws.getRow(1).commit();

    let seq = 1;
    for (const r of filtered) {
      ws.addRow({
        seq: seq++,
        contractNo: r.contractNo ?? "",
        customerName: r.customerName ?? "",
        phone: r.phone ?? "",
        approveDate: r.approveDate ? r.approveDate.slice(0, 10) : "",
        model: r.model ?? "-",
        salePrice: r.salePrice ?? "",
        financeAmount: r.financeAmount,
        totalPaid: r.totalPaid,
        profitLoss: r.profitLoss,
        installments: `${r.paidInstallments}/${r.installmentCount ?? "-"}`,
        badDebtDate: r.badDebtDate ? r.badDebtDate.slice(0, 10) : "",
      }).commit();
    }

    ws.commit();
    await wb.commit();
  } catch (err) {
    console.error("[export] bad-debt failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Export failed" });
    } else {
      res.end();
    }
  }
}

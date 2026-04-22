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
  // Drizzle returns DECIMAL as string; convert to number so Excel can format it.
  const meta = CONTRACT_COLUMNS.find((c) => c.key === key);
  if (meta?.type === "money" || meta?.type === "number") {
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? (n as number) : "";
  }
  return String(v);
}

export async function handleContractsExport(req: Request, res: Response) {
  try {
    // 1. Auth from session cookie
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

    // 2. Inputs
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

    // 3. Stream XLSX
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

import { getDebtReport } from "../debtDb";

export async function handleDebtExport(req: Request, res: Response) {
  try {
    // 1. Auth + permission
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

    // 2. Inputs
    const sectionRaw = String(req.query.section ?? "");
    if (!SECTIONS.includes(sectionRaw as SectionKey)) {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }
    const section = sectionRaw as SectionKey;
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ message: "from/to ต้องเป็นรูปแบบ YYYY-MM-DD" });
      return;
    }

    // 3. Build workbook in memory (monthly data is small, hundreds of rows at most)
    const { summary, monthly } = await getDebtReport({ section, from, to });

    const fileName = `debt_report_${section}_${from}_to_${to}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`,
    );

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet("รายงานหนี้");

    ws.columns = [
      { header: "เดือน", key: "month", width: 12 },
      { header: "เป้าเก็บหนี้ (บาท)", key: "target", width: 18 },
      { header: "งวดครบกำหนด", key: "targetCount", width: 14 },
      { header: "ยอดเก็บหนี้ (บาท)", key: "collected", width: 18 },
      { header: "จำนวนธุรกรรม", key: "collectedCount", width: 14 },
      { header: "ส่วนต่าง (บาท)", key: "gap", width: 16 },
      { header: "อัตราจัดเก็บ (%)", key: "rate", width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(1).commit();

    for (const r of monthly) {
      ws.addRow({
        month: r.month,
        target: Number(r.target),
        targetCount: Number(r.targetCount),
        collected: Number(r.collected),
        collectedCount: Number(r.collectedCount),
        gap: Number(r.gap),
        rate: Number((r.rate * 100).toFixed(2)),
      }).commit();
    }

    // Summary footer
    ws.addRow({}).commit();
    ws.addRow({
      month: "รวมทั้งช่วง",
      target: Number(summary.target),
      targetCount: Number(summary.targetCount),
      collected: Number(summary.collected),
      collectedCount: Number(summary.collectedCount),
      gap: Number(summary.gap),
      rate: Number((summary.rate * 100).toFixed(2)),
    }).commit();

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

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
  normalizeSectionKey,
  type SectionKey,
} from "../../shared/const";
import { checkPermission, getUserFromSession } from "../authDb";
import {
  iterateContracts,
  type ContractFilters,
  type ContractSort,
} from "../contractsDb";
import { listDebtTarget, listDebtCollected } from "../debtDb";
import {
  getCachedTarget,
  getCachedCollected,
  waitForPrewarmTarget,
  waitForPrewarmCollected,
} from "../debtCache";
import { getBadDebtSummary } from "../badDebtDb";
import { getDebtExportEntry } from "../debtExportBuilder";
import { storageGetSignedUrl } from "../storage";
import {
  setMoneyCell,
  setIntCell,
  setDateCell,
  MONEY_FORMAT,
  INT_FORMAT,
} from "../excelUtils";

// ─── Contract group header definitions (mirrors Contracts.tsx UI) ─────────────
// Contracts.tsx: colSpan 6/4/15/8/7/1 → total 41 columns
const CONTRACT_GROUPS: Array<{
  label: string;
  colCount: number;
  argb: string;
  subArgb: string;
}> = [
  { label: "สินเชื่อ",    colCount: 6,  argb: "FF475569", subArgb: "FFF8FAFC" }, // slate-600 / slate-50
  { label: "พาร์ทเนอร์", colCount: 4,  argb: "FF4F46E5", subArgb: "FFEEF2FF" }, // indigo-600 / indigo-50
  { label: "ลูกค้า",     colCount: 15, argb: "FF0D9488", subArgb: "FFF0FDFA" }, // teal-600 / teal-50
  { label: "สินค้า",     colCount: 8,  argb: "FFD97706", subArgb: "FFFEFCE8" }, // amber-600 / amber-50
  { label: "ไฟแนนซ์",   colCount: 7,  argb: "FFE11D48", subArgb: "FFFFF1F2" }, // rose-600 / rose-50
  { label: "หนี้",       colCount: 1,  argb: "FF7C3AED", subArgb: "FFF5F3FF" }, // purple-600 / purple-50
];

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
    let section: SectionKey;
    try {
      section = normalizeSectionKey(sectionRaw);
    } catch {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }

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
    res.flushHeaders();

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet("Super report");

    // Set column widths (no header text here — rows 1+2 are written manually)
    ws.columns = CONTRACT_COLUMNS.map((c) => ({
      key: c.key,
      width: c.width ?? 14,
    }));

    // ── Row 1: Group header (merged cells per group) ────────────────────────
    const row1 = ws.getRow(1);
    let colOffset = 1;
    for (const grp of CONTRACT_GROUPS) {
      for (let ci = 0; ci < grp.colCount; ci++) {
        const cell = row1.getCell(colOffset + ci);
        cell.value = ci === 0 ? grp.label : null;
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: grp.argb },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      }
      // Merge cells for this group label
      if (grp.colCount > 1) {
        ws.mergeCells(1, colOffset, 1, colOffset + grp.colCount - 1);
      }
      colOffset += grp.colCount;
    }
    row1.height = 22;
    row1.commit();

    // ── Row 2: Column headers with group-tinted background ─────────────────
    const row2 = ws.getRow(2);
    let colIdx2 = 1;
    for (const grp of CONTRACT_GROUPS) {
      for (let ci = 0; ci < grp.colCount; ci++) {
        const col = CONTRACT_COLUMNS[colIdx2 - 1];
        const cell = row2.getCell(colIdx2);
        cell.value = col?.label ?? "";
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: grp.subArgb },
        };
        cell.font = { bold: true, size: 9 };
        cell.alignment = {
          vertical: "middle",
          horizontal: "center",
          wrapText: true,
        };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
        };
        colIdx2++;
      }
    }
    row2.height = 30;
    row2.commit();

    // ── Data rows ────────────────────────────────────────────────────────────
    let seq = 0;
    for await (const batch of iterateContracts({ section, filters, sort })) {
      for (const row of batch) {
        seq += 1;
        const exRow = ws.addRow({});
        let ci = 1;
        for (const col of CONTRACT_COLUMNS) {
          const cell = exRow.getCell(ci++);
          if (col.key === "seq") {
            cell.value = seq;
            cell.numFmt = INT_FORMAT;
            cell.alignment = { horizontal: "center" };
          } else if (col.type === "money") {
            setMoneyCell(cell, (row as any)[col.key]);
          } else if (col.type === "number") {
            setIntCell(cell, (row as any)[col.key]);
          } else if (col.type === "date") {
            setDateCell(cell, (row as any)[col.key]);
          } else {
            const v = (row as any)[col.key];
            cell.value = v != null ? String(v) : "";
          }
        }
        exRow.commit();
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
// target tab: no "productType" column; collected tab: has it
const DEBT_LEFT_COLUMNS_TARGET: Array<{
  key: string;
  header: string;
  width: number;
  type: "text" | "money" | "number" | "date";
}> = [
  { key: "seq",               header: "#",               width: 6,  type: "number" },
  { key: "approveDate",       header: "วันที่อนุมัติ",   width: 14, type: "date"   },
  { key: "contractNo",        header: "เลขที่สัญญา",    width: 22, type: "text"   },
  { key: "customerName",      header: "ชื่อ-นามสกุล",   width: 22, type: "text"   },
  { key: "phone",             header: "เบอร์โทร",        width: 14, type: "text"   },
  { key: "totalAmount",       header: "ยอดผ่อนรวม",     width: 16, type: "money"  },
  { key: "installmentCount",  header: "งวดผ่อน",         width: 10, type: "number" },
  { key: "perInstallment",    header: "ผ่อนงวดละ",       width: 14, type: "money"  },
  { key: "debtStatus",        header: "สถานะหนี้",       width: 14, type: "text"   },
  { key: "daysOverdue",       header: "เกินกำหนด (วัน)", width: 14, type: "number" },
];

const DEBT_LEFT_COLUMNS_COLLECTED: Array<{
  key: string;
  header: string;
  width: number;
  type: "text" | "money" | "number" | "date";
}> = [
  { key: "seq",               header: "#",               width: 6,  type: "number" },
  { key: "approveDate",       header: "วันที่อนุมัติ",   width: 14, type: "date"   },
  { key: "contractNo",        header: "เลขที่สัญญา",    width: 22, type: "text"   },
  { key: "customerName",      header: "ชื่อ-นามสกุล",   width: 22, type: "text"   },
  { key: "phone",             header: "เบอร์โทร",        width: 14, type: "text"   },
  { key: "productType",       header: "ประเภทเครื่อง",  width: 14, type: "text"   },
  { key: "totalAmount",       header: "ยอดผ่อนรวม",     width: 16, type: "money"  },
  { key: "installmentCount",  header: "งวดผ่อน",         width: 10, type: "number" },
  { key: "perInstallment",    header: "ผ่อนงวดละ",       width: 14, type: "money"  },
  { key: "debtStatus",        header: "สถานะหนี้",       width: 14, type: "text"   },
  { key: "daysOverdue",       header: "เกินกำหนด (วัน)", width: 14, type: "number" },
];

// Per-period sub-columns
const DEBT_SUB_TARGET: Array<{
  key: string;
  header: string;
  width: number;
  type: "text" | "money" | "number" | "date";
}> = [
  { key: "period",     header: "งวดที่",          width: 8,  type: "number" },
  { key: "dueDate",    header: "วันที่ต้องชำระ",  width: 14, type: "date"   },
  { key: "principal",  header: "เงินต้น",          width: 12, type: "money"  },
  { key: "interest",   header: "ดอกเบี้ย",         width: 12, type: "money"  },
  { key: "fee",        header: "ค่าดำเนินการ",     width: 12, type: "money"  },
  { key: "penalty",    header: "ค่าปรับ",           width: 10, type: "money"  },
  { key: "unlockFee",  header: "ค่าปลดล็อก",       width: 12, type: "money"  },
  { key: "amount",     header: "ยอดหนี้รวม",       width: 18, type: "money"  },
];

const DEBT_SUB_COLLECTED: Array<{
  key: string;
  header: string;
  width: number;
  type: "text" | "money" | "number" | "date";
}> = [
  { key: "period",     header: "รายการ",           width: 8,  type: "text"   },
  { key: "paidAt",     header: "วันที่ชำระ",        width: 14, type: "date"   },
  { key: "principal",  header: "เงินต้น",           width: 12, type: "money"  },
  { key: "interest",   header: "ดอกเบี้ย",          width: 12, type: "money"  },
  { key: "fee",        header: "ค่าดำเนินการ",      width: 12, type: "money"  },
  { key: "penalty",    header: "ค่าปรับ",            width: 10, type: "money"  },
  { key: "unlockFee",  header: "ค่าปลดล็อก",        width: 10, type: "money"  },
  { key: "discount",   header: "ส่วนลด",             width: 10, type: "money"  },
  { key: "overpaid",   header: "ชำระเกิน",           width: 10, type: "money"  },
  { key: "badDebt",    header: "หนี้เสีย",           width: 10, type: "money"  },
  { key: "total",      header: "ยอดที่ชำระรวม",     width: 14, type: "money"  },
  { key: "updatedBy",  header: "บันทึกโดย",          width: 14, type: "text"   },
  { key: "updatedAt",  header: "บันทึกเมื่อ",        width: 18, type: "date"   },
  { key: "remark",     header: "หมายเหตุ",           width: 22, type: "text"   },
];

// ARGB colors for debt report header rows
// target: amber-700 group header, amber-50/amber-100 sub-col alternating
// collected: emerald-700 group header, emerald-50 sub-col
const DEBT_GROUP_ARGB_TARGET   = "FFB45309"; // amber-700
const DEBT_GROUP_ARGB_COLLECTED = "FF047857"; // emerald-700
const DEBT_LEFT_ARGB           = "FF334155"; // slate-700
const DEBT_LEFT_SUB_ARGB       = "FFF8FAFC"; // slate-50

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
    let section: SectionKey;
    try {
      section = normalizeSectionKey(sectionRaw);
    } catch {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }

    const variantRaw = String(req.query.variant ?? "target");
    if (variantRaw !== "target" && variantRaw !== "collected") {
      res.status(400).json({ message: "variant ต้องเป็น target หรือ collected" });
      return;
    }
    const variant = variantRaw as "target" | "collected";

    // ── Pre-built export: redirect to S3 URL if available ──────────────────
    const prebuilt = await getDebtExportEntry(section, variant);
    if (prebuilt) {
      try {
        const signedUrl = await storageGetSignedUrl(prebuilt.storageKey);
        res.redirect(302, signedUrl);
        return;
      } catch (redirectErr: any) {
        console.warn(`[export] Pre-built redirect failed, falling back to on-the-fly:`, redirectErr?.message);
      }
    }

    const search = req.query.search ? String(req.query.search).trim() : "";
    const statusFilter = req.query.status ? String(req.query.status) : "";
    const dueDateExact = req.query.dueDateExact ? String(req.query.dueDateExact) : "";
    const dueDateFilterRaw = req.query.dueDateFilter ? String(req.query.dueDateFilter) : "";
    const dueDateMonths = dueDateFilterRaw ? new Set(dueDateFilterRaw.split(",").filter(Boolean)) : new Set<string>();
    const approveDateRaw = req.query.approveDate ? String(req.query.approveDate) : "";
    const approveDateMonths = approveDateRaw ? new Set(approveDateRaw.split(",").filter(Boolean)) : new Set<string>();
    const productTypeRaw = req.query.productType ? String(req.query.productType) : "";
    const productTypes = productTypeRaw ? new Set(productTypeRaw.split(",").filter(Boolean)) : new Set<string>();

    // 1. Load all rows — use in-memory cache (same as UI) to avoid timeout.
    let rows: any[];
    if (variant === "target") {
      await waitForPrewarmTarget(section);
      const cached = getCachedTarget(section);
      if (cached) {
        rows = cached.rows ?? cached;
      } else {
        const r = await listDebtTarget({ section });
        rows = r.rows;
      }
    } else {
      await waitForPrewarmCollected(section);
      const cached = getCachedCollected(section);
      if (cached) {
        rows = cached.rows ?? cached;
      } else {
        const r = await listDebtCollected({ section });
        rows = r.rows;
      }
    }

    // 2. Apply same filters as the UI.
    const filtered = (rows as any[]).filter((r) => {
      if (approveDateMonths.size > 0) {
        const ym = r.approveDate ? String(r.approveDate).slice(0, 7) : "";
        if (!approveDateMonths.has(ym)) return false;
      }
      if (dueDateExact) {
        const hasMatch =
          variant === "collected"
            ? (r.payments ?? []).some((p: any) => p.paidAt && String(p.paidAt).slice(0, 10) === dueDateExact)
            : (r.installments ?? []).some((inst: any) => inst.dueDate && String(inst.dueDate).slice(0, 10) === dueDateExact);
        if (!hasMatch) return false;
      }
      if (dueDateMonths.size > 0) {
        const hasMatch =
          variant === "collected"
            ? (r.payments ?? []).some((p: any) => p.paidAt && dueDateMonths.has(String(p.paidAt).slice(0, 7)))
            : (r.installments ?? []).some((inst: any) => inst.dueDate && dueDateMonths.has(String(inst.dueDate).slice(0, 7)));
        if (!hasMatch) return false;
      }
      if (statusFilter) {
        const statuses = statusFilter.split(",").filter(Boolean);
        if (statuses.length > 0 && !statuses.includes(r.debtStatus ?? "")) return false;
      }
      if (productTypes.size > 0 && !productTypes.has(r.productType ?? "")) return false;
      if (search) {
        if (
          !matchesSearch(r.contractNo, search) &&
          !matchesSearch(r.customerName, search) &&
          !matchesSearch(r.phone, search)
        ) return false;
      }
      return true;
    });

    // 3. Determine max installment periods (cap at 36).
    let maxPeriods = 0;
    for (const r of filtered) {
      const arr = variant === "target" ? r.installments : r.payments;
      if (Array.isArray(arr)) {
        if (variant === "target") {
          if (arr.length > maxPeriods) maxPeriods = arr.length;
        } else {
          for (const p of arr) {
            if (p.period != null && p.period > maxPeriods) maxPeriods = p.period;
          }
        }
      }
    }
    maxPeriods = Math.min(maxPeriods, 36);

    const leftCols = variant === "target" ? DEBT_LEFT_COLUMNS_TARGET : DEBT_LEFT_COLUMNS_COLLECTED;
    const subCols  = variant === "target" ? DEBT_SUB_TARGET : DEBT_SUB_COLLECTED;
    const groupArgb = variant === "target" ? DEBT_GROUP_ARGB_TARGET : DEBT_GROUP_ARGB_COLLECTED;
    const totalCols = leftCols.length + maxPeriods * subCols.length;

    // 4. Stream Excel
    const fileName = `${variant === "target" ? "เป้าเก็บหนี้" : "ยอดเก็บหนี้"}_${section}_${new Date()
      .toISOString()
      .slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.flushHeaders();

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet(variant === "target" ? "เป้าเก็บหนี้" : "ยอดเก็บหนี้");

    // Build column definitions (widths only)
    const colDefs: Array<{ key: string; width: number }> = [
      ...leftCols.map((c) => ({ key: c.key, width: c.width })),
    ];
    for (let p = 1; p <= maxPeriods; p++) {
      for (const sc of subCols) {
        colDefs.push({ key: `p${p}_${sc.key}`, width: sc.width });
      }
    }
    ws.columns = colDefs;

    // ── Row 1: Group header ─────────────────────────────────────────────────
    const hdr1 = ws.getRow(1);
    // Left section header (slate-700)
    for (let ci = 0; ci < leftCols.length; ci++) {
      const cell = hdr1.getCell(ci + 1);
      cell.value = ci === 0 ? "ข้อมูลสัญญา" : null;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DEBT_LEFT_ARGB } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    }
    if (leftCols.length > 1) {
      ws.mergeCells(1, 1, 1, leftCols.length);
    }
    // Period group headers
    for (let p = 1; p <= maxPeriods; p++) {
      const startCol = leftCols.length + (p - 1) * subCols.length + 1;
      const endCol   = startCol + subCols.length - 1;
      for (let ci = startCol; ci <= endCol; ci++) {
        const cell = hdr1.getCell(ci);
        cell.value = ci === startCol
          ? (variant === "target" ? `ข้อมูลชำระงวดที่ ${p}` : "รายการชำระเงิน")
          : null;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: groupArgb } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      }
      if (subCols.length > 1) {
        ws.mergeCells(1, startCol, 1, endCol);
      }
    }
    hdr1.height = 22;
    hdr1.commit();

    // ── Row 2: Column headers ───────────────────────────────────────────────
    const hdr2 = ws.getRow(2);
    // Left columns
    for (let ci = 0; ci < leftCols.length; ci++) {
      const cell = hdr2.getCell(ci + 1);
      cell.value = leftCols[ci].header;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DEBT_LEFT_SUB_ARGB } };
      cell.font = { bold: true, size: 9 };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
    }
    // Sub-column headers per period
    for (let p = 1; p <= maxPeriods; p++) {
      const startCol = leftCols.length + (p - 1) * subCols.length + 1;
      // Alternating amber-50 / amber-100 for target; emerald-50 for collected
      const subBgArgb = variant === "target"
        ? (p % 2 === 1 ? "FFFFFBEB" : "FFFEF3C7")  // amber-50 / amber-100
        : "FFECFDF5"; // emerald-50
      for (let si = 0; si < subCols.length; si++) {
        const cell = hdr2.getCell(startCol + si);
        cell.value = subCols[si].header;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: subBgArgb } };
        cell.font = { bold: true, size: 9 };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
      }
    }
    hdr2.height = 30;
    hdr2.commit();

    // ── Data rows ────────────────────────────────────────────────────────────
    let seq = 0;
    let rowCount = 0;
    for (const r of filtered as any[]) {
      seq += 1;
      rowCount += 1;
      if (rowCount % 500 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const exRow = ws.addRow({});
      let ci = 1;

      // Left columns
      for (const lc of leftCols) {
        const cell = exRow.getCell(ci++);
        if (lc.key === "seq") {
          cell.value = seq;
          cell.numFmt = INT_FORMAT;
          cell.alignment = { horizontal: "center" };
        } else if (lc.type === "money") {
          setMoneyCell(cell, r[lc.key]);
        } else if (lc.type === "number") {
          setIntCell(cell, r[lc.key]);
        } else if (lc.type === "date") {
          setDateCell(cell, r[lc.key]);
        } else {
          cell.value = r[lc.key] != null ? String(r[lc.key]) : "";
        }
      }

      // Per-period sub-columns
      if (variant === "target") {
        const installments: any[] = Array.isArray(r.installments) ? r.installments : [];
        for (let p = 1; p <= maxPeriods; p++) {
          const inst = installments.find((i: any) => i.period === p) ?? null;
          for (const sc of subCols) {
            const cell = exRow.getCell(ci++);
            if (!inst) {
              cell.value = "";
              continue;
            }
            if (sc.type === "money") {
              setMoneyCell(cell, inst[sc.key]);
            } else if (sc.type === "number") {
              setIntCell(cell, inst[sc.key]);
            } else if (sc.type === "date") {
              setDateCell(cell, inst[sc.key]);
            } else {
              cell.value = inst[sc.key] != null ? String(inst[sc.key]) : "";
            }
          }
        }
      } else {
        // collected: payments are flat; group by period
        const payments: any[] = Array.isArray(r.payments) ? r.payments : [];
        for (let p = 1; p <= maxPeriods; p++) {
          const pmts = payments.filter((pm: any) => pm.period === p);
          const pmt = pmts[0] ?? null; // take first payment for this period
          for (const sc of subCols) {
            const cell = exRow.getCell(ci++);
            if (!pmt) {
              cell.value = "";
              continue;
            }
            if (sc.type === "money") {
              setMoneyCell(cell, pmt[sc.key]);
            } else if (sc.type === "number") {
              setIntCell(cell, pmt[sc.key]);
            } else if (sc.type === "date") {
              setDateCell(cell, pmt[sc.key]);
            } else {
              cell.value = pmt[sc.key] != null ? String(pmt[sc.key]) : "";
            }
          }
        }
      }

      exRow.commit();
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

/* ----------------------------------------------------------------------- */
/*  Bad Debt Summary export                                                 */
/* ----------------------------------------------------------------------- */

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
    let section: SectionKey;
    try {
      section = normalizeSectionKey(sectionRaw);
    } catch {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }
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
    res.flushHeaders();

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const ws = wb.addWorksheet("สรุปหนี้เสีย");

    // Column definitions (width only — headers written manually in row 1)
    ws.columns = [
      { key: "seq",              width: 6  },
      { key: "approveDate",      width: 14 },
      { key: "contractNo",       width: 24 },
      { key: "customerName",     width: 24 },
      { key: "phone",            width: 14 },
      { key: "model",            width: 20 },
      { key: "salePrice",        width: 14 },
      { key: "financeAmount",    width: 16 },
      { key: "commissionNet",    width: 14 },
      { key: "cost",             width: 14 },
      { key: "installments",     width: 14 },
      { key: "installmentPaid",  width: 16 },
      { key: "deviceSaleAmount", width: 16 },
      { key: "totalRevenue",     width: 16 },
      { key: "saleDate",         width: 14 },
      { key: "profitLoss",       width: 14 },
    ];
    const BAD_DEBT_COL_COUNT = 16;

    // ── Row 1: Header (red-700 background, mirrors BadDebtSummary.tsx UI) ──
    const hdr = ws.getRow(1);
    const headers = [
      "#", "วันที่อนุมัติ", "เลขที่สัญญา", "ชื่อ-นามสกุล", "เบอร์โทร",
      "รุ่น", "ราคา", "ยอดจัดไฟแนนซ์", "ค่าคอมมิชชั่น", "ต้นทุน",
      "งวดที่ชำระ", "ยอดผ่อน", "ยอดขายเครื่อง", "รวมรายรับ", "วันที่ขาย",
      "กำไร/ขาดทุน",
    ];
    for (let ci = 0; ci < BAD_DEBT_COL_COUNT; ci++) {
      const cell = hdr.getCell(ci + 1);
      cell.value = headers[ci];
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB91C1C" } }; // red-700
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    }
    hdr.height = 28;
    hdr.commit();

    // ── Data rows ────────────────────────────────────────────────────────────
    let seq = 1;
    for (const r of filtered) {
      const exRow = ws.addRow({});
      // #
      const c1 = exRow.getCell(1);
      c1.value = seq++;
      c1.numFmt = INT_FORMAT;
      c1.alignment = { horizontal: "center" };
      // วันที่อนุมัติ
      setDateCell(exRow.getCell(2), r.approveDate);
      // เลขที่สัญญา
      exRow.getCell(3).value = r.contractNo ?? "";
      // ชื่อ-นามสกุล
      exRow.getCell(4).value = r.customerName ?? "";
      // เบอร์โทร
      exRow.getCell(5).value = r.phone ?? "";
      // รุ่น
      exRow.getCell(6).value = r.model ?? "-";
      // ราคา
      setMoneyCell(exRow.getCell(7), r.salePrice);
      // ยอดจัดไฟแนนซ์
      setMoneyCell(exRow.getCell(8), r.financeAmount);
      // ค่าคอมมิชชั่น
      setMoneyCell(exRow.getCell(9), r.commissionNet);
      // ต้นทุน
      setMoneyCell(exRow.getCell(10), r.cost);
      // งวดที่ชำระ (text: "paid/total")
      exRow.getCell(11).value = r.installmentCount != null
        ? `${r.paidInstallments}/${r.installmentCount}`
        : `${r.paidInstallments}`;
      exRow.getCell(11).alignment = { horizontal: "center" };
      // ยอดผ่อน
      setMoneyCell(exRow.getCell(12), r.installmentPaid);
      // ยอดขายเครื่อง
      setMoneyCell(exRow.getCell(13), r.deviceSaleAmount);
      // รวมรายรับ
      setMoneyCell(exRow.getCell(14), r.totalRevenue);
      // วันที่ขาย
      setDateCell(exRow.getCell(15), r.saleDate);
      // กำไร/ขาดทุน
      setMoneyCell(exRow.getCell(16), r.profitLoss);

      exRow.commit();
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

/* ----------------------------------------------------------------------- */
/*  Income (รายรับ) export — no row limit                                  */
/* ----------------------------------------------------------------------- */

/**
 * GET /api/export/income?section=...&dateFrom=...&dateTo=...&dateField=...&incomeTypes=...&updatedBy=...&listMode=detail|slip
 */
export async function handleIncomeExport(req: Request, res: Response) {
  try {
    const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
    const appUser = sid ? await getUserFromSession(sid) : null;
    if (!appUser) { res.status(401).json({ message: "Please login (10001)" }); return; }

    const sectionRaw = String(req.query.section ?? "");
    let section: SectionKey;
    try { section = normalizeSectionKey(sectionRaw); } catch {
      res.status(400).json({ message: "ต้องระบุ section" }); return;
    }

    const { listIncome } = await import("../accountingDb");
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const dateField = req.query.dateField === "updatedAt" ? "updatedAt" : "paidAt";
    const updatedBy = req.query.updatedBy ? String(req.query.updatedBy) : undefined;
    const listMode = req.query.listMode === "slip" ? "slip" : "detail";
    const incomeTypesRaw = req.query.incomeTypes ? String(req.query.incomeTypes) : "";
    const incomeTypes = incomeTypesRaw ? incomeTypesRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

    // Fetch all rows without limit (pageSize = 500000)
    const { rows: allRows } = await listIncome({
      section, dateFrom, dateTo, dateField,
      incomeTypes: incomeTypes as any,
      updatedBy,
      page: 1,
      pageSize: 500000,
    });

    // Group by slip if needed
    let exportRows = allRows;
    if (listMode === "slip") {
      const slipMap = new Map<string, typeof allRows[0]>();
      for (const r of allRows) {
        const key = r.receiptNo ?? `__no_slip_${r.id}`;
        if (!slipMap.has(key)) slipMap.set(key, r);
        else {
          const existing = slipMap.get(key)!;
          slipMap.set(key, { ...existing, amount: (existing.amount ?? 0) + (r.amount ?? 0) });
        }
      }
      exportRows = Array.from(slipMap.values());
    }

    const fileName = `รายรับ_${section}_${listMode === "slip" ? "ตามสลิป" : "ตามการบันทึก"}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const ws = wb.addWorksheet("รายรับ");
    ws.columns = [
      { header: "No.", width: 6 },
      { header: "วันที่ชำระ", width: 14 },
      { header: "เวลาชำระ", width: 12 },
      { header: "ประเภท", width: 14 },
      { header: "รหัสรายการ", width: 20 },
      { header: "เลขที่สัญญา", width: 22 },
      { header: "ชื่อลูกค้า", width: 22 },
      { header: "ยอดเงิน", width: 16 },
      { header: "ทำรายการโดย", width: 18 },
      { header: "วันที่ทำรายการ", width: 14 },
      { header: "เวลาทำรายการ", width: 14 },
    ];
    // Style header row
    ws.getRow(1).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
    ws.getRow(1).commit();

    for (let i = 0; i < exportRows.length; i++) {
      const r = exportRows[i];
      const displayType = listMode === "detail"
        ? (r.originalIncomeType === "ปิดยอด" ? "ปิดยอด" : "ค่างวด")
        : r.incomeType;
      const paidDate = r.paidAt ? String(r.paidAt).slice(0, 10) : "";
      const paidTime = r.paidAt ? String(r.paidAt).slice(11, 19) : "";
      const updatedDate = r.updatedAt ? String(r.updatedAt).slice(0, 10) : "";
      const updatedTime = r.updatedAt ? String(r.updatedAt).slice(11, 19) : "";
      const row = ws.addRow([i + 1, paidDate, paidTime, displayType, r.receiptNo ?? "", r.contractNo, r.customerName ?? "", r.amount ?? 0, r.updatedBy ?? "", updatedDate, updatedTime]);
      setMoneyCell(row.getCell(8), r.amount ?? 0);
      row.commit();
    }
    ws.commit();
    await wb.commit();
  } catch (err) {
    console.error("[export] income failed:", err);
    if (!res.headersSent) res.status(500).json({ message: "Export failed" });
    else res.end();
  }
}

/* ----------------------------------------------------------------------- */
/*  Expense (รายจ่าย) export — no row limit                                */
/* ----------------------------------------------------------------------- */

/**
 * GET /api/export/expense?section=...&dateFrom=...&dateTo=...&dateField=...&search=...
 */
export async function handleExpenseExport(req: Request, res: Response) {
  try {
    const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
    const appUser = sid ? await getUserFromSession(sid) : null;
    if (!appUser) { res.status(401).json({ message: "Please login (10001)" }); return; }

    const sectionRaw = String(req.query.section ?? "");
    let section: SectionKey;
    try { section = normalizeSectionKey(sectionRaw); } catch {
      res.status(400).json({ message: "ต้องระบุ section" }); return;
    }

    const { listCommissions } = await import("../accountingDb");
    const search = req.query.search ? String(req.query.search).trim() : undefined;
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const dateField = req.query.dateField === "approvedAt" ? "approvedAt" : "paymentAt";

    const { rows } = await listCommissions({
      section, search, dateFrom, dateTo, dateField,
      page: 1,
      pageSize: 500000,
    });

    const fileName = `รายจ่าย_รายการทั้งหมด_${section}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const ws = wb.addWorksheet("รายการทั้งหมด");
    ws.columns = [
      { header: "No.", width: 6 },
      { header: "วันที่โอนเงิน", width: 14 },
      { header: "เลขที่สัญญา", width: 22 },
      { header: "วันที่อนุมัติ", width: 14 },
      { header: "ยอดจัดไฟแนนซ์", width: 18 },
      { header: "ค่าคอมมิชชั่น", width: 18 },
      { header: "Incentive", width: 14 },
      { header: "รวมยอดโอน", width: 16 },
      { header: "ผู้จ่าย", width: 16 },
    ];
    ws.getRow(1).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC2626" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
    ws.getRow(1).commit();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const row = ws.addRow([
        i + 1,
        r.paymentAt ? String(r.paymentAt).slice(0, 10) : "",
        r.contractNo,
        r.approvedAt ? String(r.approvedAt).slice(0, 10) : "",
        r.financeAmount ?? 0,
        r.commAmount ?? 0,
        r.incentive ?? 0,
        r.totalTransfer ?? 0,
        r.paymentBy ?? "",
      ]);
      setMoneyCell(row.getCell(5), r.financeAmount ?? 0);
      setMoneyCell(row.getCell(6), r.commAmount ?? 0);
      setMoneyCell(row.getCell(7), r.incentive ?? 0);
      setMoneyCell(row.getCell(8), r.totalTransfer ?? 0);
      row.commit();
    }
    ws.commit();
    await wb.commit();
  } catch (err) {
    console.error("[export] expense failed:", err);
    if (!res.headersSent) res.status(500).json({ message: "Export failed" });
    else res.end();
  }
}

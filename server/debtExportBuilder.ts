/**
 * debtExportBuilder.ts
 *
 * Pre-builds Excel files for DebtReport (target + collected) after each sync
 * and uploads them to S3. When users click Export, the server redirects them
 * to the pre-built S3 URL instead of generating on-the-fly (which times out
 * for large datasets like Fastfone365 with 17k+ rows).
 *
 * Called from: server/sync/runner.ts after populateDebtCache completes.
 */

import ExcelJS from "exceljs";
import { getDb } from "./db";
import { debtExportCache } from "../drizzle/schema";
import { storagePut } from "./storage";
import { listDebtTarget, listDebtCollected } from "./debtDb";
import {
  getCachedTarget,
  getCachedCollected,
} from "./debtCache";
import type { SectionKey } from "../shared/const";

// ─── Column definitions (mirrors exportExcel.ts) ────────────────────────────

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

const TARGET_PER_GROUP = [
  { key: "period", header: "งวดที่", width: 8 },
  { key: "dueDate", header: "วันที่ต้องชำระ", width: 14 },
  { key: "principal", header: "เงินต้น", width: 12 },
  { key: "interest", header: "ดอกเบี้ย", width: 12 },
  { key: "fee", header: "ค่าดำเนินการ", width: 12 },
  { key: "penalty", header: "ค่าปรับ", width: 10 },
  { key: "unlockFee", header: "ค่าปลดล็อก", width: 12 },
  { key: "amount", header: "ยอดหนี้รวม", width: 18 },
];

const COLLECTED_PER_GROUP = [
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

// ─── Core builder ────────────────────────────────────────────────────────────

async function buildExcelBuffer(
  rows: any[],
  variant: "target" | "collected",
): Promise<Buffer> {
  let maxPeriods = 0;
  for (const r of rows) {
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
  const perGroup = variant === "target" ? TARGET_PER_GROUP : COLLECTED_PER_GROUP;
  const cols: Array<{ header: string; key: string; width: number }> = [...DEBT_LEFT_COLUMNS];
  for (let p = 1; p <= maxPeriods; p += 1) {
    for (const g of perGroup) {
      cols.push({ header: `งวดที่ ${p} - ${g.header}`, key: `p${p}_${g.key}`, width: g.width });
    }
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(variant === "target" ? "เป้าเก็บหนี้" : "ยอดเก็บหนี้");
  ws.columns = cols;
  // Style header row (red-700 for target, green-700 for collected)
  const hdrRow = ws.getRow(1);
  hdrRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hdrRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: variant === "target" ? "FFDC2626" : "FF15803D" } };
  hdrRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  hdrRow.border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
  let seq = 0;
  let rowCount = 0;
  for (const r of rows) {
    seq += 1;
    rowCount += 1;
    if (rowCount % 1000 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const approveDate = r.approveDate ? r.approveDate.slice(0, 10) : "";
    const baseRec: Record<string, string | number> = {
      seq,
      approveDate,
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
          rec[`p${p}_dueDate`] = item.dueDate ? item.dueDate.slice(0, 10) : "";
          rec[`p${p}_principal`] = Number(item.principal ?? 0);
          rec[`p${p}_interest`] = Number(item.interest ?? 0);
          rec[`p${p}_fee`] = Number(item.fee ?? 0);
          rec[`p${p}_penalty`] = Number(item.penalty ?? 0);
          rec[`p${p}_unlockFee`] = Number(item.unlockFee ?? 0);
          let amountCell = 0;
          if (!item.isClosed && !item.isSuspended) {
            amountCell = Number(item.overpaidApplied ?? 0) > 0.009 ? Number(item.netAmount ?? item.amount ?? 0) : Number(item.amount ?? 0);
          }
          rec[`p${p}_amount`] = amountCell;
        }
      }
      ws.addRow(rec);
    } else {
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
            const paidDate = item.paidAt ? item.paidAt.slice(0, 10) : "";
            const paidTime = item.paidAt ? item.paidAt.slice(11, 19) : "";
            rec[`p${p}_paidAt`] = paidDate + (paidTime ? ` ${paidTime}` : "");
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
        // Style sub-rows (italic) for split payments
        const newRow = ws.addRow(rec);
        if (li > 0) {
          newRow.font = { italic: true };
        }
      }
    }
  }
  // Apply cell types: number for money columns
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header
    for (let colIdx = 1; colIdx <= cols.length; colIdx++) {
      const col = cols[colIdx - 1];
      const cell = row.getCell(colIdx);
      // Money columns: principal, interest, fee, penalty, unlockFee, discount, overpaid, badDebt, total, totalAmount, perInstallment
      if (col.key.includes("_principal") || col.key.includes("_interest") || col.key.includes("_fee") || 
          col.key.includes("_penalty") || col.key.includes("_unlockFee") || col.key.includes("_discount") ||
          col.key.includes("_overpaid") || col.key.includes("_badDebt") || col.key.includes("_total") ||
          col.key === "totalAmount" || col.key === "perInstallment") {
        cell.numFmt = "#,##0.00";
      } else if (col.key === "seq" || col.key === "installmentCount" || col.key.includes("_period")) {
        cell.numFmt = "#,##0";
      }
    }
  });
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build Excel for one section+variant and upload to S3.
 * Saves the resulting URL to debt_export_cache table.
 */
export async function buildAndUploadDebtExcel(
  section: SectionKey,
  variant: "target" | "collected",
): Promise<void> {
  console.log(`[debtExportBuilder] Building ${variant} for ${section}...`);
  const startMs = Date.now();

  // Load rows from in-memory cache (populated by populateDebtCache just before)
  let rows: any[];
  if (variant === "target") {
    const cached = getCachedTarget(section);
    if (cached) {
      rows = cached.rows ?? cached;
    } else {
      const r = await listDebtTarget({ section });
      rows = r.rows;
    }
  } else {
    const cached = getCachedCollected(section);
    if (cached) {
      rows = cached.rows ?? cached;
    } else {
      const r = await listDebtCollected({ section });
      rows = r.rows;
    }
  }

  const buffer = await buildExcelBuffer(rows, variant);

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const storageKey = `debt-export/${section}_${variant}_${ts}.xlsx`;

  const { key, url } = await storagePut(
    storageKey,
    buffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );

  // Upsert into DB
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .insert(debtExportCache)
    .values({
      section,
      variant,
      storageKey: key,
      storageUrl: url,
      rowCount: rows.length,
    })
    .onDuplicateKeyUpdate({
      set: {
        storageKey: key,
        storageUrl: url,
        rowCount: rows.length,
        builtAt: new Date(),
      },
    });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `[debtExportBuilder] ✓ ${section} ${variant}: ${rows.length} rows → S3 in ${elapsed}s`,
  );
}

/**
 * Build all 4 combinations (2 sections × 2 variants) after a full sync cycle.
 * Non-fatal: errors are logged but don't throw.
 */
export async function buildAllDebtExports(section: SectionKey): Promise<void> {
  for (const variant of ["target", "collected"] as const) {
    try {
      await buildAndUploadDebtExcel(section, variant);
    } catch (err: any) {
      console.error(
        `[debtExportBuilder] Failed to build ${section} ${variant}:`,
        err?.message ?? err,
      );
    }
  }
}

/**
 * Get the pre-built export URL for a section+variant.
 * Returns null if not yet built.
 */
export async function getDebtExportEntry(
  section: string,
  variant: "target" | "collected",
): Promise<{ storageKey: string; storageUrl: string; builtAt: Date; rowCount: number } | null> {
  const { eq, and } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(debtExportCache)
    .where(
      and(
        eq(debtExportCache.section, section),
        eq(debtExportCache.variant, variant),
      ),
    )
    .limit(1);
  if (!rows.length) return null;
  return {
    storageKey: rows[0].storageKey,
    storageUrl: rows[0].storageUrl,
    builtAt: rows[0].builtAt,
    rowCount: rows[0].rowCount,
  };
}

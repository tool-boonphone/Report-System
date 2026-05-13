/**
 * excelUtils.ts
 *
 * Shared utilities for Excel export across all pages.
 * Provides:
 *  - Header row styling (bold, gray background)
 *  - Status badge colors (debt status, contract status)
 *  - Number format helpers
 *  - Date/time split helpers
 *  - Cell type assignment helpers
 */
import type ExcelJS from "exceljs";

// ─── Color constants ─────────────────────────────────────────────────────────

/** Header row background (light gray) */
export const HEADER_BG = "FFD9D9D9";

/** Debt status badge colors (ARGB) */
export const DEBT_STATUS_COLORS: Record<string, { bg: string; font: string }> = {
  "ปกติ":         { bg: "FFFFFFFF", font: "FF000000" },
  "เกิน 1-30":    { bg: "FFFEF9C3", font: "FF854D0E" }, // yellow-100 / yellow-800
  "เกิน 31-60":   { bg: "FFFED7AA", font: "FF9A3412" }, // orange-200 / orange-800
  "เกิน 61-90":   { bg: "FFFECACA", font: "FF991B1B" }, // red-200 / red-800
  "เกิน >90":     { bg: "FFFCA5A5", font: "FF7F1D1D" }, // red-300 / red-900
  "ระงับสัญญา":   { bg: "FFE5E7EB", font: "FF6B7280" }, // gray-200 / gray-500
  "หนี้เสีย":     { bg: "FFE5E7EB", font: "FF6B7280" }, // gray-200 / gray-500
  "สิ้นสุดสัญญา": { bg: "FFD1FAE5", font: "FF065F46" }, // emerald-100 / emerald-800
};

/** Contract status badge colors */
export const CONTRACT_STATUS_COLORS: Record<string, { bg: string; font: string }> = {
  "ปกติ":         { bg: "FFD1FAE5", font: "FF065F46" }, // emerald
  "ระงับสัญญา":   { bg: "FFFEF3C7", font: "FF92400E" }, // amber
  "หนี้เสีย":     { bg: "FFFEE2E2", font: "FF991B1B" }, // red
  "สิ้นสุดสัญญา": { bg: "FFE0E7FF", font: "FF3730A3" }, // indigo
};

// ─── Header styling ──────────────────────────────────────────────────────────

/**
 * Apply standard header styling to row 1 of a worksheet.
 * Call after setting ws.columns.
 */
export function styleHeaderRow(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { bold: true, size: 10 };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: HEADER_BG },
  };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.height = 28;
  row.commit();
}

/**
 * Apply standard header styling to a streaming worksheet row.
 * For streaming workbooks, we must commit the row after styling.
 */
export function styleStreamHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, size: 10 };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: HEADER_BG },
  };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.height = 28;
}

// ─── Cell styling helpers ────────────────────────────────────────────────────

/**
 * Apply debt status color to a cell.
 */
export function styleDebtStatusCell(cell: ExcelJS.Cell, status: string): void {
  const colors = DEBT_STATUS_COLORS[status];
  if (!colors) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.bg } };
  cell.font = { color: { argb: colors.font }, size: 10 };
}

/**
 * Apply contract status color to a cell.
 */
export function styleContractStatusCell(cell: ExcelJS.Cell, status: string): void {
  const colors = CONTRACT_STATUS_COLORS[status];
  if (!colors) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.bg } };
  cell.font = { color: { argb: colors.font }, size: 10 };
}

// ─── Number format helpers ───────────────────────────────────────────────────

/** Thai money format: 1,234,567.89 */
export const MONEY_FORMAT = "#,##0.00";

/** Integer format: 1,234 */
export const INT_FORMAT = "#,##0";

/**
 * Set a cell's value as a number with money format.
 */
export function setMoneyCell(cell: ExcelJS.Cell, value: number | null | undefined): void {
  const n = Number(value ?? 0);
  cell.value = Number.isFinite(n) ? n : 0;
  cell.numFmt = MONEY_FORMAT;
  cell.alignment = { horizontal: "right" };
}

/**
 * Set a cell's value as an integer.
 */
export function setIntCell(cell: ExcelJS.Cell, value: number | null | undefined): void {
  const n = Number(value ?? 0);
  cell.value = Number.isFinite(n) ? Math.round(n) : 0;
  cell.numFmt = INT_FORMAT;
  cell.alignment = { horizontal: "right" };
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * Parse a date string (ISO or YYYY-MM-DD) to a JS Date, or null if invalid.
 */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date as YYYY-MM-DD string (for date-only columns).
 */
export function fmtDateOnly(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).slice(0, 10);
}

/**
 * Format a datetime string as date part only (YYYY-MM-DD).
 */
export function fmtDatePart(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).slice(0, 10);
}

/**
 * Format a datetime string as time part only (HH:MM:SS).
 */
export function fmtTimePart(s: string | null | undefined): string {
  if (!s) return "";
  const str = String(s);
  // ISO format: 2024-01-15T10:30:00.000Z or 2024-01-15 10:30:00
  const tIdx = str.indexOf("T");
  if (tIdx >= 0) {
    return str.slice(tIdx + 1, tIdx + 9); // HH:MM:SS
  }
  const spIdx = str.indexOf(" ");
  if (spIdx >= 0) {
    return str.slice(spIdx + 1, spIdx + 9); // HH:MM:SS
  }
  return "";
}

/**
 * Set a cell as a date value (Excel native date).
 */
export function setDateCell(cell: ExcelJS.Cell, s: string | null | undefined): void {
  const d = parseDate(s);
  if (d) {
    cell.value = d;
    cell.numFmt = "YYYY-MM-DD";
    cell.alignment = { horizontal: "center" };
  } else {
    cell.value = "";
  }
}

// ─── Row background helpers ───────────────────────────────────────────────────

/**
 * Apply a solid background fill to all cells in a row.
 */
export function fillRow(row: ExcelJS.Row, argb: string, colCount: number): void {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  }
}

/**
 * Apply italic style to all cells in a row (for sub-rows).
 */
export function italicRow(row: ExcelJS.Row, colCount: number): void {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = { ...cell.font, italic: true, color: { argb: "FF6B7280" } };
  }
}

// ─── Special value helpers ───────────────────────────────────────────────────

/**
 * Remove "(-หักชำระเกิน: X.XX)" annotation from a string.
 * Returns the cleaned string.
 */
export function removeOverpaidAnnotation(s: string): string {
  return s.replace(/\s*\(-หักชำระเกิน:[^)]*\)/g, "").trim();
}

/**
 * Convert a "special status" text to 0 for numeric cells.
 * "ระงับสัญญา", "ปิดค่างวดแล้ว", "หนี้เสีย" → 0
 */
export function specialStatusToZero(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  if (v === "ระงับสัญญา" || v === "ปิดค่างวดแล้ว" || v === "หนี้เสีย") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── Column width auto-fit helper ────────────────────────────────────────────

/**
 * Set minimum column widths for a worksheet.
 * Useful after setting ws.columns to ensure readability.
 */
export function setMinColumnWidths(ws: ExcelJS.Worksheet, minWidth = 8): void {
  ws.columns.forEach((col) => {
    if (col.width !== undefined && col.width < minWidth) {
      col.width = minWidth;
    }
  });
}

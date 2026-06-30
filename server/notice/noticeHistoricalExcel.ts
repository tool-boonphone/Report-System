/**
 * noticeHistoricalExcel.ts — อ่าน/สร้าง Excel ประวัติการส่ง Notice
 * รูปแบบอิง docs/import-sample.png (คอลัมน์ 1–11 สำหรับ import)
 */
import ExcelJS from "exceljs";
import type { NoticeRow } from "../noticeDb";

export type NoticeImportRow = {
  contractNo: string;
  documentNo: string;
  round: number;
  printedAt: string;
  printedBy: string;
};

const HEADER_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE2EFDA" } };
const THIN_BORDER = {
  top: { style: "thin" as const },
  bottom: { style: "thin" as const },
  left: { style: "thin" as const },
  right: { style: "thin" as const },
};

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "text" in v) return String((v as { text: string }).text).trim();
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function parseDateTime(dateVal: unknown, timeVal: unknown): string | null {
  const d = cellStr(dateVal);
  const t = cellStr(timeVal);
  if (!d) return null;
  const combined = t ? `${d} ${t}` : d;
  const parsed = new Date(combined);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function formatDocumentNo(n: number): string {
  if (n <= 9999) return String(n).padStart(4, "0");
  return String(n).padStart(5, "0");
}

function parseDocNo(raw: unknown): string | null {
  const s = cellStr(raw);
  if (!s) return null;
  const n = parseInt(s.replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? formatDocumentNo(n) : s;
}

function isHeaderContractNo(contractNo: string): boolean {
  return /เลขที่|สัญญา|contract/i.test(contractNo);
}

/** อ่านแถว import จาก worksheet (คอลัมน์ 1–11) */
export function parseNoticeImportWorksheet(ws: ExcelJS.Worksheet): NoticeImportRow[] {
  const rows: NoticeImportRow[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const contractNo = cellStr(row.getCell(2).value);
    if (!contractNo || isHeaderContractNo(contractNo)) return;

    const documentNo = parseDocNo(row.getCell(1).value) ?? "";
    const rounds = [
      { round: 1, date: row.getCell(3).value, time: row.getCell(4).value, by: row.getCell(5).value },
      { round: 2, date: row.getCell(6).value, time: row.getCell(7).value, by: row.getCell(8).value },
      { round: 3, date: row.getCell(9).value, time: row.getCell(10).value, by: row.getCell(11).value },
    ];

    for (const r of rounds) {
      const printedAt = parseDateTime(r.date, r.time);
      if (!printedAt) continue;
      rows.push({
        contractNo,
        documentNo,
        round: r.round,
        printedAt,
        printedBy: cellStr(r.by) || "import",
      });
    }
  });
  return rows;
}

export async function parseNoticeImportBuffer(buf: Buffer): Promise<NoticeImportRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("ไม่พบ worksheet ในไฟล์ Excel");
  return parseNoticeImportWorksheet(ws);
}

function splitPrintedAt(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "", time: "" };
  return {
    date: d.toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" }),
    time: d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

function logByRound(logs: NoticeRow["printLogs"], round: number) {
  return logs.find((l) => l.round === round);
}

function restoreSummary(logs: NoticeRow["restoreLogs"]): string {
  if (logs.length === 0) return "";
  return logs
    .map((l) => `Restore รอบ ${l.round}: ${splitPrintedAt(l.restoredAt).date} ${splitPrintedAt(l.restoredAt).time} โดย ${l.restoredBy}`)
    .join(" | ");
}

/** สร้าง Excel export — เฉพาะรายการที่มีประวัติส่ง (sentCount > 0) */
export async function buildNoticeHistoryExport(rows: NoticeRow[], section: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Notice_${section}`);

  ws.columns = [
    { width: 12 }, { width: 22 }, { width: 12 }, { width: 22 }, { width: 12 },
    { width: 10 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 14 },
    { width: 12 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 10 },
    { width: 14 }, { width: 40 },
  ];

  ws.mergeCells("H1:J1");
  ws.getCell("H1").value = "ส่งครั้งที่ 1";
  ws.mergeCells("K1:M1");
  ws.getCell("K1").value = "ส่งครั้งที่ 2";
  ws.mergeCells("N1:P1");
  ws.getCell("N1").value = "ส่งครั้งที่ 3";

  const headers = [
    "เลขที่เอกสาร", "เลขที่สัญญา", "วันที่อนุมัติ", "ชื่อ-นามสกุล", "ค้างชำระ(วัน)",
    "ส่งแล้ว", "ได้เครื่องคืน",
    "วันที่", "เวลา", "โดย",
    "วันที่", "เวลา", "โดย",
    "วันที่", "เวลา", "โดย",
    "Log การแก้ไข",
  ];
  const headerRow = ws.getRow(2);
  headers.forEach((h, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = THIN_BORDER;
  });
  ["H1", "K1", "N1"].forEach((addr) => {
    const c = ws.getCell(addr);
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = THIN_BORDER;
  });

  rows.forEach((r, idx) => {
    const rowNo = 3 + idx;
    const row = ws.getRow(rowNo);
    const fmtApprove = r.approveDate
      ? new Date(r.approveDate).toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" })
      : "";

    row.getCell(1).value = r.documentNo ?? "";
    row.getCell(2).value = r.contractNo;
    row.getCell(3).value = fmtApprove;
    row.getCell(4).value = r.customerName ?? "";
    row.getCell(5).value = r.overdueDays != null ? r.overdueDays : "";
    row.getCell(6).value = `${r.sentCount}/3`;
    row.getCell(7).value = r.isReturned ? "ใช่" : "ไม่";

    for (let round = 1; round <= 3; round++) {
      const lg = logByRound(r.printLogs, round);
      const base = 7 + (round - 1) * 3;
      if (lg) {
        const { date, time } = splitPrintedAt(lg.printedAt);
        row.getCell(base + 1).value = date;
        row.getCell(base + 2).value = time;
        row.getCell(base + 3).value = lg.printedBy;
      }
    }

    row.getCell(17).value = restoreSummary(r.restoreLogs);

    for (let col = 1; col <= 17; col++) {
      row.getCell(col).border = THIN_BORDER;
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** สร้างไฟล์ template สำหรับ import ประวัติ (คอลัมน์ 1–11 ตาม docs/import-sample.png) */
export async function buildNoticeImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("นำเข้าประวัติ Notice");

  ws.columns = [
    { width: 14 }, { width: 22 }, { width: 12 }, { width: 10 }, { width: 16 },
    { width: 12 }, { width: 10 }, { width: 16 },
    { width: 12 }, { width: 10 }, { width: 16 },
  ];

  ws.mergeCells("A1:A2");
  ws.getCell("A1").value = "เลขที่เอกสาร";
  ws.mergeCells("B1:B2");
  ws.getCell("B1").value = "เลขที่สัญญา";
  ws.mergeCells("C1:E1");
  ws.getCell("C1").value = "ส่งครั้งที่ 1";
  ws.mergeCells("F1:H1");
  ws.getCell("F1").value = "ส่งครั้งที่ 2";
  ws.mergeCells("I1:K1");
  ws.getCell("I1").value = "ส่งครั้งที่ 3";

  const subHeaders = ["วันที่", "เวลา", "โดย"];
  [3, 6, 9].forEach((startCol) => {
    subHeaders.forEach((label, i) => {
      const c = ws.getRow(2).getCell(startCol + i);
      c.value = label;
    });
  });

  for (const addr of ["A1", "B1", "C1", "F1", "I1"]) {
    const c = ws.getCell(addr);
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = THIN_BORDER;
  }
  for (let col = 3; col <= 11; col++) {
    const c = ws.getRow(2).getCell(col);
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = THIN_BORDER;
  }

  // แถวตัวอย่าง (ลบหรือแก้ก่อนนำเข้าจริง)
  const example = ws.getRow(3);
  example.getCell(1).value = "0001";
  example.getCell(2).value = "BPN-2024-00001";
  example.getCell(3).value = "15/01/2568";
  example.getCell(4).value = "09:30";
  example.getCell(5).value = "Sadmin";
  for (let col = 1; col <= 11; col++) {
    example.getCell(col).border = THIN_BORDER;
  }

  ws.getRow(4).getCell(1).value =
    "หมายเหตุ: 1 แถวต่อ 1 สัญญา — กรอกเฉพาะรอบที่ส่งแล้ว (วันที่+เวลา) คอลัมน์ A–K เท่านั้น";
  ws.mergeCells("A4:K4");
  ws.getRow(4).getCell(1).font = { italic: true, color: { argb: "FF666666" }, size: 10 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

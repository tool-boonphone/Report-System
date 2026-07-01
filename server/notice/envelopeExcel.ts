/**
 * envelopeExcel.ts — สร้างไฟล์ Excel จ่าหน้าซองตามรูปแบบ Thailand Post
 *
 *   A บริการ = "R"
 *   B Barcode, C COD Account, D COD = ว่าง
 *   E รายการสินค้า/หมายเหตุ = เลขที่เอกสาร
 *   F ชื่อ-สกุล, G เบอร์โทร, H ที่อยู่, I รหัสไปรษณีย์
 */
import ExcelJS from "exceljs";
import type { NoticePrintData } from "../noticeDb";
import { formatNoticeMailingAddress } from "./addressFormat";

const HEADER_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE2EFDA" } };
const THIN_BORDER = {
  top: { style: "thin" as const },
  bottom: { style: "thin" as const },
  left: { style: "thin" as const },
  right: { style: "thin" as const },
};

export async function buildEnvelopeExcel(records: NoticePrintData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("จ่าหน้าซอง");

  ws.columns = [
    { width: 10 }, { width: 12 }, { width: 14 }, { width: 10 },
    { width: 16 }, { width: 22 }, { width: 14 }, { width: 44 }, { width: 12 },
  ];

  ws.mergeCells("A1:E1");
  ws.getCell("A1").value = "รายละเอียดการจัดส่ง";
  ws.mergeCells("F1:I1");
  ws.getCell("F1").value = "รายละเอียดผู้รับปลายทาง";
  ["A1", "F1"].forEach((addr) => {
    const c = ws.getCell(addr);
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = THIN_BORDER;
  });

  const subHeaders = [
    { col: 1, label: "บริการ" },
    { col: 2, label: "Barcode" },
    { col: 3, label: "COD Account" },
    { col: 4, label: "COD" },
    { col: 5, label: "รายการสินค้า/หมายเหตุ" },
    { col: 6, label: "ชื่อ-สกุล" },
    { col: 7, label: "เบอร์โทร" },
    { col: 8, label: "ที่อยู่" },
    { col: 9, label: "รหัสไปรษณีย์" },
  ];
  const headerRow = ws.getRow(2);
  headerRow.height = 22;
  for (const h of subHeaders) {
    const c = headerRow.getCell(h.col);
    c.value = h.label;
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = THIN_BORDER;
  }

  records.forEach((r, idx) => {
    const rowNo = 3 + idx;
    const row = ws.getRow(rowNo);
    row.getCell(1).value = "R";
    row.getCell(2).value = "";
    row.getCell(3).value = "";
    row.getCell(4).value = "";
    row.getCell(5).value = r.documentNo || "";
    row.getCell(6).value = r.customerName ?? "";
    const phoneCell = row.getCell(7);
    phoneCell.value = r.phone ?? "";
    phoneCell.numFmt = "@";
    row.getCell(8).value = formatNoticeMailingAddress(r);
    const zipCell = row.getCell(9);
    zipCell.value = r.addrPostalCode ?? "";
    zipCell.numFmt = "@";

    for (let col = 1; col <= 9; col++) {
      const c = row.getCell(col);
      c.border = THIN_BORDER;
      c.alignment = { vertical: "middle", wrapText: col === 8 };
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

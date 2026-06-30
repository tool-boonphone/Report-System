/**
 * envelopeExcel.ts — สร้างไฟล์ Excel จ่าหน้าซองตามรูปแบบ Thailand Post (คอลัมน์ E–M)
 *
 * อิงจาก docs/excel-template.jpg:
 *   E บริการ = "R"
 *   F Barcode, G COD Account, H COD = ว่าง
 *   I รายการสินค้า/หมายเหตุ = เลขที่เอกสาร
 *   J ชื่อ-สกุล, K เบอร์โทร, L ที่อยู่, M รหัสไปรษณีย์
 */
import ExcelJS from "exceljs";
import type { NoticePrintData } from "../noticeDb";

const HEADER_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE2EFDA" } };
const THIN_BORDER = {
  top: { style: "thin" as const },
  bottom: { style: "thin" as const },
  left: { style: "thin" as const },
  right: { style: "thin" as const },
};

function buildAddress(r: NoticePrintData): string {
  const parts = [r.addrDistrict, r.addrProvince].filter(Boolean);
  return parts.join(" ");
}

export async function buildEnvelopeExcel(records: NoticePrintData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("จ่าหน้าซอง");

  ws.columns = [
    { width: 4 }, { width: 4 }, { width: 4 }, { width: 4 },
    { width: 10 }, { width: 12 }, { width: 14 }, { width: 10 },
    { width: 16 }, { width: 22 }, { width: 14 }, { width: 40 }, { width: 12 },
  ];

  // แถว 1: กลุ่มหัวข้อ
  ws.mergeCells("E1:I1");
  ws.getCell("E1").value = "รายละเอียดการจัดส่ง";
  ws.mergeCells("J1:M1");
  ws.getCell("J1").value = "รายละเอียดผู้รับปลายทาง";
  ["E1", "J1"].forEach((addr) => {
    const c = ws.getCell(addr);
    c.font = { bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = THIN_BORDER;
  });

  // แถว 2: หัวคอลัมน์
  const subHeaders = [
    { col: 5, label: "บริการ" },
    { col: 6, label: "Barcode" },
    { col: 7, label: "COD Account" },
    { col: 8, label: "COD" },
    { col: 9, label: "รายการสินค้า/หมายเหตุ" },
    { col: 10, label: "ชื่อ-สกุล" },
    { col: 11, label: "เบอร์โทร" },
    { col: 12, label: "ที่อยู่" },
    { col: 13, label: "รหัสไปรษณีย์" },
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

  // แถว 3+: ข้อมูล
  records.forEach((r, idx) => {
    const rowNo = 3 + idx;
    const row = ws.getRow(rowNo);
    row.getCell(5).value = "R";
    row.getCell(6).value = "";
    row.getCell(7).value = "";
    row.getCell(8).value = "";
    row.getCell(9).value = r.documentNo || "";
    row.getCell(10).value = r.customerName ?? "";
    const phoneCell = row.getCell(11);
    phoneCell.value = r.phone ?? "";
    phoneCell.numFmt = "@";
    row.getCell(12).value = buildAddress(r);
    const zipCell = row.getCell(13);
    zipCell.value = "";
    zipCell.numFmt = "@";

    for (let col = 5; col <= 13; col++) {
      const c = row.getCell(col);
      c.border = THIN_BORDER;
      c.alignment = { vertical: "middle", wrapText: col === 12 };
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

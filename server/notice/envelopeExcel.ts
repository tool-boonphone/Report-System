/**
 * envelopeExcel.ts — สร้างไฟล์ Excel จ่าหน้าซองตามรูปแบบ Thailand Post PromptPost
 *
 * โครงสร้างตาม template ทางการ:
 *   แถว 1: ชื่อฟอร์ม
 *   แถว 2: หมายเหตุ (ห้ามแก้หัวคอลัมน์แถว 4, ตั้งเบอร์/รหัสไปรษณีย์เป็น Text)
 *   แถว 3: ว่าง
 *   แถว 4: หัวคอลัมน์ (ห้ามแก้)
 *   แถว 5+: ข้อมูลผู้รับ
 *
 * หมายเหตุข้อมูล: ระบบ sync เก็บที่อยู่เพียง อำเภอ/เขต + จังหวัด + เบอร์โทร
 * คอลัมน์ ที่อยู่(เลขที่/หมู่/ซอย/ถนน), ตำบล/แขวง และ รหัสไปรษณีย์ จึงเว้นว่างให้กรอกเพิ่ม
 */
import ExcelJS from "exceljs";
import type { NoticePrintData } from "../noticeDb";

const HEADERS = [
  "ลำดับ",
  "ชื่อ-นามสกุลผู้รับ",
  "เบอร์โทรศัพท์ผู้รับ",
  "ที่อยู่ (เลขที่/หมู่/ซอย/ถนน)",
  "ตำบล/แขวง",
  "อำเภอ/เขต",
  "จังหวัด",
  "รหัสไปรษณีย์",
  "น้ำหนัก (กรัม)",
  "ยอดเงิน COD (บาท)",
  "หมายเหตุ/เลขอ้างอิง",
];

const DEFAULT_WEIGHT_GRAMS = 500;

export async function buildEnvelopeExcel(records: NoticePrintData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Template_แบบฟอร์มฝากส่ง");

  ws.columns = [
    { width: 8 }, { width: 26 }, { width: 18 }, { width: 32 }, { width: 16 },
    { width: 16 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 24 },
  ];

  // แถว 1: ชื่อฟอร์ม
  ws.mergeCells("A1:K1");
  const title = ws.getCell("A1");
  title.value = "แบบฟอร์มสำหรับนำเข้าข้อมูลผู้รับพัสดุ (Thailand Post Prompt Post Excel Import Template)";
  title.font = { bold: true, size: 14 };

  // แถว 2: หมายเหตุ
  ws.mergeCells("A2:K2");
  ws.getCell("A2").value =
    "* หมายเหตุ: ห้ามลบหรือแก้ไขชื่อหัวข้อในแถวที่ 4 โดยเด็ดขาด และกรุณาตั้งฟอร์แมตช่องเบอร์โทรศัพท์และรหัสไปรษณีย์เป็นข้อความ (Text)";
  ws.getCell("A2").font = { color: { argb: "FFC00000" } };

  // แถว 4: หัวคอลัมน์
  const headerRow = ws.getRow(4);
  HEADERS.forEach((h, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    c.border = {
      top: { style: "thin" }, bottom: { style: "thin" },
      left: { style: "thin" }, right: { style: "thin" },
    };
  });
  headerRow.height = 32;

  // แถว 5+: ข้อมูล
  records.forEach((r, idx) => {
    const round = r.sentCount + 1;
    const rowNo = 5 + idx;
    const row = ws.getRow(rowNo);
    row.getCell(1).value = idx + 1;
    row.getCell(2).value = r.customerName ?? "";
    // เบอร์โทร + รหัสไปรษณีย์ ต้องเป็น Text (กันเลข 0 หาย)
    const phoneCell = row.getCell(3);
    phoneCell.value = r.phone ?? "";
    phoneCell.numFmt = "@";
    row.getCell(4).value = ""; // ที่อยู่ (เลขที่/หมู่/ซอย/ถนน) — ไม่มีในข้อมูล sync
    row.getCell(5).value = ""; // ตำบล/แขวง — ไม่มีในข้อมูล sync
    row.getCell(6).value = r.addrDistrict ?? ""; // อำเภอ/เขต
    row.getCell(7).value = r.addrProvince ?? ""; // จังหวัด
    const zipCell = row.getCell(8);
    zipCell.value = ""; // รหัสไปรษณีย์ — ไม่มีในข้อมูล sync
    zipCell.numFmt = "@";
    row.getCell(9).value = DEFAULT_WEIGHT_GRAMS;
    row.getCell(10).value = 0; // COD = 0 สำหรับหนังสือ Notice
    row.getCell(11).value = `${r.contractNo}-N${round}`;
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * noticeDocx.ts — สร้างเอกสารหนังสือแจ้งเตือน (Notice) เป็นไฟล์ DOCX
 *
 * สร้างด้วย library `docx` (pure-Node, render ภาษาไทยถูกต้องเมื่อเปิดด้วย Word/LibreOffice)
 * 1 สัญญา = 1 หน้า (ขึ้นหน้าใหม่ด้วย pageBreakBefore), A4 แนวตั้ง, ฟอนต์ TH Sarabun New
 *
 * ยอดเงินอิงตามที่ผู้ใช้ระบุ:
 *   ราคาเช่าซื้อทั้งสิ้น = จำนวนงวด × ค่างวด
 *   ยอดชำระแล้ว        = งวดที่ชำระแล้ว × ค่างวด
 *   ยอดค้างชำระ        = ราคาเช่าซื้อทั้งสิ้น − ยอดชำระแล้ว
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { bahtText } from "./bahtText";
import type { NoticePrintData } from "../noticeDb";

const FONT = "TH Sarabun New";
const COMPANY_NAME = "บริษัท ฟาสต์โฟน365 จำกัด";
const COMPANY_PHONE = "02-028-7777";

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

function fmtMoney(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtThaiDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function composeAddress(r: NoticePrintData): string {
  const parts: string[] = [];
  if (r.addrDistrict) parts.push(`อำเภอ/เขต ${r.addrDistrict}`);
  if (r.addrProvince) parts.push(`จังหวัด ${r.addrProvince}`);
  return parts.length ? parts.join(" ") : "-";
}

function run(text: string, opts: { bold?: boolean; size?: number } = {}): TextRun {
  return new TextRun({ text, font: FONT, bold: opts.bold, size: opts.size ?? 30 });
}

function para(children: TextRun[], opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType]; spacingAfter?: number; pageBreakBefore?: boolean } = {}): Paragraph {
  return new Paragraph({
    children,
    alignment: opts.align,
    pageBreakBefore: opts.pageBreakBefore,
    spacing: { after: opts.spacingAfter ?? 120, line: 320 },
  });
}

function cell(text: string, opts: { bold?: boolean; header?: boolean } = {}): TableCell {
  return new TableCell({
    width: { size: 33.33, type: WidthType.PERCENTAGE },
    shading: opts.header ? { fill: "F3F4F6" } : undefined,
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 40, after: 40 },
        children: [run(text, { bold: opts.bold || opts.header })],
      }),
    ],
  });
}

function buildContractParagraphs(r: NoticePrintData, index: number): (Paragraph | Table)[] {
  const round = r.sentCount + 1;
  const docNo = `${r.contractNo}-N${round}`;
  const inst = r.installmentAmount ?? 0;
  const hpTotal = (r.installmentCount ?? 0) * inst;
  const paid = (r.paidInstallments ?? 0) * inst;
  const due = Math.max(0, hpTotal - paid);
  const today = new Date();
  const todayStr = `${today.getDate()} ${THAI_MONTHS[today.getMonth()]} ${today.getFullYear() + 543}`;

  const border = { style: BorderStyle.SINGLE, size: 6, color: "111111" };
  const tableBorders = {
    top: border, bottom: border, left: border, right: border,
    insideHorizontal: border, insideVertical: border,
  };

  const out: (Paragraph | Table)[] = [];

  // หัวเรื่อง
  out.push(para([run("FASTFONE 365", { bold: true, size: 32 })], { align: AlignmentType.LEFT, spacingAfter: 60, pageBreakBefore: index > 0 }));
  out.push(para([run("หนังสือติดตามค่าเช่าซื้อ", { bold: true, size: 34 })], { align: AlignmentType.CENTER, spacingAfter: 40 }));
  out.push(para([run("บอกเลิกสัญญาและขอให้คืนทรัพย์สินที่เช่าซื้อ", { bold: true, size: 34 })], { align: AlignmentType.CENTER, spacingAfter: 180 }));

  // meta
  out.push(para([run("หนังสือเลขที่ ", { bold: true }), run(docNo)]));
  out.push(para([run("วันที่ ", { bold: true }), run(todayStr)]));
  out.push(para([run("สัญญาเช่าซื้อเลขที่ ", { bold: true }), run(r.contractNo)], { spacingAfter: 160 }));

  // เรื่อง / เรียน / ที่อยู่
  out.push(para([run("เรื่อง ", { bold: true }), run("ขอให้ชำระหนี้ค่าเช่าซื้อค้างชำระ บอกเลิกสัญญาและขอให้คืนทรัพย์สินที่เช่าซื้อ")]));
  out.push(para([run("เรียน ", { bold: true }), run(r.customerName ?? "-")]));
  out.push(para([run("ที่อยู่ ", { bold: true }), run(composeAddress(r))], { spacingAfter: 160 }));

  out.push(para([run("ตามที่ท่านได้ทำสัญญาเช่าซื้อกับบริษัทฯ โดยมีรายละเอียดทรัพย์สินที่เช่าซื้อตามตารางด้านล่างนี้")], { spacingAfter: 100 }));

  // ตารางทรัพย์สิน + ยอด
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableBorders,
      rows: [
        new TableRow({ children: [cell("โทรศัพท์มือถือ / รุ่น", { header: true }), cell("หมายเลข IMEI", { header: true }), cell("หมายเลข Serial", { header: true })] }),
        new TableRow({ children: [cell(r.model ?? "-"), cell(r.imei ?? "-"), cell(r.serialNo ?? "-")] }),
        new TableRow({ children: [cell("วันที่อนุมัติสัญญา", { header: true }), cell("ค่างวดต่อเดือน", { header: true }), cell("ยอดค้างชำระ", { header: true })] }),
        new TableRow({ children: [cell(fmtThaiDate(r.approveDate)), cell(`${fmtMoney(inst)} บาท`), cell(`${fmtMoney(due)} บาท`)] }),
      ],
    }),
  );
  out.push(para([run("")], { spacingAfter: 60 }));

  // เนื้อหา
  out.push(
    para([
      run("ปัจจุบันท่านผิดนัดชำระค่าเช่าซื้อเป็นเวลา "),
      run(`${(r.overdueDays ?? 0).toLocaleString()}`, { bold: true }),
      run(" วัน คงเหลือยอดค้างชำระจำนวน "),
      run(`${fmtMoney(due)} บาท`, { bold: true }),
      run(` (${bahtText(due)}) `),
      run("บริษัทฯ จึงขอให้ท่านชำระหนี้ค่าเช่าซื้อที่ค้างชำระทั้งหมด หรือส่งมอบทรัพย์สินที่เช่าซื้อคืนแก่บริษัทฯ ภายในระยะเวลาที่บริษัทฯ กำหนด"),
    ]),
  );
  out.push(
    para([
      run("หากพ้นกำหนดระยะเวลาดังกล่าวแล้ว ท่านยังมิได้ชำระหนี้หรือส่งคืนทรัพย์สิน บริษัทฯ ขอสงวนสิทธิ์ในการดำเนินการตามสัญญาและตามกฎหมายทั้งทางแพ่งและทางอาญาต่อไป"),
    ], { spacingAfter: 200 }),
  );

  // ลงชื่อ
  out.push(para([run("ขอแสดงความนับถือ")], { align: AlignmentType.CENTER, spacingAfter: 40 }));
  out.push(para([run(COMPANY_NAME, { bold: true })], { align: AlignmentType.CENTER, spacingAfter: 200 }));

  // footer
  out.push(para([run("ติดต่อชำระเงิน / สอบถามเพิ่มเติม โทร. ", { bold: true }), run(COMPANY_PHONE), run(`  •  เลขที่สัญญา ${r.contractNo}  •  รอบส่ง Notice ครั้งที่ ${round}`)], { spacingAfter: 0 }));

  return out;
}

/** สร้าง DOCX (ทุกสัญญารวมเป็นไฟล์เดียว) คืนเป็น Buffer */
export async function buildNoticeDocx(records: NoticePrintData[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  records.forEach((r, i) => {
    children.push(...buildContractParagraphs(r, i));
  });

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 30 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4 portrait (twips)
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 }, // ~2cm
          },
        },
        children,
      },
    ],
  });

  return (await Packer.toBuffer(doc)) as Buffer;
}

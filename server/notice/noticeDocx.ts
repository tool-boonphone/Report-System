/**
 * noticeDocx.ts — สร้างหนังสือแจ้งเตือน (Notice) เป็น DOCX ให้ "หน้าตาเหมือนเอกสารตัวอย่าง"
 *
 * เลย์เอาต์อิงจากเอกสารต้นฉบับของบริษัท (หัวจดหมาย + โลโก้ตาม section, ตารางทรัพย์สิน/ยอด,
 * เนื้อความบอกเลิกสัญญา, ช่องทางชำระเงิน, ข้อมูลติดต่อ, footer อัตโนมัติ)
 * 1 สัญญา = 1 หน้า A4 แนวตั้ง, ฟอนต์ TH Sarabun New
 *
 * ยอดเงิน (ตามที่ผู้ใช้กำหนด):
 *   ราคาเช่าซื้อทั้งสิ้น = จำนวนงวด × ค่างวด
 *   ยอดชำระแล้ว        = งวดที่ชำระแล้ว × ค่างวด
 *   ยอดค้างชำระ        = ราคาเช่าซื้อทั้งสิ้น − ยอดชำระแล้ว
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import QRCode from "qrcode";
import { bahtText } from "./bahtText";
import type { NoticePrintData } from "../noticeDb";
import type { SectionKey } from "../../shared/const";

// ฟอนต์ Sarabun (OFL) — bundle ใน assets/fonts และติดตั้งใน Docker image
// หน้าตาเหมือน TH Sarabun New แต่เป็นฟอนต์เสรีที่ติดตั้งบน server ได้แน่นอน
const FONT = "Sarabun";

type CompanyConfig = {
  companyName: string;
  regNo: string;
  logoFile: string; // ไฟล์ใน client/public
  bankName: string;
  bankAccount: string;
  accountName: string;
  phone: string;
  address: string;
  lineId: string;
};

/** ข้อมูลบริษัทแยกตาม section */
const COMPANY: Record<SectionKey, CompanyConfig> = {
  Fastfone365: {
    companyName: "บริษัท ฟาสต์โฟน365 จำกัด",
    regNo: "0125567022106",
    logoFile: "logo-fastfone365.png",
    bankName: "ธนาคารกสิกรไทย",
    bankAccount: "187-8-36503-4",
    accountName: "บจก.ฟาสต์โฟน365",
    phone: "02-028-7777",
    address: "29/89 หมู่ที่ 2 ตำบลลำโพ อำเภอบางบัวทอง จังหวัดนนทบุรี 11110",
    lineId: "@fastfone365",
  },
  Boonphone: {
    companyName: "บริษัท บุญโฟน จำกัด",
    regNo: "0135568033136",
    logoFile: "logo-boonphone.png",
    bankName: "ธนาคารกสิกรไทย",
    bankAccount: "221-1-46917-2",
    accountName: "บจก.บุญโฟน",
    phone: "02 460 9999",
    address: "459 ถนนบอนด์สตรีท ตำบลบางพูด อำเภอปากเกร็ด จังหวัดนนทบุรี 11120",
    lineId: "@boonphone",
  },
};

/** LINE add-friend URL จาก LINE ID (เช่น @boonphone) */
function lineAddUrl(lineId: string): string {
  const id = lineId.startsWith("@") ? lineId.slice(1) : lineId;
  return `https://line.me/R/ti/p/@${id}`;
}

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
function todayThai(): string {
  const d = new Date();
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

/** โหลดโลโก้ section + อ่านขนาดจาก PNG header (IHDR) */
function loadLogo(section: SectionKey): { data: Buffer; width: number; height: number } | null {
  const cfg = COMPANY[section];
  const candidates = [
    join(process.cwd(), "client", "public", cfg.logoFile),
    join(process.cwd(), "public", cfg.logoFile),
    join(process.cwd(), "dist", "public", cfg.logoFile),
  ];
  for (const p of candidates) {
    try {
      const data = readFileSync(p);
      // PNG: width = bytes 16..19, height = bytes 20..23 (big-endian)
      const width = data.readUInt32BE(16);
      const height = data.readUInt32BE(20);
      if (width > 0 && height > 0) return { data, width, height };
    } catch {
      /* try next */
    }
  }
  return null;
}

function run(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({ text, font: FONT, bold: opts.bold, italics: opts.italics, size: opts.size ?? 26, color: opts.color });
}
function para(children: TextRun[], opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType]; spacingAfter?: number; pageBreakBefore?: boolean; spacingBefore?: number } = {}): Paragraph {
  return new Paragraph({
    children,
    alignment: opts.align,
    pageBreakBefore: opts.pageBreakBefore,
    spacing: { after: opts.spacingAfter ?? 80, before: opts.spacingBefore ?? 0, line: 312 },
  });
}

/** ช่องว่างแนวตั้งเล็ก ๆ (สูงเท่ากับ after ที่กำหนด ไม่กินพื้นที่หนึ่งบรรทัดเต็ม) */
function spacer(after: number): Paragraph {
  return new Paragraph({ spacing: { after, before: 0, line: 1 }, children: [] });
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER };
const LINE = { style: BorderStyle.SINGLE, size: 6, color: "111111" } as const;
const BOX_BORDERS = { top: LINE, bottom: LINE, left: LINE, right: LINE, insideHorizontal: LINE, insideVertical: LINE };

/** เซลล์ในตารางข้อมูล (มีกรอบ) */
function dcell(text: string, widthPct: number, opts: { header?: boolean; bold?: boolean } = {}): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: opts.header ? { fill: "EFEFEF" } : undefined,
    margins: { top: 24, bottom: 24, left: 60, right: 60 },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0, line: 264 }, children: [run(text, { bold: opts.header || opts.bold, size: 24 })] })],
  });
}
/** เซลล์ label/value แบบไม่มีกรอบ (กำหนดความกว้างเป็น twips/DXA เพื่อให้ค่าชิดป้ายกำกับ) */
function lvCell(children: TextRun[], widthDxa: number, align?: (typeof AlignmentType)[keyof typeof AlignmentType]): TableCell {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    borders: NO_BORDERS,
    margins: { top: 16, bottom: 16, left: 0, right: 80 },
    children: [new Paragraph({ alignment: align, spacing: { after: 0, line: 312 }, children })],
  });
}

function buildContract(r: NoticePrintData, cfg: CompanyConfig, logo: ReturnType<typeof loadLogo>, qr: Buffer | null): (Paragraph | Table)[] {
  const round = r.sentCount + 1;
  const docNo = `${r.contractNo}-N${round}`;
  const inst = r.installmentAmount ?? 0;
  const hpTotal = (r.installmentCount ?? 0) * inst;
  const paid = (r.paidInstallments ?? 0) * inst;
  const due = Math.max(0, hpTotal - paid);

  const out: (Paragraph | Table)[] = [];

  // ── หัวจดหมาย: โลโก้ (ซ้าย) + ชื่อเอกสาร (ขวา) ──
  const logoChildren = logo
    ? [new Paragraph({ children: [new ImageRun({ type: "png", data: logo.data, transformation: { width: 150, height: Math.round((150 * logo.height) / logo.width) } })] })]
    : [new Paragraph({ children: [run(cfg.companyName, { bold: true, size: 32 })] })];

  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [3750, 6114],
      borders: NO_BORDERS,
      rows: [
        new TableRow({
          children: [
            new TableCell({ width: { size: 3750, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.CENTER, children: logoChildren }),
            new TableCell({
              width: { size: 6114, type: WidthType.DXA },
              borders: NO_BORDERS,
              verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 288 }, children: [run("หนังสือติดตามค่าเช่าซื้อ -", { bold: true, size: 28 })] }),
                new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 288 }, children: [run("บอกเลิกสัญญาและขอให้คืนทรัพย์สินที่เช่าซื้อ", { bold: true, size: 28 })] }),
              ],
            }),
          ],
        }),
      ],
    }),
  );
  out.push(spacer(80));

  // ── meta ──
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [2300, 7564],
      borders: NO_BORDERS,
      rows: [
        new TableRow({ children: [lvCell([run("หนังสือเลขที่", { bold: true })], 2300), lvCell([run(docNo)], 7564)] }),
        new TableRow({ children: [lvCell([run("วันที่", { bold: true })], 2300), lvCell([run(todayThai())], 7564)] }),
        new TableRow({ children: [lvCell([run("สัญญาเช่าซื้อเลขที่", { bold: true })], 2300), lvCell([run(r.contractNo)], 7564)] }),
      ],
    }),
  );
  out.push(spacer(50));

  // ── เรื่อง / เรียน / อ้างถึง ──
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [1500, 8364],
      borders: NO_BORDERS,
      rows: [
        new TableRow({ children: [lvCell([run("เรื่อง", { bold: true })], 1500), lvCell([run("ขอให้ชำระหนี้ค่าเช่าซื้อค้างชำระ - บอกเลิกสัญญาและขอให้คืนทรัพย์สินที่เช่าซื้อ")], 8364)] }),
        new TableRow({ children: [lvCell([run("เรียน", { bold: true })], 1500), lvCell([run(r.customerName ?? "-", { bold: true })], 8364)] }),
        new TableRow({ children: [lvCell([run("อ้างถึง", { bold: true })], 1500), lvCell([run("ยอดค่าเช่าซื้อค้างชำระของ  "), run(r.customerName ?? "-", { bold: true })], 8364)] }),
      ],
    }),
  );
  out.push(spacer(30));

  out.push(para([run(`ตามที่ท่านได้เข้าทำสัญญาเช่าซื้อ กับทางบริษัท ${cfg.companyName} ดังมีรายละเอียดดังนี้`)], { spacingAfter: 80 }));

  // ── ตาราง A: อุปกรณ์ ──
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: BOX_BORDERS,
      rows: [
        new TableRow({ children: [dcell("โทรศัพท์มือถือ รุ่น - หน่วยความจำ", 40, { header: true }), dcell("หมายเลข IMEI", 32, { header: true }), dcell("หมายเลข Serial", 28, { header: true })] }),
        new TableRow({ children: [dcell(r.model ?? "-", 40), dcell(r.imei ?? "-", 32), dcell(r.serialNo ?? "-", 28)] }),
      ],
    }),
  );
  // ── ตาราง B: ยอด ──
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: BOX_BORDERS,
      rows: [
        new TableRow({ children: [dcell("วันที่ทำสัญญา", 24, { header: true }), dcell("ราคาเช่าซื้อ(บาท)", 20, { header: true }), dcell("ผ่อนชำระเดือนละ", 20, { header: true }), dcell("จ.งวด", 12, { header: true }), dcell("ยอดที่ได้ชำระแล้ว", 24, { header: true })] }),
        new TableRow({ children: [dcell(fmtThaiDate(r.approveDate), 24), dcell(fmtMoney(hpTotal), 20), dcell(fmtMoney(inst), 20), dcell(String(r.installmentCount ?? "-"), 12), dcell(fmtMoney(paid), 24)] }),
      ],
    }),
  );
  out.push(spacer(70));

  // ── เนื้อหา ──
  out.push(
    para([
      run("บริษัทฯ ขอเรียนให้ท่านทราบว่า ปัจจุบันท่านได้ผิดนัดและค้างชำระค่าเช่าซื้อเป็นเวลา "),
      run(`${(r.overdueDays ?? 0).toLocaleString()}`, { bold: true }),
      run(" วัน อันเป็นการผิดสัญญา บริษัทฯ จึงมีความจำเป็นต้องบอกเลิกสัญญากับท่าน และขอให้ท่านชำระค่าเช่าซื้อที่ค้างชำระทั้งหมดจำนวน "),
      run(`${fmtMoney(due)}`, { bold: true }),
      run(" บาท "),
      run(`(${bahtText(due)})`, { bold: true }),
      run(" หรือขอให้ท่านส่งมอบทรัพย์สินที่เช่าซื้อคืนให้แก่บริษัทฯ ทันที"),
    ]),
  );
  out.push(
    para([
      run("จึงเรียนมายังท่านเพื่อโปรดชำระเงินจำนวนดังกล่าว หรือขอให้ท่านส่งมอบทรัพย์สินที่เช่าซื้อคืนแก่บริษัทฯ ภายใน 15 วัน นับแต่วันที่ลงในหนังสือฉบับนี้ เพื่อหลีกเลี่ยงการดำเนินคดีทั้งในทางแพ่งและทางอาญา หากพ้นกำหนดเวลาดังกล่าว บริษัทฯ ขอสงวนสิทธิ์ในการดำเนินคดีตามกฎหมายจนถึงที่สุด โดยท่านจะต้องรับผิดในค่าเสียหาย ค่าธรรมเนียมศาล และค่าทนายความเพิ่มเติม"),
    ]),
  );
  out.push(
    para([
      run("อนึ่ง การที่ท่านได้รับทรัพย์สินไปโดยไม่ชำระเงิน และไม่คืนทรัพย์สิน อาจเข้าข่ายความผิดทางอาญาฐานฉ้อโกงและยักยอกทรัพย์ ซึ่งมีโทษตามกฎหมาย"),
    ], { spacingAfter: 160 }),
  );

  // ── ลงชื่อ ──
  out.push(para([run("ขอแสดงความนับถือ")], { align: AlignmentType.CENTER, spacingAfter: 20 }));
  out.push(para([run(cfg.companyName, { bold: true })], { align: AlignmentType.CENTER, spacingAfter: 140 }));

  // ── ช่องทางการชำระเงิน ──
  if (cfg.bankAccount) {
    out.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: [2900, 6964],
        borders: NO_BORDERS,
        rows: [
          new TableRow({ children: [lvCell([run("ช่องทางการชำระเงิน", { bold: true })], 2900), lvCell([run(cfg.bankName)], 6964)] }),
          new TableRow({ children: [lvCell([run("")], 2900), lvCell([run(`เลขที่ ${cfg.bankAccount}  ชื่อบัญชี ${cfg.accountName}`, { bold: true })], 6964)] }),
        ],
      }),
    );
  }

  // ── ติดต่อ (ซ้าย) + QR LINE (ขวา) ──
  const contactCellChildren: Paragraph[] = [
    new Paragraph({ spacing: { after: 0, line: 312 }, children: [run("โปรดติดต่อ", { bold: true })] }),
    new Paragraph({ spacing: { after: 0, line: 312 }, children: [run(`${cfg.companyName}${cfg.phone ? `  โทร. ${cfg.phone}` : ""}`, { bold: true })] }),
  ];
  if (cfg.address) contactCellChildren.push(new Paragraph({ spacing: { after: 0, line: 312 }, children: [run(`ที่อยู่ ${cfg.address}`)] }));
  contactCellChildren.push(new Paragraph({ spacing: { after: 0, line: 312 }, children: [run(`เลขทะเบียนนิติบุคคล ${cfg.regNo}`, { size: 24, color: "555555" })] }));

  const qrCellChildren: Paragraph[] = qr
    ? [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0, line: 240 }, children: [run("ไลน์ติดต่อแอด / แนบสลิปโอนเงิน", { size: 24 })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [new ImageRun({ type: "png", data: qr, transformation: { width: 96, height: 96 } })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0, line: 240 }, children: [run(`LINE: ${cfg.lineId}`, { size: 24, bold: true })] }),
      ]
    : [new Paragraph({ children: [] })];

  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [7000, 2864],
      borders: NO_BORDERS,
      rows: [
        new TableRow({
          children: [
            new TableCell({ width: { size: 7000, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.BOTTOM, margins: { top: 60, bottom: 0, left: 0, right: 0 }, children: contactCellChildren }),
            new TableCell({ width: { size: 2864, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.BOTTOM, children: qrCellChildren }),
          ],
        }),
      ],
    }),
  );

  // ── footer อัตโนมัติ ──
  out.push(para([run(`หนังสือฉบับนี้เป็นจดหมายอัตโนมัติ จากทางบริษัท ${cfg.companyName}`, { italics: true, size: 24, color: "555555" })], { spacingAfter: 0, spacingBefore: 140 }));
  out.push(para([run("ทางบริษัทขออภัยหากท่านได้ชำระมาก่อนหน้านี้", { italics: true, size: 24, color: "555555" })], { spacingAfter: 0 }));

  return out;
}

/** สร้าง DOCX (ทุกสัญญารวมเป็นไฟล์เดียว, 1 หน้า/สัญญา) คืนเป็น Buffer */
export async function buildNoticeDocx(records: NoticePrintData[], section: SectionKey): Promise<Buffer> {
  const cfg = COMPANY[section] ?? COMPANY.Fastfone365;
  const logo = loadLogo(section);

  // สร้าง QR LINE add-friend (ครั้งเดียวต่อเอกสาร) — คมชัด สแกนได้
  let qr: Buffer | null = null;
  try {
    qr = await QRCode.toBuffer(lineAddUrl(cfg.lineId), { type: "png", margin: 1, width: 240, errorCorrectionLevel: "M" });
  } catch {
    qr = null;
  }

  const children: (Paragraph | Table)[] = [];
  records.forEach((r, i) => {
    if (i > 0) {
      // ขึ้นหน้าใหม่ก่อนเริ่มสัญญาถัดไป
      children.push(new Paragraph({ pageBreakBefore: true, spacing: { after: 0 }, children: [] }));
    }
    children.push(...buildContract(r, cfg, logo, qr));
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 30 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4 portrait (twips)
            margin: { top: 1021, right: 1021, bottom: 1021, left: 1021 }, // ~1.8cm
          },
        },
        children,
      },
    ],
  });

  return (await Packer.toBuffer(doc)) as Buffer;
}

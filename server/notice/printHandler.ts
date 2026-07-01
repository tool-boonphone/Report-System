/**
 * printHandler.ts — Express endpoint: POST /api/notice/print
 *
 * สร้างเอกสาร Notice (PDF ถ้ามี LibreOffice ไม่งั้น DOCX) + Excel จ่าหน้าซอง
 * ของรายการที่เลือก แล้ว bundle เป็นไฟล์ ZIP ส่งกลับ
 *
 * นับรอบส่ง Notice (recordNoticePrint) เมื่อสร้างไฟล์ทั้งคู่สำเร็จเท่านั้น
 * (ตามสเปค: ถ้า PDF หรือ Excel อย่างใดอย่างหนึ่งไม่สำเร็จ ต้องไม่เพิ่มจำนวนครั้ง)
 */
import type { Request, Response } from "express";
import JSZip from "jszip";
import { APP_SESSION_COOKIE, normalizeSectionKey, type SectionKey } from "../../shared/const";
import { checkPermission, getUserFromSession } from "../authDb";
import { getNoticePrintData, recordNoticePrint, allocateDocumentNumbers, attachDocumentNumbers, MAX_NOTICE_ROUNDS } from "../noticeDb";
import { enrichContactAddressesForPrint } from "./enrichContactAddress";
import { buildNoticeDocx } from "./noticeDocx";
import { buildEnvelopeExcel } from "./envelopeExcel";
import { convertDocxToPdf } from "./docxToPdf";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") ?? "");
  }
  return out;
}

export async function handleNoticePrint(req: Request, res: Response) {
  try {
    const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
    const appUser = sid ? await getUserFromSession(sid) : null;
    if (!appUser) {
      res.status(401).json({ message: "Please login (10001)" });
      return;
    }
    if (!checkPermission(appUser, "notice", "edit")) {
      res.status(403).json({ message: "ไม่มีสิทธิ์พิมพ์ Notice" });
      return;
    }

    let section: SectionKey;
    try {
      section = normalizeSectionKey(String(req.body?.section ?? ""));
    } catch {
      res.status(400).json({ message: "ต้องระบุ section" });
      return;
    }

    const externalIds: string[] = Array.isArray(req.body?.externalIds)
      ? req.body.externalIds.map((x: unknown) => String(x)).filter(Boolean)
      : [];
    const includeMaxed = Boolean(req.body?.includeMaxed);
    if (externalIds.length === 0) {
      res.status(400).json({ message: "กรุณาเลือกรายการก่อน" });
      return;
    }

    // ดึงที่อยู่เต็มจาก contract detail API (ก่อนอ่านจาก DB)
    await enrichContactAddressesForPrint(section, externalIds);

    // ดึงเฉพาะรายการที่พิมพ์ได้จริง (includeMaxed = รวมที่ส่งครบ 3 ครั้งแล้ว — พิมพ์ซ้ำไม่บันทึกรอบ)
    const records = await getNoticePrintData({ section, externalIds, includeMaxed });
    if (records.length === 0) {
      res.status(400).json({
        message: includeMaxed
          ? "ไม่มีรายการที่สามารถพิมพ์ได้ (อาจได้เครื่องคืนแล้ว หรือไม่เข้าเงื่อนไขค้างชำระ ≥ 60 วัน)"
          : "ไม่มีรายการที่สามารถพิมพ์ได้ (อาจได้เครื่องคืนแล้ว หรือส่งครบ 3 ครั้งแล้ว)",
      });
      return;
    }

    const recordableIds = records
      .filter((r) => r.sentCount < MAX_NOTICE_ROUNDS)
      .map((r) => r.externalId);

    // จัดสรรเลขที่เอกสารก่อนสร้างไฟล์
    const docNos = await allocateDocumentNumbers({
      section,
      items: records.map((r) => ({ externalId: r.externalId, nextRound: r.sentCount + 1 })),
    });
    const printRecords = attachDocumentNumbers(records, docNos);

    // 1) สร้าง DOCX → แปลงเป็น PDF (ถ้ามี LibreOffice)
    const docxBuf = await buildNoticeDocx(printRecords, section);
    const pdfBuf = await convertDocxToPdf(docxBuf);

    // 2) สร้าง Excel จ่าหน้าซอง
    const xlsxBuf = await buildEnvelopeExcel(printRecords);

    // 3) bundle เป็น ZIP
    const stamp = new Date().toISOString().slice(0, 10);
    const zip = new JSZip();
    if (pdfBuf) {
      zip.file(`notice_batch_${stamp}_${records.length}_รายการ.pdf`, pdfBuf);
    } else {
      // fallback: ไม่มี LibreOffice → ส่ง DOCX แทน (เปิดด้วย Word แล้ว Save as PDF ได้)
      zip.file(`notice_batch_${stamp}_${records.length}_รายการ.docx`, docxBuf);
    }
    zip.file(`thai_post_envelope_${stamp}_${records.length}_รายการ.xlsx`, xlsxBuf);
    const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    // 4) สร้างไฟล์ทั้งคู่สำเร็จ → นับรอบ
    const operator = (appUser.fullName?.trim() || appUser.username || "ไม่ทราบชื่อ").slice(0, 128);
    const recorded = await recordNoticePrint({
      section,
      externalIds: recordableIds,
      operator,
      documentNos: docNos,
    });

    const fileName = `notice_${section}_${stamp}_${records.length}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("X-Notice-Printed-Count", String(recorded.printedCount));
    res.setHeader("X-Notice-Generated-Count", String(records.length));
    res.setHeader("X-Notice-Pdf", pdfBuf ? "1" : "0");
    res.status(200).end(zipBuf);
  } catch (err) {
    console.error("[notice/print] failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: (err as Error).message ?? "สร้างเอกสารไม่สำเร็จ" });
    }
  }
}

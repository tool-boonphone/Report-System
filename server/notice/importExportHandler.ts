/**
 * importExportHandler.ts — Import/Export Excel ประวัติ Notice
 */
import type { Request, Response } from "express";
import { APP_SESSION_COOKIE, normalizeSectionKey, type SectionKey } from "../../shared/const";
import { checkPermission, getUserFromSession } from "../authDb";
import {
  importNoticeHistorical,
  listNoticeForExport,
  type NoticeFilters,
  type NoticeSort,
} from "../noticeDb";
import { buildNoticeHistoryExport, parseNoticeImportBuffer } from "./noticeHistoricalExcel";

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

async function requireNoticeUser(req: Request, res: Response, action: "edit" | "export") {
  const sid = parseCookies(req.headers.cookie)[APP_SESSION_COOKIE];
  const appUser = sid ? await getUserFromSession(sid) : null;
  if (!appUser) {
    res.status(401).json({ message: "Please login (10001)" });
    return null;
  }
  const perm = action === "export" ? "export" : "edit";
  if (!checkPermission(appUser, "notice", perm)) {
    res.status(403).json({ message: action === "export" ? "ไม่มีสิทธิ์ Export Notice" : "ไม่มีสิทธิ์ Import Notice" });
    return null;
  }
  return appUser;
}

function parseSection(req: Request, res: Response): SectionKey | null {
  try {
    return normalizeSectionKey(String(req.body?.section ?? req.query.section ?? ""));
  } catch {
    res.status(400).json({ message: "ต้องระบุ section" });
    return null;
  }
}

function parseFilters(raw: unknown): NoticeFilters | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as NoticeFilters;
}

function parseSort(raw: unknown): NoticeSort | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as NoticeSort;
}

/** POST /api/notice/import-preview — ตรวจสอบไฟล์ก่อนนำเข้า */
export async function handleNoticeImportPreview(req: Request, res: Response) {
  try {
    if (!(await requireNoticeUser(req, res, "edit"))) return;
    const section = parseSection(req, res);
    if (!section) return;

    const fileBase64 = String(req.body?.fileBase64 ?? "");
    if (!fileBase64) {
      res.status(400).json({ message: "กรุณาแนบไฟล์ Excel" });
      return;
    }

    const buf = Buffer.from(fileBase64, "base64");
    const parsed = await parseNoticeImportBuffer(buf);
    const preview = await importNoticeHistorical({ section, rows: parsed, dryRun: true });

    res.json(preview);
  } catch (err) {
    console.error("[notice/import-preview] failed:", err);
    res.status(500).json({ message: (err as Error).message ?? "ตรวจสอบไฟล์ไม่สำเร็จ" });
  }
}

/** POST /api/notice/import — นำเข้าประวัติ Notice */
export async function handleNoticeImport(req: Request, res: Response) {
  try {
    if (!(await requireNoticeUser(req, res, "edit"))) return;
    const section = parseSection(req, res);
    if (!section) return;

    const fileBase64 = String(req.body?.fileBase64 ?? "");
    if (!fileBase64) {
      res.status(400).json({ message: "กรุณาแนบไฟล์ Excel" });
      return;
    }

    const buf = Buffer.from(fileBase64, "base64");
    const parsed = await parseNoticeImportBuffer(buf);
    if (parsed.length === 0) {
      res.status(400).json({ message: "ไม่พบข้อมูลนำเข้าในไฟล์ (ตรวจรูปแบบคอลัมน์)" });
      return;
    }

    const result = await importNoticeHistorical({ section, rows: parsed, dryRun: false });
    res.json(result);
  } catch (err) {
    console.error("[notice/import] failed:", err);
    res.status(500).json({ message: (err as Error).message ?? "นำเข้าไม่สำเร็จ" });
  }
}

/** GET /api/notice/export — export รายการที่มีประวัติส่งแล้ว */
export async function handleNoticeExport(req: Request, res: Response) {
  try {
    if (!(await requireNoticeUser(req, res, "export"))) return;
    const section = parseSection(req, res);
    if (!section) return;

    let filters: NoticeFilters | undefined;
    let sort: NoticeSort | undefined;
    try {
      if (req.query.filters) filters = parseFilters(JSON.parse(String(req.query.filters)));
      if (req.query.sort) sort = parseSort(JSON.parse(String(req.query.sort)));
    } catch {
      res.status(400).json({ message: "พารามิเตอร์ filters/sort ไม่ถูกต้อง" });
      return;
    }

    const rows = await listNoticeForExport({ section, filters, sort });
    const xlsx = await buildNoticeHistoryExport(rows, section);
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `notice_history_${section}_${stamp}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.status(200).end(xlsx);
  } catch (err) {
    console.error("[notice/export] failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: (err as Error).message ?? "Export ไม่สำเร็จ" });
    }
  }
}

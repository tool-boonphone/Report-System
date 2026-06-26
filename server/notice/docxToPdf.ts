/**
 * docxToPdf.ts — แปลงไฟล์ DOCX เป็น PDF ฝั่ง server ด้วย LibreOffice headless
 *
 * ถ้าไม่มี LibreOffice (soffice/libreoffice) ติดตั้งบนเครื่อง จะคืน null
 * (ผู้เรียกจะ fallback ส่งไฟล์ DOCX แทน) — Production ควรติดตั้ง LibreOffice
 * + ฟอนต์ไทย (TH Sarabun New) เพื่อให้ได้ PDF ที่หน้าตานิ่งทุกครั้ง
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cachedBin: string | null | undefined;

/** หา binary ของ LibreOffice (cache ผลไว้) */
async function findSoffice(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const candidates = ["soffice", "libreoffice"];
  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const p = spawn(bin, ["--version"], { stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("close", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
    if (ok) {
      cachedBin = bin;
      return bin;
    }
  }
  cachedBin = null;
  return null;
}

export async function isPdfConversionAvailable(): Promise<boolean> {
  return (await findSoffice()) !== null;
}

/**
 * แปลง DOCX (Buffer) → PDF (Buffer). คืน null ถ้าแปลงไม่ได้ (ไม่มี LibreOffice หรือ error)
 */
export async function convertDocxToPdf(docxBuffer: Buffer): Promise<Buffer | null> {
  const bin = await findSoffice();
  if (!bin) return null;

  const dir = await mkdtemp(join(tmpdir(), "notice-pdf-"));
  const inPath = join(dir, "notice.docx");
  const outPath = join(dir, "notice.pdf");
  try {
    await writeFile(inPath, docxBuffer);
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(
        bin,
        [
          "--headless",
          "--nologo",
          "--nofirststartwizard",
          "--convert-to",
          "pdf",
          "--outdir",
          dir,
          inPath,
        ],
        { stdio: "ignore", env: { ...process.env, HOME: dir } },
      );
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      // กันค้าง: timeout 90 วินาที
      setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* noop */ } resolve(false); }, 90_000);
    });
    if (!ok) return null;
    return await readFile(outPath);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * notice-import-historical.mjs — นำเข้าประวัติการส่ง Notice จาก Excel (ครั้งเดียว)
 *
 * โครงสร้างคอลัมน์ตาม docs/import-sample.png:
 *   เลขที่เอกสาร | เลขที่สัญญา | ส่งครั้งที่1 (วันที่/เวลา/โดย) | ส่งครั้งที่2 | ส่งครั้งที่3
 *
 * Usage:
 *   node scripts/notice-import-historical.mjs --section Boonphone --file ./data/notice-history.xlsx
 *   node scripts/notice-import-historical.mjs --section Fastfone365 --file ./data/notice-history.xlsx --dry-run
 */
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
config({ path: path.join(projectRoot, ".env") });

function parseArgs(argv) {
  const out = { section: "Boonphone", file: "", dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--section") out.section = argv[++i];
    else if (argv[i] === "--file") out.file = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
  }
  return out;
}

function cellStr(v) {
  if (v == null) return "";
  if (typeof v === "object" && v.text) return String(v.text).trim();
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function parseDateTime(dateVal, timeVal) {
  const d = cellStr(dateVal);
  const t = cellStr(timeVal);
  if (!d) return null;
  const combined = t ? `${d} ${t}` : d;
  const parsed = new Date(combined);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatDocumentNo(n) {
  if (n <= 9999) return String(n).padStart(4, "0");
  return String(n).padStart(5, "0");
}

function parseDocNo(raw) {
  const s = cellStr(raw);
  if (!s) return null;
  const n = parseInt(s.replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? formatDocumentNo(n) : s;
}

async function ensureSchema(client, section) {
  await client.query(`
    ALTER TABLE notice_print_logs ADD COLUMN IF NOT EXISTS document_no VARCHAR(8)
  `);
  await client.query(`
    ALTER TABLE notice_restore_logs ADD COLUMN IF NOT EXISTS document_no VARCHAR(8)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS notice_document_counters (
      section VARCHAR(32) PRIMARY KEY,
      next_value INTEGER NOT NULL DEFAULT 1
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS notice_contract_doc (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      section VARCHAR(32) NOT NULL,
      contract_external_id VARCHAR(64) NOT NULL,
      document_no VARCHAR(8) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ncd_section_contract_idx
      ON notice_contract_doc (section, contract_external_id)
  `);
  await client.query(
    `INSERT INTO notice_document_counters (section, next_value) VALUES ($1, 1) ON CONFLICT DO NOTHING`,
    [section],
  );
}

async function main() {
  const { section, file, dryRun } = parseArgs(process.argv);
  if (!file) {
    console.error("Usage: node scripts/notice-import-historical.mjs --section Boonphone --file ./path.xlsx [--dry-run]");
    process.exit(1);
  }

  const dbUrl =
    section === "Fastfone365"
      ? process.env.FASTFONE_DATABASE_URL || process.env.FASTFONE365_DATABASE_URL
      : process.env.BOONPHONE_DATABASE_URL || process.env.DATABASE_URL_BOONPHONE || process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error("Database URL not configured for section:", section);
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheet found");

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const contractNo = cellStr(row.getCell(2).value);
    if (!contractNo) return;

    const documentNo = parseDocNo(row.getCell(1).value);
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
        documentNo: documentNo ?? "",
        round: r.round,
        printedAt,
        printedBy: cellStr(r.by) || "import",
      });
    }
  });

  console.log(`Parsed ${rows.length} print log rows from ${file} (${section})`);
  if (rows.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  if (dryRun) {
    console.log("Dry run — first 5 rows:", rows.slice(0, 5));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await ensureSchema(client, section);
    await client.query("BEGIN");

    let imported = 0;
    let skipped = 0;
    let maxDocNum = 0;

    for (const r of rows) {
      const { rows: contracts } = await client.query(
        `SELECT external_id FROM contracts WHERE section = $1 AND contract_no = $2 LIMIT 1`,
        [section, r.contractNo],
      );
      if (contracts.length === 0) {
        skipped++;
        continue;
      }
      const externalId = contracts[0].external_id;

      const { rows: existing } = await client.query(
        `SELECT id FROM notice_print_logs
         WHERE section = $1 AND contract_external_id = $2 AND notice_round = $3`,
        [section, externalId, r.round],
      );
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO notice_print_logs
          (section, contract_external_id, contract_no, notice_round, document_no, printed_by, printed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [section, externalId, r.contractNo, r.round, r.documentNo || null, r.printedBy, r.printedAt],
      );

      if (r.documentNo) {
        const num = parseInt(r.documentNo.replace(/\D/g, ""), 10);
        if (Number.isFinite(num)) maxDocNum = Math.max(maxDocNum, num);

        await client.query(
          `INSERT INTO notice_contract_doc (section, contract_external_id, document_no)
           VALUES ($1, $2, $3)
           ON CONFLICT (section, contract_external_id) DO NOTHING`,
          [section, externalId, r.documentNo],
        );
      }

      imported++;
    }

    if (maxDocNum > 0) {
      await client.query(
        `UPDATE notice_document_counters
         SET next_value = GREATEST(next_value, $2)
         WHERE section = $1`,
        [section, maxDocNum + 1],
      );
    }

    await client.query("COMMIT");
    console.log(`Import done: ${imported} inserted, ${skipped} skipped`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Manual enrich script — เติม updated_by/updated_at ใน installments
 * สำหรับสัญญาที่ยังมี null updated_by
 *
 * Usage: node server/scripts/manualEnrich.mjs [section]
 * Default section: Boonphone
 */

import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// Load .env
let envStr = "";
try {
  envStr = fs.readFileSync(path.join(projectRoot, ".env"), "utf-8");
} catch {}
envStr.split("\n").forEach((line) => {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
});

const section = process.argv[2] ?? "Boonphone";
const API_URL = section === "Boonphone"
  ? process.env.BOONPHONE_API_URL
  : process.env.FASTFONE_API_URL;
const API_USER = section === "Boonphone"
  ? process.env.BOONPHONE_API_USERNAME
  : process.env.FASTFONE_API_USERNAME;
const API_PASS = section === "Boonphone"
  ? process.env.BOONPHONE_API_PASSWORD
  : process.env.FASTFONE_API_PASSWORD;

if (!API_URL || !API_USER || !API_PASS) {
  console.error("❌ Missing API credentials for section:", section);
  process.exit(1);
}

const CONCURRENCY = 5;
const FLUSH_EVERY = 100;

async function fetchContractDetail(contractId) {
  const url = new URL(API_URL);
  url.searchParams.set("action", "detail");
  url.searchParams.set("id", contractId);
  const auth = Buffer.from(`${API_USER}:${API_PASS}`).toString("base64");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  console.log(`\n🔍 [${section}] ค้นหาสัญญาที่ยังไม่มี updated_by...`);

  // หา distinct contract_external_id ที่มี installment ที่ updated_by เป็น null
  const [rows] = await conn.execute(
    `SELECT DISTINCT contract_external_id
     FROM installments
     WHERE section = ?
       AND updated_by IS NULL
     ORDER BY contract_external_id`,
    [section]
  );

  const contractIds = rows.map((r) => r.contract_external_id);
  console.log(`📋 พบ ${contractIds.length} สัญญาที่ต้อง enrich\n`);

  if (contractIds.length === 0) {
    console.log("✅ ทุกสัญญามี updated_by ครบแล้ว");
    await conn.end();
    return;
  }

  let processed = 0;
  let enriched = 0;
  let errors = 0;
  const startTime = Date.now();

  // Buffer สำหรับ batch update
  const updates = [];

  async function flush() {
    if (updates.length === 0) return;
    const batch = updates.splice(0, updates.length);
    for (const row of batch) {
      if (!row.updatedBy && !row.updatedAt) continue;
      await conn.execute(
        `UPDATE installments
         SET updated_by = ?, updated_at = ?, synced_at = CURRENT_TIMESTAMP
         WHERE section = ?
           AND contract_external_id = ?
           AND period = ?`,
        [row.updatedBy, row.updatedAt, section, row.contractExternalId, row.period]
      );
    }
    enriched += batch.length;
  }

  let idx = 0;

  async function worker() {
    while (idx < contractIds.length) {
      const myIdx = idx++;
      const contractId = contractIds[myIdx];
      try {
        const data = await fetchContractDetail(contractId);
        const detailInsts = data?.contract?.installments ?? [];
        for (const inst of detailInsts) {
          const period = inst.no ?? inst.installment_no ?? inst.period;
          const updatedBy = inst.updated_by ? String(inst.updated_by) : null;
          const updatedAt = inst.updated_at ? String(inst.updated_at) : null;
          if (period != null && (updatedBy || updatedAt)) {
            updates.push({
              contractExternalId: contractId,
              period: Number(period),
              updatedBy,
              updatedAt,
            });
          }
        }
        if (updates.length >= FLUSH_EVERY) await flush();
      } catch (err) {
        errors++;
      }
      processed++;

      // แสดง progress ทุก 50 สัญญา
      if (processed % 50 === 0 || processed === contractIds.length) {
        const pct = Math.round((processed / contractIds.length) * 100);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const eta = processed > 0
          ? Math.round((elapsed / processed) * (contractIds.length - processed))
          : "?";
        process.stdout.write(
          `\r⏳ ${processed}/${contractIds.length} (${pct}%) | enriched: ${enriched} | errors: ${errors} | elapsed: ${elapsed}s | ETA: ${eta}s   `
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await flush();

  const totalMs = Date.now() - startTime;
  console.log(`\n\n✅ เสร็จสิ้น! enriched ${enriched} rows จาก ${contractIds.length} สัญญา (${Math.round(totalMs / 1000)}s)`);
  if (errors > 0) console.log(`⚠️  errors: ${errors} สัญญา (ข้ามไป)`);

  // Re-populate debt_collected_cache หลัง enrich เสร็จ
  console.log(`\n🔄 กำลัง re-populate debt_collected_cache...`);
  await conn.execute(`DELETE FROM debt_collected_cache WHERE section = ?`, [section]);
  console.log("✅ ล้าง cache เก่าแล้ว — กรุณากด Refresh ใน TopBar เพื่อโหลดข้อมูลใหม่");

  await conn.end();
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

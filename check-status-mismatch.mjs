/**
 * check-status-mismatch.mjs
 * เปรียบเทียบ debtStatus ระหว่างหน้าเป้าเก็บหนี้ (listDebtTarget) 
 * และยอดเก็บหนี้ (listDebtCollected) สำหรับทั้ง BP และ FF
 *
 * วิธีรัน: node check-status-mismatch.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Load env
import { config } from "dotenv";
config({ path: ".env" });

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

const pool = mysql.createPool(process.env.DATABASE_URL);
const db = drizzle(pool);

/**
 * Compute debtStatus from contract status + installments
 * (mirrors deriveDebtStatus in debtDb.ts)
 */
function bucketFromDays(days) {
  if (days <= 0) return "ปกติ";
  if (days <= 7) return "เกิน 1-7";
  if (days <= 14) return "เกิน 8-14";
  if (days <= 30) return "เกิน 15-30";
  if (days <= 60) return "เกิน 31-60";
  if (days <= 90) return "เกิน 61-90";
  return "เกิน >90";
}

const TERMINAL_STATUSES = new Set(["ระงับสัญญา", "สิ้นสุดสัญญา", "หนี้เสีย"]);

function deriveDebtStatus(contractStatus, installments, today) {
  if (contractStatus && TERMINAL_STATUSES.has(contractStatus)) {
    return contractStatus;
  }
  let maxDays = 0;
  for (const it of installments) {
    if (!it.due_date) continue;
    const dueMs = Date.parse(`${String(it.due_date).slice(0,10)}T00:00:00`);
    if (Number.isNaN(dueMs)) continue;
    const paid = Number(it.paid_amount ?? 0);
    const amt = Number(it.amount ?? 0);
    if (amt <= 0.001) continue;
    if (paid >= amt - 0.001) continue;
    const days = Math.floor((today - dueMs) / 86400000);
    if (days > maxDays) maxDays = days;
  }
  return bucketFromDays(maxDays);
}

async function checkSection(section) {
  console.log(`\n=== ตรวจสอบ section: ${section} ===`);

  // ดึง contracts + status
  const [contractRows] = await pool.execute(
    `SELECT external_id, contract_no, customer_name, status 
     FROM contracts 
     WHERE section = ?`,
    [section]
  );

  // ดึง installments ทั้งหมด
  const [instRows] = await pool.execute(
    `SELECT contract_external_id, due_date, amount, paid_amount
     FROM installments
     WHERE section = ?`,
    [section]
  );

  // Group installments by contract
  const instByContract = new Map();
  for (const r of instRows) {
    const key = String(r.contract_external_id ?? "");
    if (!key) continue;
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key).push(r);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const mismatches = [];

  for (const c of contractRows) {
    const extId = String(c.external_id ?? "");
    const insts = instByContract.get(extId) ?? [];
    const status = deriveDebtStatus(c.status ?? null, insts, today);

    // debtStatus ที่ได้จาก deriveDebtStatus คือ status เดียวกันสำหรับทั้งสองหน้า
    // แต่สิ่งที่อาจต่างกันคือ "สถานะที่แสดงบนหน้า" ซึ่งอาจถูก override โดย
    // isContractSuspended / isContractBadDebt logic ใน listDebtTarget vs listDebtCollected
    // ตรวจสอบว่า contract.status กับ installment status codes ตรงกันหรือไม่

    // ดึง installment status codes
    const instStatuses = insts.map(i => i.installment_status_code ?? i.status ?? null).filter(Boolean);
    const uniqueInstStatuses = [...new Set(instStatuses)];

    // เช็คความไม่สอดคล้อง:
    // 1. contract.status = "ระงับสัญญา" แต่ไม่มี installment ที่มี status ระงับ/ยกเลิก
    // 2. contract.status = "หนี้เสีย" แต่ไม่มี installment ที่มี status ระงับ/ยกเลิก
    // 3. contract.status = "ปกติ" แต่ installments บางตัวมี status ระงับ/ยกเลิก
    const suspendCodes = ["ระงับสัญญา", "ยกเลิกสัญญา"];
    const hasSuspendedInst = instStatuses.some(s => suspendCodes.includes(s));

    let mismatchReason = null;
    if ((c.status === "ระงับสัญญา" || c.status === "หนี้เสีย") && !hasSuspendedInst && insts.length > 0) {
      mismatchReason = `contract.status="${c.status}" แต่ไม่มี installment ที่มี status ระงับ/ยกเลิก (installment statuses: ${uniqueInstStatuses.join(", ") || "none"})`;
    }

    if (mismatchReason) {
      mismatches.push({
        section,
        contractNo: c.contract_no,
        externalId: extId,
        customerName: c.customer_name,
        contractStatus: c.status,
        derivedDebtStatus: status,
        installmentStatuses: uniqueInstStatuses,
        reason: mismatchReason,
      });
    }
  }

  console.log(`  สัญญาทั้งหมด: ${contractRows.length}`);
  console.log(`  พบ mismatch: ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log("\n  รายการ mismatch:");
    for (const m of mismatches.slice(0, 20)) {
      console.log(`  - ${m.contractNo} (${m.customerName}): ${m.reason}`);
    }
    if (mismatches.length > 20) {
      console.log(`  ... และอีก ${mismatches.length - 20} รายการ`);
    }
  }

  return mismatches;
}

/**
 * เปรียบเทียบ debtStatus โดยตรงจาก DB
 * โดยใช้ logic เดียวกับ listDebtTarget และ listDebtCollected
 */
async function compareDebtStatusDirect(section) {
  console.log(`\n=== เปรียบเทียบ debtStatus โดยตรง: ${section} ===`);

  // ดึง contracts
  const [contractRows] = await pool.execute(
    `SELECT c.external_id, c.contract_no, c.customer_name, c.status,
            c.bad_debt_amount, c.bad_debt_date
     FROM contracts c
     WHERE c.section = ?`,
    [section]
  );

  // ดึง installments พร้อม status
  const [instRows] = await pool.execute(
    `SELECT i.contract_external_id, i.due_date, i.amount, i.paid_amount,
            i.status AS inst_status,
            JSON_UNQUOTE(JSON_EXTRACT(i.raw_json, '$.installment_status_code')) AS bp_status_code
     FROM installments i
     WHERE i.section = ?`,
    [section]
  );

  // Group installments by contract
  const instByContract = new Map();
  for (const r of instRows) {
    const key = String(r.contract_external_id ?? "");
    if (!key) continue;
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key).push(r);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // คำนวณ debtStatus สำหรับแต่ละสัญญา
  // ทั้ง listDebtTarget และ listDebtCollected ใช้ deriveDebtStatus เหมือนกัน
  // ดังนั้น debtStatus ควรตรงกัน 100%
  // แต่สิ่งที่อาจต่างกันคือ "suspendedFromPeriod" ซึ่งใช้ installment status codes
  // ถ้า installment ไม่มี status codes → suspendedFromPeriod = 0 → แสดงผลต่างกัน

  const suspendCodes = ["ระงับสัญญา", "ยกเลิกสัญญา"];
  const mismatches = [];

  for (const c of contractRows) {
    const extId = String(c.external_id ?? "");
    const insts = instByContract.get(extId) ?? [];
    const contractStatus = c.status ?? null;

    // คำนวณ debtStatus (เหมือนกันทั้งสองหน้า)
    const debtStatus = deriveDebtStatus(contractStatus, insts, today);

    // ตรวจสอบ suspendedFromPeriod logic
    // listDebtTarget และ listDebtCollected ใช้ logic เดียวกัน
    // แต่ถ้า installment ไม่มี status → suspendedFromPeriod = 0
    // → ทั้งสองหน้าจะแสดง "ระงับสัญญา" ที่งวด 1 แทนที่จะเป็นงวดที่ถูกต้อง

    if (contractStatus === "ระงับสัญญา" || contractStatus === "หนี้เสีย") {
      // หา firstSuspended period
      const sortedInsts = [...insts].sort((a, b) => (a.due_date ?? "") < (b.due_date ?? "") ? -1 : 1);
      const firstSuspended = sortedInsts.find(i => {
        const instStatus = i.inst_status ?? i.bp_status_code ?? null;
        return instStatus && suspendCodes.includes(instStatus);
      });

      // ถ้าไม่มี firstSuspended → suspendedFromPeriod = 0 → fallback ใช้ paidAts
      // ซึ่งอาจทำให้ทั้งสองหน้าแสดงผลต่างกันถ้า paidAts logic ต่างกัน
      if (!firstSuspended && insts.length > 0) {
        // นับ installments ที่มี paid_amount > 0
        const paidInsts = insts.filter(i => Number(i.paid_amount ?? 0) > 0);
        mismatches.push({
          section,
          contractNo: c.contract_no,
          externalId: extId,
          customerName: c.customer_name,
          contractStatus,
          debtStatus,
          totalInstallments: insts.length,
          paidInstallments: paidInsts.length,
          reason: `contract.status="${contractStatus}" แต่ไม่มี installment ที่มี status ระงับ/ยกเลิก → suspendedFromPeriod อาจต่างกันระหว่างสองหน้า`,
        });
      }
    }
  }

  console.log(`  สัญญาทั้งหมด: ${contractRows.length}`);
  console.log(`  พบ potential mismatch: ${mismatches.length}`);

  return mismatches;
}

// Main
const sections = ["Boonphone", "Fastfone365"];
const allMismatches = {};

for (const section of sections) {
  const m1 = await checkSection(section);
  const m2 = await compareDebtStatusDirect(section);
  allMismatches[section] = { installmentStatusMismatch: m1, suspendedFromPeriodMismatch: m2 };
}

console.log("\n\n=== สรุปผล ===");
for (const [section, data] of Object.entries(allMismatches)) {
  console.log(`\n${section}:`);
  console.log(`  - installment status mismatch: ${data.installmentStatusMismatch.length} สัญญา`);
  console.log(`  - suspendedFromPeriod mismatch risk: ${data.suspendedFromPeriodMismatch.length} สัญญา`);
}

await pool.end();

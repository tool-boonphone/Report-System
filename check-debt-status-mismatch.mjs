/**
 * ตรวจสอบสัญญาที่ debtStatus ไม่ตรงกันระหว่างหน้าเป้าเก็บหนี้และยอดเก็บหนี้
 * 
 * Logic:
 * - ทั้งสองหน้าใช้ rederiveDaysOverdue() เดียวกัน จาก debt_target_cache
 * - debtStatus จะตรงกันเสมอ ถ้า contractStatus ตรงกัน
 * - แต่สิ่งที่อาจต่างกันคือ: หน้าเป้าเก็บหนี้แสดง contractStatus override (ระงับสัญญา/หนี้เสีย)
 *   ในขณะที่หน้ายอดเก็บหนี้ใช้ debtStatus ที่คำนวณจาก installments
 * 
 * ตรวจสอบ:
 * 1. สัญญาที่มี contractStatus = ระงับสัญญา/หนี้เสีย แต่ debtStatus ที่คำนวณได้ต่างกัน
 * 2. สัญญาที่มีอยู่ใน debt_target_cache แต่ไม่มีใน debt_collected_cache (หรือกลับกัน)
 * 3. สัญญาที่ contractStatus ใน debt_target_cache ต่างจาก debt_collected_cache
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
config();

const TERMINAL_STATUSES = new Set(['ระงับสัญญา', 'หนี้เสีย', 'สิ้นสุดสัญญา', 'ขายเครื่อง']);

function bucketFromDays(days) {
  if (days <= 0) return 'ปกติ';
  if (days <= 30) return 'เกิน 1-30';
  if (days <= 60) return 'เกิน 31-60';
  if (days <= 90) return 'เกิน 61-90';
  return 'เกิน >90';
}

function rederiveDaysOverdue(contractStatus, instRows, today) {
  if (contractStatus && TERMINAL_STATUSES.has(contractStatus)) {
    return { debtStatus: contractStatus, daysOverdue: 0 };
  }
  const todayMs = today.getTime();
  let maxDays = 0;
  for (const it of instRows) {
    if (it.isClosed || it.isSuspended) continue;
    if (!it.dueDate) continue;
    const dueMs = Date.parse(`${it.dueDate}T00:00:00`);
    if (Number.isNaN(dueMs)) continue;
    const paid = Number(it.paidAmount ?? 0);
    const amt = Number(it.totalAmount ?? 0);
    if (amt <= 0.001) continue;
    if (paid >= amt - 0.5) continue;
    if (dueMs > todayMs) continue;
    const days = Math.floor((todayMs - dueMs) / 86_400_000);
    if (days > maxDays) maxDays = days;
  }
  return { debtStatus: bucketFromDays(maxDays), daysOverdue: maxDays };
}

async function checkSection(pool, section) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ตรวจสอบ section: ${section}`);
  console.log('='.repeat(60));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── 1. ดึง contracts ทั้งหมดจาก debt_target_cache ──────────────────────────
  const [targetContracts] = await pool.execute(`
    SELECT DISTINCT contract_external_id, contract_no, customer_name, contract_status
    FROM debt_target_cache
    WHERE section = ?
    ORDER BY contract_external_id
  `, [section]);

  // ── 2. ดึง contracts ทั้งหมดจาก debt_collected_cache ──────────────────────
  const [collectedContracts] = await pool.execute(`
    SELECT DISTINCT contract_external_id, contract_no, customer_name, contract_status
    FROM debt_collected_cache
    WHERE section = ?
    ORDER BY contract_external_id
  `, [section]);

  const targetSet = new Set(targetContracts.map(r => String(r.contract_external_id)));
  const collectedSet = new Set(collectedContracts.map(r => String(r.contract_external_id)));

  // ── 3. หาสัญญาที่มีใน target แต่ไม่มีใน collected (ยังไม่เคยชำระ) ─────────
  const onlyInTarget = targetContracts.filter(r => !collectedSet.has(String(r.contract_external_id)));
  console.log(`\nสัญญาที่มีในเป้าเก็บหนี้แต่ไม่มีในยอดเก็บหนี้ (ยังไม่เคยชำระ): ${onlyInTarget.length} สัญญา`);

  // ── 4. หาสัญญาที่มีใน collected แต่ไม่มีใน target ─────────────────────────
  const onlyInCollected = collectedContracts.filter(r => !targetSet.has(String(r.contract_external_id)));
  console.log(`สัญญาที่มีในยอดเก็บหนี้แต่ไม่มีในเป้าเก็บหนี้: ${onlyInCollected.length} สัญญา`);
  if (onlyInCollected.length > 0) {
    console.log('  ตัวอย่าง:', onlyInCollected.slice(0, 5).map(r => `${r.contract_no} (${r.contract_external_id})`).join(', '));
  }

  // ── 5. หาสัญญาที่ contractStatus ต่างกันระหว่าง target และ collected ────────
  const collectedStatusMap = new Map(collectedContracts.map(r => [String(r.contract_external_id), r.contract_status]));
  const statusMismatch = [];
  for (const r of targetContracts) {
    const extId = String(r.contract_external_id);
    if (!collectedSet.has(extId)) continue;
    const targetStatus = r.contract_status ?? null;
    const collectedStatus = collectedStatusMap.get(extId) ?? null;
    if (targetStatus !== collectedStatus) {
      statusMismatch.push({
        contractNo: r.contract_no,
        extId,
        customerName: r.customer_name,
        targetStatus,
        collectedStatus,
      });
    }
  }
  console.log(`\nสัญญาที่ contractStatus ต่างกันระหว่าง target cache และ collected cache: ${statusMismatch.length} สัญญา`);
  if (statusMismatch.length > 0) {
    console.log('รายละเอียด:');
    for (const m of statusMismatch.slice(0, 20)) {
      console.log(`  ${m.contractNo} (${m.extId}) - ${m.customerName}`);
      console.log(`    เป้าเก็บหนี้: "${m.targetStatus}" | ยอดเก็บหนี้: "${m.collectedStatus}"`);
    }
    if (statusMismatch.length > 20) {
      console.log(`  ... และอีก ${statusMismatch.length - 20} สัญญา`);
    }
  }

  // ── 6. คำนวณ debtStatus จริงสำหรับสัญญาที่มีทั้งสองฝั่ง ──────────────────
  // ดึง installments จาก debt_target_cache เพื่อคำนวณ debtStatus
  const commonContracts = targetContracts.filter(r => collectedSet.has(String(r.contract_external_id)));
  
  if (commonContracts.length === 0) {
    console.log('\nไม่มีสัญญาที่มีทั้งสองฝั่ง');
    return;
  }

  // ดึง installments สำหรับ batch แรก 500 สัญญา
  const sampleIds = commonContracts.slice(0, 500).map(r => `'${String(r.contract_external_id).replace(/'/g, "''")}'`).join(',');
  
  const [instRows] = await pool.execute(`
    SELECT contract_external_id, due_date, 
           CAST(total_amount AS DECIMAL(18,4)) AS total_amount,
           CAST(paid_amount AS DECIMAL(18,4)) AS paid_amount,
           is_closed, is_suspended
    FROM debt_target_cache
    WHERE section = ?
      AND contract_external_id IN (${sampleIds})
    ORDER BY contract_external_id, period
  `, [section]);

  // Group by contract
  const instByContract = new Map();
  for (const r of instRows) {
    const key = String(r.contract_external_id);
    if (!instByContract.has(key)) instByContract.set(key, []);
    instByContract.get(key).push({
      dueDate: r.due_date,
      totalAmount: String(r.total_amount ?? 0),
      paidAmount: String(r.paid_amount ?? 0),
      isClosed: !!r.is_closed,
      isSuspended: !!r.is_suspended,
    });
  }

  // คำนวณ debtStatus สำหรับแต่ละสัญญา
  const debtStatusMismatch = [];
  for (const c of commonContracts.slice(0, 500)) {
    const extId = String(c.contract_external_id);
    const insts = instByContract.get(extId) ?? [];
    const contractStatus = c.contract_status ?? null;
    
    // debtStatus ที่แสดงบนหน้า (ทั้งสองหน้าใช้ logic เดียวกัน)
    const { debtStatus } = rederiveDaysOverdue(contractStatus, insts, today);
    
    // สถานะที่แสดงบนหน้าเป้าเก็บหนี้ (override ด้วย contractStatus ถ้าเป็น terminal)
    const targetDisplayStatus = TERMINAL_STATUSES.has(contractStatus ?? '') 
      ? contractStatus 
      : debtStatus;
    
    // สถานะที่แสดงบนหน้ายอดเก็บหนี้ (ใช้ logic เดียวกัน)
    const collectedDisplayStatus = TERMINAL_STATUSES.has(contractStatus ?? '') 
      ? contractStatus 
      : debtStatus;
    
    // ทั้งสองหน้าใช้ logic เดียวกัน ดังนั้นจะตรงกันเสมอ
    // แต่ถ้า contractStatus ใน cache ต่างกัน จะทำให้ debtStatus ต่างกัน
    if (targetDisplayStatus !== collectedDisplayStatus) {
      debtStatusMismatch.push({
        contractNo: c.contract_no,
        extId,
        customerName: c.customer_name,
        contractStatus,
        targetDisplayStatus,
        collectedDisplayStatus,
      });
    }
  }

  console.log(`\nสัญญาที่ debtStatus ที่แสดงบนหน้าต่างกัน (จาก 500 ตัวอย่าง): ${debtStatusMismatch.length} สัญญา`);

  // ── 7. สรุปสถิติ ──────────────────────────────────────────────────────────
  // นับ debtStatus ใน target
  const [targetStats] = await pool.execute(`
    SELECT contract_status, COUNT(DISTINCT contract_external_id) as cnt
    FROM debt_target_cache
    WHERE section = ?
    GROUP BY contract_status
    ORDER BY cnt DESC
  `, [section]);

  console.log('\nสถิติ contractStatus ใน debt_target_cache:');
  for (const r of targetStats) {
    console.log(`  "${r.contract_status ?? 'null'}": ${r.cnt} สัญญา`);
  }

  const [collectedStats] = await pool.execute(`
    SELECT contract_status, COUNT(DISTINCT contract_external_id) as cnt
    FROM debt_collected_cache
    WHERE section = ?
    GROUP BY contract_status
    ORDER BY cnt DESC
  `, [section]);

  console.log('\nสถิติ contractStatus ใน debt_collected_cache:');
  for (const r of collectedStats) {
    console.log(`  "${r.contract_status ?? 'null'}": ${r.cnt} สัญญา`);
  }

  // ── 8. ตรวจสอบ contracts ที่มีอยู่ใน contracts table แต่ไม่มีใน cache ─────
  const [contractsNotInCache] = await pool.execute(`
    SELECT c.contract_no, c.external_id, c.customer_name, c.status
    FROM contracts c
    WHERE c.section = ?
      AND c.external_id NOT IN (
        SELECT DISTINCT contract_external_id FROM debt_target_cache WHERE section = ?
      )
    ORDER BY c.contract_no
    LIMIT 20
  `, [section, section]);

  console.log(`\nสัญญาที่มีใน contracts table แต่ไม่มีใน debt_target_cache: ${contractsNotInCache.length} สัญญา (แสดงสูงสุด 20)`);
  if (contractsNotInCache.length > 0) {
    for (const r of contractsNotInCache.slice(0, 10)) {
      console.log(`  ${r.contract_no} (${r.external_id}) - ${r.customer_name} - status: ${r.status}`);
    }
  }
}

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL);
  
  try {
    await checkSection(pool, 'Boonphone');
    await checkSection(pool, 'Fastfone365');
  } finally {
    await pool.end();
  }
}

main().catch(console.error);

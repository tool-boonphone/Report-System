import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// เงื่อนไข 4 patterns:
// 1. TXRTC suffix = 1 (งวดแรก) → งวด 1 ปกติ, งวด 2+ ปิดค่างวด
// 2. TXRTC suffix = N (ระหว่างกลาง, 1 < N < totalPeriods) → งวด N+1 ถึงสุดท้าย ปิดค่างวด
// 3. TXRTC suffix = N ถึง totalPeriods (ตั้งแต่งวด N จนสุดท้าย, N != 1) → งวด N ถึงสุดท้าย ปิดค่างวด
// 4. TXRTC คืองวดสุดท้ายงวดเดียว → แสดงยอดปกติทั้งหมด

for (const section of ['Fastfone365', 'Boonphone']) {
  const [rows] = await conn.execute(`
    SELECT 
      contract_external_id,
      JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) AS receipt_no,
      paid_at
    FROM payment_transactions
    WHERE section = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.receipt_no')) LIKE 'TXRT%'
    ORDER BY contract_external_id, paid_at
  `, [section]);

  if (rows.length === 0) continue;

  // จัดกลุ่มตาม contract
  const byContract = new Map();
  for (const r of rows) {
    const key = r.contract_external_id;
    if (!byContract.has(key)) byContract.set(key, []);
    byContract.get(key).push(r.receipt_no);
  }

  // หาสัญญาที่มี TXRTC
  const withTXRTC = [...byContract.entries()].filter(([k, v]) => v.some(r => r.startsWith('TXRTC')));

  // ดึง installment_count ของแต่ละ contract
  const contractIds = withTXRTC.map(([k]) => k);
  const [contractRows] = await conn.execute(`
    SELECT external_id, installment_count
    FROM contracts
    WHERE external_id IN (${contractIds.map(() => '?').join(',')})
      AND section = ?
  `, [...contractIds, section]);
  const instCountMap = new Map(contractRows.map(r => [String(r.external_id), Number(r.installment_count ?? 0)]));

  // แยก pattern ตามเงื่อนไขใหม่
  const p1 = [], p2 = [], p3 = [], p4 = [];

  for (const [k, receipts] of withTXRTC) {
    const normals = receipts.filter(r => !r.startsWith('TXRTC'));
    const closes = receipts.filter(r => r.startsWith('TXRTC'));
    const totalPeriods = instCountMap.get(k) ?? 0;
    
    // suffix ของ TXRTC (ถ้าไม่มี suffix ให้ถือว่า = maxNormal + 1)
    const normalSuffixes = normals.map(r => { const m = /-(\d+)(?:-\d+)?$/.exec(r); return m ? Number(m[1]) : 0; }).filter(s => s > 0);
    const maxNormal = normalSuffixes.length > 0 ? Math.max(...normalSuffixes) : 0;
    
    // TXRTC suffix: ถ้าไม่มี suffix ให้ถือว่าเป็น maxNormal + 1
    const closeSuffixes = closes.map(r => { const m = /-(\d+)(?:-\d+)?$/.exec(r); return m ? Number(m[1]) : maxNormal + 1; });
    const minCloseSuffix = closeSuffixes.length > 0 ? Math.min(...closeSuffixes) : 0;
    
    // Pattern 1: TXRTC suffix = 1 (งวดแรก)
    if (minCloseSuffix === 1 || (normals.length === 0 && closes.length > 0)) {
      p1.push({ contract: k, receipts, totalPeriods, maxNormal, minCloseSuffix });
    }
    // Pattern 4: TXRTC suffix = totalPeriods (งวดสุดท้ายงวดเดียว)
    else if (totalPeriods > 0 && minCloseSuffix >= totalPeriods) {
      p4.push({ contract: k, receipts, totalPeriods, maxNormal, minCloseSuffix });
    }
    // Pattern 3: TXRTC suffix ตั้งแต่ N ถึงสุดท้าย (N != 1, N < totalPeriods)
    else if (closeSuffixes.length > 1 || (closeSuffixes.length === 1 && minCloseSuffix > 1 && minCloseSuffix < totalPeriods)) {
      // ตรวจว่า TXRTC ครอบคลุมหลายงวดต่อเนื่อง
      const uniqueClose = [...new Set(closeSuffixes)].sort((a,b) => a-b);
      if (uniqueClose.length > 1) {
        p3.push({ contract: k, receipts, totalPeriods, maxNormal, minCloseSuffix, uniqueClose });
      } else {
        p2.push({ contract: k, receipts, totalPeriods, maxNormal, minCloseSuffix });
      }
    }
    // Pattern 2: TXRTC suffix อยู่ระหว่างกลาง
    else {
      p2.push({ contract: k, receipts, totalPeriods, maxNormal, minCloseSuffix });
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Section: ${section} | สัญญาที่มี TXRTC: ${withTXRTC.length}`);
  console.log(`Pattern 1 (TXRTC=งวดแรก): ${p1.length}`);
  console.log(`Pattern 2 (TXRTC=ระหว่างกลาง): ${p2.length}`);
  console.log(`Pattern 3 (TXRTC=หลายงวดต่อเนื่อง): ${p3.length}`);
  console.log(`Pattern 4 (TXRTC=งวดสุดท้ายงวดเดียว): ${p4.length}`);

  // แสดงตัวอย่างพร้อม installments
  const examples = [
    { label: 'Pattern 1 — TXRTC=งวดแรก', items: p1 },
    { label: 'Pattern 2 — TXRTC=ระหว่างกลาง', items: p2 },
    { label: 'Pattern 3 — TXRTC=หลายงวดต่อเนื่อง', items: p3 },
    { label: 'Pattern 4 — TXRTC=งวดสุดท้ายงวดเดียว', items: p4 },
  ];

  for (const { label, items } of examples) {
    if (items.length === 0) continue;
    const ex = items[0];
    const [insts] = await conn.execute(`
      SELECT period, amount, paid_amount, due_date
      FROM installments
      WHERE contract_external_id = ?
      ORDER BY period, due_date
    `, [ex.contract]);

    // deduplicate by period (take first)
    const periodMap = new Map();
    for (const r of insts) {
      const p = Number(r.period);
      if (!periodMap.has(p)) periodMap.set(p, r);
    }
    const uniqueInsts = [...periodMap.values()].sort((a,b) => Number(a.period)-Number(b.period));

    console.log(`\n  [${label}]`);
    console.log(`  สัญญา: ${ex.contract} | totalPeriods: ${ex.totalPeriods} | maxNormal: ${ex.maxNormal} | minCloseSuffix: ${ex.minCloseSuffix}`);
    console.log(`  receipts: ${ex.receipts.join(', ')}`);
    console.log(`  งวด | amount     | paid       | due_date   | แสดงผล`);
    
    for (const r of uniqueInsts) {
      const pNo = Number(r.period);
      const amt = Number(r.amount ?? 0);
      const paid = Number(r.paid_amount ?? 0);
      const due = r.due_date?.toISOString?.()?.slice(0,10) ?? String(r.due_date);
      
      // คำนวณ isClosed ตามเงื่อนไขใหม่
      let display = 'ยอดปกติ';
      const N = ex.minCloseSuffix;
      const total = ex.totalPeriods;
      
      if (N === 1 || ex.maxNormal === 0) {
        // Pattern 1
        display = pNo === 1 ? 'ยอดปกติ' : 'ปิดค่างวด';
      } else if (total > 0 && N >= total) {
        // Pattern 4
        display = 'ยอดปกติ';
      } else {
        // Pattern 2 หรือ 3
        display = pNo > N ? 'ปิดค่างวด' : 'ยอดปกติ';
      }
      
      console.log(`  ${String(pNo).padStart(3)} | ${String(amt).padStart(10)} | ${String(paid).padStart(10)} | ${due} | ${display}`);
    }
  }
}

await conn.end();

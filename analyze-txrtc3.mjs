import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดึงข้อมูลทั้งหมดจากทั้งสอง section
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

  const withTXRTC = [...byContract.entries()].filter(([k, v]) => v.some(r => r.startsWith('TXRTC')));

  // ดึง installment_count
  const contractIds = withTXRTC.map(([k]) => k);
  const [contractRows] = await conn.execute(`
    SELECT external_id, installment_count
    FROM contracts
    WHERE external_id IN (${contractIds.map(() => '?').join(',')})
      AND section = ?
  `, [...contractIds, section]);
  const instCountMap = new Map(contractRows.map(r => [String(r.external_id), Number(r.installment_count ?? 0)]));

  // วิเคราะห์แต่ละสัญญา
  // TXRTC ใน DB มักมีหลายแถวซ้ำ (sync ซ้ำ) → ให้ deduplicate receipt_no ก่อน
  const analyzed = [];
  for (const [k, receipts] of withTXRTC) {
    const uniqueReceipts = [...new Set(receipts)]; // deduplicate
    const normals = uniqueReceipts.filter(r => !r.startsWith('TXRTC'));
    const closes = uniqueReceipts.filter(r => r.startsWith('TXRTC'));
    const totalPeriods = instCountMap.get(k) ?? 0;

    // suffix ของ TXRT ปกติ
    const normalSuffixes = normals.map(r => {
      // pattern: TXRT...-N-M หรือ TXRT...-N
      const m = /-(\d+)(?:-\d+)?$/.exec(r);
      return m ? Number(m[1]) : 0;
    }).filter(s => s > 0);
    const maxNormal = normalSuffixes.length > 0 ? Math.max(...normalSuffixes) : 0;

    // TXRTC suffix: ถ้าไม่มี suffix ให้ถือว่า = maxNormal + 1
    const closeSuffixes = closes.map(r => {
      const m = /-(\d+)(?:-\d+)?$/.exec(r);
      return m ? Number(m[1]) : null;
    });
    const hasNumericSuffix = closeSuffixes.some(s => s !== null);
    const minCloseSuffix = hasNumericSuffix
      ? Math.min(...closeSuffixes.filter(s => s !== null))
      : (maxNormal + 1); // ไม่มี suffix → ปิดหลัง TXRT สุดท้าย

    analyzed.push({ contract: k, receipts: uniqueReceipts, totalPeriods, maxNormal, minCloseSuffix, normals, closes });
  }

  // Pattern 3: TXRTC suffix = N ถึง totalPeriods (N != 1, N < totalPeriods)
  // หมายความว่า TXRTC ปิดตั้งแต่งวด N จนถึงงวดสุดท้าย
  // ในที่นี้ตีความว่า: minCloseSuffix > 1 AND minCloseSuffix < totalPeriods
  const p3 = analyzed.filter(a => a.minCloseSuffix > 1 && a.totalPeriods > 0 && a.minCloseSuffix < a.totalPeriods);

  // Pattern 4: TXRTC คืองวดสุดท้ายงวดเดียว
  // หมายความว่า minCloseSuffix >= totalPeriods (TXRTC ปิดงวดสุดท้าย)
  // และ maxNormal < totalPeriods (ยังมีงวดที่ไม่ได้ชำระ TXRT ปกติ)
  const p4 = analyzed.filter(a => a.totalPeriods > 0 && a.minCloseSuffix >= a.totalPeriods);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Section: ${section}`);
  console.log(`Pattern 3 (TXRTC=ระหว่าง N ถึงสุดท้าย, N>1): ${p3.length}`);
  console.log(`Pattern 4 (TXRTC=งวดสุดท้าย): ${p4.length}`);

  // แสดงตัวอย่าง Pattern 3
  console.log(`\n--- Pattern 3 ตัวอย่าง ---`);
  for (const ex of p3.slice(0, 3)) {
    const [insts] = await conn.execute(`
      SELECT period, amount, paid_amount, due_date
      FROM installments
      WHERE contract_external_id = ?
      ORDER BY period, due_date
    `, [ex.contract]);
    const periodMap = new Map();
    for (const r of insts) {
      const p = Number(r.period);
      if (!periodMap.has(p)) periodMap.set(p, r);
    }
    const uniqueInsts = [...periodMap.values()].sort((a,b) => Number(a.period)-Number(b.period));

    console.log(`\n  สัญญา: ${ex.contract} | totalPeriods: ${ex.totalPeriods} | maxNormal: ${ex.maxNormal} | minCloseSuffix: ${ex.minCloseSuffix}`);
    console.log(`  receipts: ${ex.receipts.join(', ')}`);
    console.log(`  งวด | amount     | paid       | due_date   | แสดงผล`);
    for (const r of uniqueInsts) {
      const pNo = Number(r.period);
      const amt = Number(r.amount ?? 0);
      const paid = Number(r.paid_amount ?? 0);
      const due = r.due_date?.toISOString?.()?.slice(0,10) ?? String(r.due_date);
      // Pattern 3: ปิดค่างวดตั้งแต่งวด minCloseSuffix จนถึงสุดท้าย
      const display = pNo >= ex.minCloseSuffix ? 'ปิดค่างวด' : 'ยอดปกติ';
      console.log(`  ${String(pNo).padStart(3)} | ${String(amt).padStart(10)} | ${String(paid).padStart(10)} | ${due} | ${display}`);
    }
  }

  // แสดงตัวอย่าง Pattern 4
  console.log(`\n--- Pattern 4 ตัวอย่าง ---`);
  for (const ex of p4.slice(0, 3)) {
    const [insts] = await conn.execute(`
      SELECT period, amount, paid_amount, due_date
      FROM installments
      WHERE contract_external_id = ?
      ORDER BY period, due_date
    `, [ex.contract]);
    const periodMap = new Map();
    for (const r of insts) {
      const p = Number(r.period);
      if (!periodMap.has(p)) periodMap.set(p, r);
    }
    const uniqueInsts = [...periodMap.values()].sort((a,b) => Number(a.period)-Number(b.period));

    console.log(`\n  สัญญา: ${ex.contract} | totalPeriods: ${ex.totalPeriods} | maxNormal: ${ex.maxNormal} | minCloseSuffix: ${ex.minCloseSuffix}`);
    console.log(`  receipts: ${ex.receipts.join(', ')}`);
    console.log(`  งวด | amount     | paid       | due_date   | แสดงผล`);
    for (const r of uniqueInsts) {
      const pNo = Number(r.period);
      const amt = Number(r.amount ?? 0);
      const paid = Number(r.paid_amount ?? 0);
      const due = r.due_date?.toISOString?.()?.slice(0,10) ?? String(r.due_date);
      // Pattern 4: แสดงยอดปกติทั้งหมด
      const display = 'ยอดปกติ';
      console.log(`  ${String(pNo).padStart(3)} | ${String(amt).padStart(10)} | ${String(paid).padStart(10)} | ${due} | ${display}`);
    }
  }
}

await conn.end();

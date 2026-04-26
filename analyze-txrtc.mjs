import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ดึงสัญญาที่มี TXRTC พร้อม TXRT ทั้งหมด - ลอง section ทั้งสอง
for (const section of ['Boonphone', 'Fastfone365']) {
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

  console.log(`\n=== Section: ${section} | TXRT rows: ${rows.length} ===`);
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
  console.log(`สัญญาที่มี TXRTC: ${withTXRTC.length} สัญญา`);

  // แยก pattern
  const patternA = [], patternB = [], patternC = [];

  for (const [k, receipts] of withTXRTC) {
    const normals = receipts.filter(r => !r.startsWith('TXRTC'));
    const closes = receipts.filter(r => r.startsWith('TXRTC'));
    
    if (normals.length === 0) {
      patternA.push({ contract: k, receipts });
    } else {
      const closeSuffixes = closes.map(r => { const m = /-(\d+)$/.exec(r); return m ? Number(m[1]) : 0; });
      const normalSuffixes = normals.map(r => { const m = /-(\d+)$/.exec(r); return m ? Number(m[1]) : 0; });
      const maxNormal = Math.max(...normalSuffixes);
      const maxClose = Math.max(...closeSuffixes.filter(s => s > 0));
      
      if (maxClose > 0 && maxClose <= maxNormal) {
        patternB.push({ contract: k, receipts, maxNormal, maxClose });
      } else {
        patternC.push({ contract: k, receipts, maxNormal });
      }
    }
  }

  console.log(`Pattern A (มีแต่ TXRTC): ${patternA.length}`);
  patternA.slice(0, 2).forEach(p => console.log('  ', p.contract, '->', p.receipts.join(', ')));

  console.log(`Pattern B (TXRTC อยู่กลาง): ${patternB.length}`);
  patternB.slice(0, 2).forEach(p => console.log('  ', p.contract, '-> maxNormal='+p.maxNormal, 'maxClose='+p.maxClose, '|', p.receipts.join(', ')));

  console.log(`Pattern C (TXRTC ปิดท้าย): ${patternC.length}`);
  patternC.slice(0, 3).forEach(p => console.log('  ', p.contract, '-> maxNormal='+p.maxNormal, '|', p.receipts.join(', ')));

  // ดึง installments ของตัวอย่าง
  const examples = [
    { label: 'Pattern A', c: patternA[0] },
    { label: 'Pattern B', c: patternB[0] },
    { label: 'Pattern C', c: patternC[0] },
  ].filter(e => e.c);

  for (const { label, c } of examples) {
    const [insts] = await conn.execute(`
      SELECT period, amount, paid_amount, due_date
      FROM installments
      WHERE contract_external_id = ?
      ORDER BY period
    `, [c.contract]);
    console.log(`\n  [${label}] ${c.contract}`);
    console.log('  receipts:', c.receipts.join(', '));
    console.log('  งวด | amount   | paid     | due_date');
    for (const r of insts) {
      const paid = Number(r.paid_amount ?? 0);
      const amt = Number(r.amount ?? 0);
      console.log(`  ${String(r.period).padStart(3)} | ${String(amt).padStart(8)} | ${String(paid).padStart(8)} | ${r.due_date?.toISOString?.()?.slice(0,10) ?? r.due_date}`);
    }
  }
}

await conn.end();
